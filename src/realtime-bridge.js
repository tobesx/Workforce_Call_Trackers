const WebSocket = require('ws');
const twilio = require('twilio');
const sessions = require('./sessions');
const db = require('./db');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Stemmen die de OpenAI Realtime API aanbiedt. Frontend kiest er één per run;
// ongeldige/ontbrekende waarde valt terug op DEFAULT_VOICE (voorkomt een
// OpenAI error-event dat de call stil zou slopen).
const VALID_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const DEFAULT_VOICE = 'alloy';

// Vangnet: als de sluitingszin nooit komt, toch ophangen.
const CLOSING_TIMEOUT_MS = 8000;

// Twilio's AMD las een korte voicemailbegroeting als 'human'. Het transcript
// van het eerste fragment is betrouwbaarder en is al na ~5 s binnen.
// Bewust alleen zinnen die een werknemer nooit zou zeggen als antwoord op
// "bent u beschikbaar" — "ik ben niet beschikbaar" mag geen voicemail heten.
const VOICEMAIL_PATTERNS = [
  /voicemail/i,
  /antwoordapparaat/i,
  /laat (?:een|uw) (?:bericht|boodschap)/i,
  /na de (?:toon|piep|biep)/i,
  /probeert te bereiken/i,
  /spreek (?:uw|een) (?:bericht|boodschap)/i,
  /is niet beschikbaar op dit moment/i,
  /leave a message/i,
  /messagerie|r[ée]pondeur|laissez un message/i,
];

// Na dit venster loopt er een echt gesprek en zou een match een vals alarm zijn.
const VOICEMAIL_WINDOW_MS = 20000;

function isVoicemail(transcript, elapsedMs) {
  if (!transcript || elapsedMs > VOICEMAIL_WINDOW_MS) return false;
  return VOICEMAIL_PATTERNS.some(re => re.test(transcript));
}

function resolveVoice(v) {
  return VALID_VOICES.includes(v) ? v : DEFAULT_VOICE;
}

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

function buildSystemPrompt(person, shiftSpeech) {
  return `Je bent een planning agent van Sixth Generation.
Je belt ${person.name} om te vragen of hij/zij beschikbaar is voor een shift ${shiftSpeech}.

VERPLICHTE GESPREKSFLOW — volg deze stappen altijd in volgorde, sla nooit een stap over:

STAP 1 — VRAAG STELLEN:
Begin ALTIJD met exact: "Goedendag, u spreekt met de planningsagent van Sixth Generation. Bent u beschikbaar voor een shift ${shiftSpeech}?"
Wacht daarna op het antwoord van de persoon. Zeg niets meer.

STAP 2 — ANTWOORD ONTVANGEN:
Wacht tot de persoon duidelijk heeft geantwoord. Laat hem/haar uitspreken; onderbreek nooit.
Heb je geen verstaanbaar antwoord gehoord — stilte, ruis, een half woord — vraag dan EENmalig: "Sorry, ik heb u niet goed verstaan. Kunt u dat herhalen?" en wacht opnieuw.
Ga NOOIT verder naar stap 3 als de persoon nog niet heeft gesproken.

STAP 3 — CLASSIFICEER:
Roep classify_response aan zodra de persoon duidelijk geantwoord heeft.
Spreek op dat moment zelf NIETS uit — geen bevestiging, geen afsluiting. De afsluiting wordt je daarna apart gevraagd.
Uitzondering: als de verbinding wegvalt of de persoon hangt op zonder te spreken, roep classify_response aan met classification NO_ANSWER.

ABSOLUTE REGELS:
- classify_response NOOIT aanroepen als de persoon nog niet heeft gesproken, tenzij de verbinding wegvalt
- rawResponse is een LETTERLIJK citaat. Verzin nooit een antwoord en vul nooit aan wat je niet gehoord hebt.
- Twijfel je of je iets gehoord hebt? Dan heb je het niet gehoord. Vraag om herhaling in plaats van te classificeren.
- Hoor je een voicemail of antwoordapparaat ("laat een bericht na de toon", "is niet beschikbaar", een piep)? Roep ONMIDDELLIJK classify_response aan met NO_ANSWER. Wacht de boodschap niet af en spreek niets in.
- Bij directe hangup of geen spraak: gebruik NO_ANSWER
- Beantwoord NOOIT vragen buiten planning — verwijs door naar een medewerker
- Spreek altijd vloeiend Nederlands, kort en professioneel`;
}

