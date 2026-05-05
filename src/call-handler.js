const OpenAI = require('openai');
const twilio = require('twilio');
const { VoiceResponse } = twilio.twiml;
const sessions = require('./sessions');
const { synthesize } = require('./tts');
const { logResponse } = require('./logger');
const { markCallDone } = require('./run-state');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FINAL_CLASSIFICATIONS = ['YES', 'NO', 'OTHER'];

function hourToNL(h) {
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  if (h >= 0 && h < 6)  return `${h12} uur 's nachts`;
  if (h < 12)            return `${h12} uur 's morgens`;
  if (h === 12)          return `12 uur 's middags`;
  if (h < 18)            return `${h12} uur 's middags`;
  return `${h12} uur 's avonds`;
}

function shiftToSpeech(tijdslot) {
  const match = tijdslot.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  if (!match) return tijdslot;
  return `van ${hourToNL(parseInt(match[1]))} tot ${hourToNL(parseInt(match[3]))}`;
}

function buildSystemPrompt(person) {
  const shiftSpeech = shiftToSpeech(person.tijdslot);
  return `Je bent een planning agent van ICO Terminals, een autologistiek bedrijf in de haven van Zeebrugge.
Je belt ${person.naam} om te vragen of hij/zij beschikbaar is voor een shift.

Shift: ${shiftSpeech}

Regels:
- Stel jezelf voor als de planning agent van ICO Terminals
- Vraag of ${person.naam} beschikbaar is voor de shift ${shiftSpeech}
- Spreek altijd vloeiend Nederlands, nooit cijfers of codes voorlezen
- Reageer ENKEL op planningsgerelateerde vragen. Weiger beleefd maar duidelijk bij alle andere vragen.
- Hou antwoorden kort en professioneel

Classificeer het antwoord van de medewerker:
- YES: bevestigt beschikbaarheid
- NO: weigert of niet beschikbaar
- OTHER: vraag, opmerking, of onduidelijk → menselijke opvolging nodig
- ONGOING: gesprek nog niet afgerond (vraag om herhaling, tussenvraag, wacht op antwoord)

Antwoord ALTIJD als JSON: { "response": "tekst om uit te spreken", "classification": "YES|NO|OTHER|ONGOING" }`;
}

async function handleCallStart(req, res) {
  const callSid = req.body.CallSid;
  const personId = req.query.personId;

  const person = sessions.get(`person-${personId}`);
  if (!person) {
    const twiml = new VoiceResponse();
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }
  sessions.delete(`person-${personId}`);

  const messages = [
    { role: 'system', content: buildSystemPrompt(person) },
    { role: 'user', content: 'START_CALL' },
  ];

  const { agentText, classification, updatedMessages } = await callAgent(messages);

  sessions.set(callSid, { person, history: updatedMessages });

  return respondWithTwiml(res, agentText, classification, callSid);
}

async function handleGather(req, res) {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const session = sessions.get(callSid);

  if (!session) {
    const twiml = new VoiceResponse();
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const { person, history } = session;

  if (!speechResult.trim()) {
    const agentText = 'Sorry, ik heb u niet verstaan. Bent u beschikbaar voor de shift?';
    return respondWithTwiml(res, agentText, 'ONGOING', callSid);
  }

  const messages = [...history, { role: 'user', content: speechResult }];
  const { agentText, classification, updatedMessages } = await callAgent(messages);

  sessions.update(callSid, { history: updatedMessages });

  if (FINAL_CLASSIFICATIONS.includes(classification)) {
    logResponse({
      personId: person.id,
      naam: person.naam,
      tijdslot: person.tijdslot,
      callSid,
      classification,
      rawResponse: speechResult,
      answeredCall: true,
    });
    sessions.update(callSid, { finalLogged: true });
  }

  return respondWithTwiml(res, agentText, classification, callSid);
}

async function handleStatus(req, res) {
  const { CallSid, CallStatus } = req.body;
  const TERMINAL = ['no-answer', 'busy', 'failed', 'completed'];

  if (!TERMINAL.includes(CallStatus)) return res.sendStatus(204);

  const session = sessions.get(CallSid);
  if (!session) return res.sendStatus(204);

  if (!session.finalLogged) {
    const { person } = session;
    logResponse({
      personId: person.id,
      naam: person.naam,
      tijdslot: person.tijdslot,
      callSid: CallSid,
      classification: 'NO_ANSWER',
      rawResponse: null,
      answeredCall: false,
    });
    sessions.update(CallSid, { finalLogged: true });
    markCallDone();
  } else if (CallStatus === 'completed') {
    markCallDone();
  }

  if (CallStatus === 'completed') sessions.delete(CallSid);

  res.sendStatus(204);
}

async function callAgent(messages) {
  let agentText;
  let classification;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    agentText = parsed.response;
    classification = parsed.classification;
  } catch (err) {
    console.error('OpenAI error:', err.message);
    agentText = 'Er is een technisch probleem. Iemand van ICO Terminals neemt contact met u op.';
    classification = 'OTHER';
  }

  const updatedMessages = [
    ...messages,
    { role: 'assistant', content: JSON.stringify({ response: agentText, classification }) },
  ];

  return { agentText, classification, updatedMessages };
}

async function respondWithTwiml(res, agentText, classification, callSid) {
  const twiml = new VoiceResponse();
  const isFinal = FINAL_CLASSIFICATIONS.includes(classification);

  let audioFilename;
  try {
    audioFilename = await synthesize(agentText);
  } catch (err) {
    console.error('TTS error, falling back to Twilio <Say>:', err.message);
    if (isFinal) {
      twiml.say({ language: 'nl-NL' }, agentText);
      twiml.hangup();
    } else {
      const gather = twiml.gather({
        input: 'speech',
        action: '/voice/gather',
        speechTimeout: 'auto',
        language: 'nl-NL',
      });
      gather.say({ language: 'nl-NL' }, agentText);
    }
    return res.type('text/xml').send(twiml.toString());
  }

  const audioUrl = `${process.env.BASE_URL}/audio/${audioFilename}`;

  if (isFinal) {
    twiml.play(audioUrl);
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice/gather',
      speechTimeout: 'auto',
      language: 'nl-NL',
    });
    gather.play(audioUrl);
  }

  return res.type('text/xml').send(twiml.toString());
}

module.exports = { handleCallStart, handleGather, handleStatus };
