const OpenAI = require('openai');
const twilio = require('twilio');
const { VoiceResponse } = twilio.twiml;
const sessions = require('./sessions');
const { synthesize } = require('./tts');

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

function buildOpeningText(person) {
  return `Goedendag, u spreekt met de planningsagent van ICO Terminals. Bent u beschikbaar voor een shift ${shiftToSpeech(person.tijdslot)}?`;
}

function buildSystemPrompt(person) {
  const shiftSpeech = shiftToSpeech(person.tijdslot);
  return `Je bent een planning agent van ICO Terminals, een autologistiek bedrijf in de haven van Zeebrugge.
Je belt ${person.naam} om te vragen of hij/zij beschikbaar is voor een shift ${shiftSpeech}.

KERNREGELS:
- Spreek altijd vloeiend Nederlands, nooit cijfers of codes voorlezen
- Hou antwoorden kort en professioneel
- Beantwoord NOOIT vragen buiten planning — verwijs altijd door naar een medewerker
- Probeer NOOIT een follow-up vraag zelf te beantwoorden — dat is niet jouw taak

CLASSIFICATIE:
- YES: persoon bevestigt beschikbaarheid
- NO: persoon weigert of is niet beschikbaar
- OTHER: onduidelijk antwoord, of persoon stelt enkel een vraag zonder te bevestigen of weigeren
- ONGOING: gesprek nog niet afgerond (wacht op antwoord, vraag om herhaling)

OPVOLGING (followUp):
- followUp: true → persoon heeft een bijkomende vraag, conditie of opmerking bovenop hun YES/NO (bv. "Ja, maar kunt u me terugbellen over het tijdstip?", "Nee, maar misschien volgende week")
- followUp: false → antwoord is volledig afgerond, geen verdere actie nodig
- Bij OTHER of ONGOING: followUp altijd true

SLUITINGSZINNEN — gebruik EXACT deze zinnen als afsluiting bij een finale classificatie:
- YES + followUp false: "Uitstekend, je bevestiging is geregistreerd. Tot dan!"
- YES + followUp true: "Uitstekend, je bevestiging is geregistreerd. Voor je verdere vraag of opmerking zal een medewerker contact met je opnemen. Tot dan!"
- NO + followUp false: "Begrepen, bedankt voor je antwoord. Tot dan!"
- NO + followUp true: "Begrepen, bedankt voor je antwoord. Een medewerker zal contact met je opnemen. Tot dan!"
- OTHER: "Begrepen, een medewerker zal contact met je opnemen. Tot dan!"

Antwoord ALTIJD als JSON: { "response": "tekst om uit te spreken", "classification": "YES|NO|OTHER|ONGOING", "followUp": true|false }`;
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

  const callSession = sessions.get(callSid);
  const openingText = buildOpeningText(person);
  const history = [
    { role: 'system', content: buildSystemPrompt(person) },
    { role: 'user', content: 'START_CALL' },
    { role: 'assistant', content: JSON.stringify({ response: openingText, classification: 'ONGOING', followUp: false }) },
  ];

  sessions.set(callSid, { ...callSession, person, history });

  if (callSession?.openingAudio) {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({ input: 'speech', action: '/voice/gather', speechTimeout: 'auto', language: 'nl-NL' });
    gather.play(`${process.env.BASE_URL}/audio/${callSession.openingAudio}`);
    return res.type('text/xml').send(twiml.toString());
  }

  return respondWithTwiml(res, openingText, 'ONGOING', callSid);
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
  const { agentText, classification, followUp, updatedMessages } = await callAgent(messages);

  sessions.update(callSid, { history: updatedMessages });

  if (FINAL_CLASSIFICATIONS.includes(classification)) {
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
    sessions.update(CallSid, { finalLogged: true });
  }

  if (CallStatus === 'completed') sessions.delete(CallSid);

  res.sendStatus(204);
}

async function callAgent(messages) {
  let agentText;
  let classification;

  let followUp = false;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    agentText = parsed.response;
    classification = parsed.classification;
    followUp = parsed.followUp === true;
  } catch (err) {
    console.error('OpenAI error:', err.message);
    agentText = 'Er is een technisch probleem. Iemand van ICO Terminals neemt contact met u op.';
    classification = 'OTHER';
    followUp = true;
  }

  const updatedMessages = [
    ...messages,
    { role: 'assistant', content: JSON.stringify({ response: agentText, classification, followUp }) },
  ];

  return { agentText, classification, followUp, updatedMessages };
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

module.exports = { handleCallStart, handleGather, handleStatus, buildOpeningText };