// De sluitingszin wordt bewust in een losse response gevraagd. Een response die
// een function call bevat, bevat geen audio — daardoor werd er niets
// uitgesproken voor we ophingen.
function buildClosingInstructions(args) {
  const perOutcome = {
    YES: 'Bedank voor de bevestiging en laat weten dat het genoteerd is. Warm.',
    NO: 'Bedank voor het antwoord en laat weten dat het genoteerd is. Begripvol, geen druk.',
    OTHER: 'Bedank voor het antwoord en laat weten dat het genoteerd is. Rustig.',
  };

  const needsHandover = args.followUp || args.classification === 'OTHER';

  return `De uitkomst van dit gesprek is al vastgelegd als ${args.classification}.
Spreek NU alleen nog de afsluiting uit. Roep geen enkele tool meer aan.

${perOutcome[args.classification] || perOutcome.OTHER}
${needsHandover ? 'Zeg erbij dat een medewerker hierover contact opneemt.' : ''}
Sluit beleefd af (bv. "Fijne dag nog!", "Bedankt, tot ziens!").

STRIKT:
- Noem de naam van de persoon NIET.
- Herhaal de shift of het tijdslot NIET.
- Maximaal 2 korte zinnen.
- Vloeiend Nederlands, professioneel en menselijk.`;
}

