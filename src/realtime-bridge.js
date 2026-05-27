const WebSocket = require('ws');
const twilio = require('twilio');
const sessions = require('./sessions');
const db = require('./db');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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
  return `Je bent een planning agent van I C O Terminals, een autologistiek bedrijf in de haven van Zeebrugge.
Je belt ${person.name} om te vragen of hij/zij beschikbaar is voor een shift ${shiftSpeech}.

VERPLICHTE GESPREKSFLOW — volg deze stappen altijd in volgorde, sla nooit een stap over:

STAP 1 — VRAAG STELLEN:
Begin ALTIJD met exact: "Goedendag, u spreekt met de planningsagent van I C O Terminals. Bent u beschikbaar voor een shift ${shiftSpeech}?"
Wacht daarna op het antwoord van de persoon. Zeg niets meer.

STAP 2 — ANTWOORD ONTVANGEN:
Wacht tot de persoon duidelijk heeft geantwoord. Als het antwoord onduidelijk is, vraag dan EENmalig om verduidelijking: "Kunt u dat herhalen?"
Ga NOOIT verder naar stap 3 als de persoon nog niet heeft gesproken.

STAP 3 — ANTWOORD BEVESTIGEN EN AFSLUITEN:
Reageer natuurlijk en empathisch op wat de persoon zei. Kort, professioneel, menselijk.
Verwerk in je antwoord:
- Een erkenning van hun antwoord (passend bij de situatie)
- Als er een follow-up vraag of opmerking was: vermeld dat een medewerker contact opneemt
- Een beleefde afsluiting (bv. "Tot dan!", "Bedankt, tot ziens!", "Fijne dag nog!")

Voorbeelden van toon (niet letterlijk overnemen, gebruik als inspiratie):
- Bij ja: warm en bevestigend
- Bij nee: begripvol, geen druk
- Bij onduidelijk: rustig, verwijs naar medewerker

STAP 4 — CLASSIFICEER:
Roep classify_response aan. ALLEEN na stap 3. NOOIT eerder.
Uitzondering: als de verbinding plots wegvalt of de persoon ophangt zonder te spreken, roep onmiddellijk classify_response aan met classification NO_ANSWER.

ABSOLUTE REGELS:
- classify_response NOOIT aanroepen als de persoon nog niet heeft gesproken, tenzij de verbinding wegvalt
- Bij directe hangup of geen spraak: gebruik NO_ANSWER
- Beantwoord NOOIT vragen buiten planning — verwijs door naar een medewerker
- Spreek altijd vloeiend Nederlands, kort en professioneel`;
}

function handleMediaStream(twilioWs) {
  let streamSid = null;
  let callSid = null;
  let openAiWs = null;
  let finalLogged = false;
  let person = null;
  let shiftSpeech = null;
  let usage = { inputAudio: 0, outputAudio: 0, inputText: 0, outputText: 0 };

  function log(msg)  { console.log(`[REALTIME] ${msg}`); }
  function warn(msg) { console.warn(`[REALTIME] ${msg}`); }
  function err(msg)  { console.error(`[REALTIME] ${msg}`); }

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
      log(`OpenAI verbonden voor ${person.name}`);

      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: buildSystemPrompt(person, shiftSpeech),
          voice: 'alloy',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_noise_reduction: { type: 'far_field' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.85,
            prefix_padding_ms: 300,
            silence_duration_ms: 1000,
          },
          tools: [{
            type: 'function',
            name: 'classify_response',
            description: 'Roep aan nadat sluitingszin uitgesproken is met de finale classificatie van het gesprek.',
            parameters: {
              type: 'object',
              properties: {
                classification: { type: 'string', enum: ['YES', 'NO', 'OTHER', 'NO_ANSWER'] },
                followUp: { type: 'boolean' },
                rawResponse: { type: 'string', description: 'Samenvatting van wat de persoon heeft gezegd' },
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

      if (event.type === 'response.audio.delta' && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: event.delta },
        }));
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        log(`${person.name} begint te spreken`);
      }

      if (event.type === 'input_audio_buffer.speech_stopped') {
        log(`${person.name} gestopt met spreken`);
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        log(`${person.name} transcript: "${event.transcript}"`);
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
          log(`${person.name} → ${args.classification} (followUp: ${args.followUp})`);

          db.updateCallBySid(callSid, {
            classification: args.classification,
            followUp: args.followUp,
            rawResponse: args.rawResponse,
            answeredCall: true,
          }).catch(e => err(`DB update mislukt voor ${callSid}: ${e.message}`));

          if (streamSid) {
            twilioWs.send(JSON.stringify({
              event: 'mark',
              streamSid,
              mark: { name: 'hangup' },
            }));
            log(`Mark 'hangup' verstuurd voor ${person.name}`);
          }
        } catch (e) {
          err(`classify_response parse error voor ${person.name}: ${e.message}`);
        }
      }

      if (event.type === 'response.done') {
        const u = event.response?.usage;
        if (u) {
          usage.inputAudio  += u.input_token_details?.audio_tokens  ?? 0;
          usage.outputAudio += u.output_token_details?.audio_tokens ?? 0;
          usage.inputText   += u.input_token_details?.text_tokens   ?? 0;
          usage.outputText  += u.output_token_details?.text_tokens  ?? 0;
        }
        log(`Response voltooid voor ${person.name} (totaal: in_audio=${usage.inputAudio} out_audio=${usage.outputAudio} in_text=${usage.inputText} out_text=${usage.outputText})`);
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
      if (!finalLogged && callSid) {
        finalLogged = true;
        db.updateCallBySid(callSid, {
          classification: 'NO_ANSWER',
          followUp: false,
          rawResponse: null,
          answeredCall: false,
        }).catch(e => err(`DB NO_ANSWER fallback mislukt voor ${callSid}: ${e.message}`));
      }
      if (callSid) {
        db.createCallUsage(callSid, {
          inputAudioTokens: usage.inputAudio,
          outputAudioTokens: usage.outputAudio,
          inputTextTokens: usage.inputText,
          outputTextTokens: usage.outputText,
        }).catch(e => err(`DB usage insert mislukt voor ${callSid}: ${e.message}`));
      }
      openAiWs?.close();
    }
  });

  twilioWs.on('close', () => {
    log(`Twilio WS gesloten voor ${person?.name}`);
    openAiWs?.close();
  });
  twilioWs.on('error', (e) => {
    err(`Twilio WS fout voor ${person?.name}: ${e.message}`);
    openAiWs?.close();
  });
}

module.exports = { handleMediaStream };