function handleMediaStream(twilioWs) {
  let streamSid = null;
  let callSid = null;
  let openAiWs = null;
  let finalLogged = false;
  let person = null;
  let shiftSpeech = null;
  let closingRequested = false;
  let hangupSent = false;
  let hangupTimer = null;
  let fnCallResponseId = null;
  let speechStartedAt = null;
  let streamStartedAt = null;
  let lastTranscript = null;
  function log(msg)  { console.log(`[REALTIME] ${msg}`); }
  function warn(msg) { console.warn(`[REALTIME] ${msg}`); }
  function err(msg)  { console.error(`[REALTIME] ${msg}`); }

  // Twilio echoot een mark pas terug als alle eerder verstuurde audio is
  // afgespeeld. Die echo is het signaal om echt op te hangen.
  function sendHangup(reason) {
    if (hangupSent || !streamSid) return;
    hangupSent = true;
    clearTimeout(hangupTimer);
    twilioWs.send(JSON.stringify({
      event: 'mark',
      streamSid,
      mark: { name: 'hangup' },
    }));
    log(`Mark 'hangup' verstuurd voor ${person?.name} (${reason})`);
  }

  function connectToOpenAI() {
    log(`OpenAI verbinden voor ${person.name}...`);

    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-2',
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    openAiWs.on('open', () => {
      const voice = resolveVoice(person.voice);
      log(`OpenAI verbonden voor ${person.name} (stem: ${voice})`);

      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: buildSystemPrompt(person, shiftSpeech),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              // Zonder transcription blijft input_audio_transcription.completed
              // stil en is niet na te gaan wat OpenAI werkelijk gehoord heeft.
              // language is vastgezet omdat Whisper anders op Duits gokte bij
              // een Nederlands antwoord ("Ja, das passt perfekt für mich").
              transcription: { model: 'whisper-1', language: 'nl' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.85,
                prefix_padding_ms: 300,
                // 1000 ms knipte mensen af die midden in hun zin adem halen.
                silence_duration_ms: 1500,
              },
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice,
            },
          },
          tools: [{
            type: 'function',
            name: 'classify_response',
            description: 'Roep aan zodra de persoon duidelijk geantwoord heeft, met de finale classificatie. Spreek zelf geen afsluiting uit — die wordt daarna apart gevraagd.',
            parameters: {
              type: 'object',
              properties: {
                classification: { type: 'string', enum: ['YES', 'NO', 'OTHER', 'NO_ANSWER'] },
                followUp: { type: 'boolean' },
                rawResponse: { type: 'string', description: 'Letterlijk citaat van wat de persoon zei. Nooit parafraseren, nooit invullen wat je niet gehoord hebt.' },
              },
              required: ['classification', 'followUp', 'rawResponse'],
            },
          }],
          tool_choice: 'auto',
        },
      }));

      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'START_CALL' }],
        },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      log(`Opening getriggerd voor ${person.name}`);
    });

    openAiWs.on('message', (data) => {
      const event = JSON.parse(data.toString());

      if (event.type === 'response.output_audio.delta' && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: event.delta },
        }));
      }

      // Alleen de losse sluitingsresponse telt; de function-call-response
      // heeft geen audio en een ander response_id.
      if (event.type === 'response.output_audio.done'
          && closingRequested
          && event.response_id !== fnCallResponseId) {
        log(`Sluitingszin afgespeeld voor ${person.name}`);
        sendHangup('sluitingszin afgerond');
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        speechStartedAt = Date.now();
        log(`${person.name} begint te spreken`);
      }

      if (event.type === 'input_audio_buffer.speech_stopped') {
        const ms = speechStartedAt ? Date.now() - speechStartedAt : 0;
        log(`${person.name} gestopt met spreken (${ms} ms)`);
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        lastTranscript = event.transcript;
        log(`${person.name} transcript: "${event.transcript}"`);

        // Het model kan hier niet ingrijpen: het komt pas aan zet als de VAD de
        // beurt afsluit, en een voicemail praat gewoon door.
        if (!finalLogged && isVoicemail(event.transcript, Date.now() - streamStartedAt)) {
          finalLogged = true;
          warn(`${person.name}: voicemail herkend in transcript → NO_ANSWER`);
          sessions.set(callSid, { person, history: [], finalLogged: true });

          db.updateCallBySid(callSid, {
            classification: 'NO_ANSWER',
            followUp: false,
            rawResponse: event.transcript,
            answeredCall: false,
          }).catch(e => err(`DB update mislukt voor ${callSid}: ${e.message}`));

          sendHangup('voicemail herkend');
          return;
        }
      }

      if (event.type === 'conversation.item.input_audio_transcription.failed') {
        warn(`${person.name} transcriptie mislukt: ${JSON.stringify(event.error)}`);
      }

      if (event.type === 'response.function_call_arguments.done' && event.name === 'classify_response') {
        log(`classify_response ontvangen voor ${person.name}: ${event.arguments}`);

        if (finalLogged) {
          warn(`${person.name}: classify_response al eerder verwerkt, genegeerd`);
          return;
        }

        finalLogged = true;
        try {
          const args = JSON.parse(event.arguments);
          sessions.set(callSid, { person, history: [], finalLogged: true });
          log(`${person.name} → ${args.classification} (followUp: ${args.followUp}) | gehoord transcript: ${lastTranscript === null ? '(nog geen)' : `"${lastTranscript}"`}`);

          db.updateCallBySid(callSid, {
            classification: args.classification,
            followUp: args.followUp,
            rawResponse: args.rawResponse,
            answeredCall: true,
          }).catch(e => err(`DB update mislukt voor ${callSid}: ${e.message}`));

          if (args.classification === 'NO_ANSWER') {
            sendHangup('NO_ANSWER, geen afsluiting nodig');
            return;
          }

          closingRequested = true;
          fnCallResponseId = event.response_id;

          openAiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              output_modalities: ['audio'],
              tool_choice: 'none',
              instructions: buildClosingInstructions(args),
            },
          }));
          log(`Sluitingszin aangevraagd voor ${person.name}`);

          hangupTimer = setTimeout(
            () => sendHangup('timeout, sluitingszin bleef uit'),
            CLOSING_TIMEOUT_MS
          );
        } catch (e) {
          err(`classify_response parse error voor ${person.name}: ${e.message}`);
        }
      }

      if (event.type === 'error') {
        err(`OpenAI fout voor ${person.name}: ${JSON.stringify(event.error)}`);
      }
    });

    openAiWs.on('error', (e) => err(`OpenAI WS fout voor ${person?.name}: ${e.message}`));
    openAiWs.on('close', (code) => log(`OpenAI verbinding gesloten voor ${person?.name} (code: ${code})`));
  }

  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      const personId = msg.start.customParameters?.personId;

      log(`Stream start ontvangen — callSid: ${callSid}, personId: ${personId}`);

      const existingSession = sessions.get(callSid);
      if (!existingSession) {
        err(`Geen sessie gevonden voor callSid ${callSid}`);
        twilioWs.close();
        return;
      }

      person = sessions.get(`person-${personId}`);
      if (!person) {
        err(`Geen persoon gevonden voor personId ${personId}`);
        twilioWs.close();
        return;
      }
      sessions.delete(`person-${personId}`);
      shiftSpeech = shiftToSpeech(person.time_slot);

      sessions.set(callSid, { person, history: [], finalLogged: false });
      streamStartedAt = Date.now();
      log(`Stream gestart: ${callSid} → ${person.name}`);
      connectToOpenAI();
    }

    if (msg.event === 'mark') {
      log(`Mark ontvangen van Twilio: ${msg.mark?.name}`);
      if (msg.mark?.name === 'hangup') {
        log(`Ophangen voor ${person?.name}...`);
        twilioClient.calls(callSid).update({ status: 'completed' })
          .then(() => log(`Call beëindigd: ${callSid}`))
          .catch((e) => err(`Hangup mislukt voor ${callSid}: ${e.message}`));
      }
    }

    if (msg.event === 'media' && openAiWs?.readyState === WebSocket.OPEN) {
      openAiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: msg.media.payload,
      }));
    }

    if (msg.event === 'stop') {
      log(`Stream gestopt voor ${person?.name}`);
      clearTimeout(hangupTimer);
      // AMD of de statuswebhook kan al geclassificeerd hebben; die uitkomst
      // niet overschrijven met een lege NO_ANSWER.
      const session = callSid ? sessions.get(callSid) : null;
      if (!finalLogged && !session?.finalLogged && callSid) {
        finalLogged = true;
        db.updateCallBySid(callSid, {
          classification: 'NO_ANSWER',
          followUp: false,
          rawResponse: null,
          answeredCall: false,
        }).catch(e => err(`DB NO_ANSWER fallback mislukt voor ${callSid}: ${e.message}`));
      }
      openAiWs?.close();
    }
  });

  twilioWs.on('close', () => {
    log(`Twilio WS gesloten voor ${person?.name}`);
    clearTimeout(hangupTimer);
    openAiWs?.close();
  });
  twilioWs.on('error', (e) => {
    err(`Twilio WS fout voor ${person?.name}: ${e.message}`);
    openAiWs?.close();
  });
}

module.exports = { handleMediaStream, resolveVoice, VALID_VOICES };
