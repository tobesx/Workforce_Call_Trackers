const WebSocket = require('ws');
const twilio = require('twilio');
const sessions = require('./sessions');
const { logResponse } = require('./logger');
const { markCallDone, getToken } = require('./run-state');

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
Je belt ${person.naam} om te vragen of hij/zij beschikbaar is voor een shift ${shiftSpeech}.

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

STAP 5 — CLASSIFICEER:
Roep classify_response aan. ALLEEN na stap 4. NOOIT eerder.

ABSOLUTE REGELS:
- classify_response NOOIT aanroepen als de persoon nog niet heeft gesproken
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

  function connectToOpenAI() {
    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5',
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    openAiWs.on('open', () => {
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: buildSystemPrompt(person, shiftSpeech),
          voice: 'alloy',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.7,
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
                classification: { type: 'string', enum: ['YES', 'NO', 'OTHER'] },
                followUp: { type: 'boolean' },
                rawResponse: { type: 'string', description: 'Samenvatting van wat de persoon heeft gezegd' },
              },
              required: ['classification', 'followUp', 'rawResponse'],
            },
          }],
          tool_choice: 'auto',
        },
      }));

      // Trigger opening
      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'START_CALL' }],
        },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
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

      if (event.type === 'response.function_call_arguments.done' && event.name === 'classify_response' && !finalLogged) {
        finalLogged = true;
        try {
          const args = JSON.parse(event.arguments);
          const callSession = sessions.get(callSid);
          if (callSession?.sessionToken !== getToken()) {
            console.log(`[REALTIME] Stale call genegeerd: ${callSid}`);
            return;
          }
          if (callSid) sessions.set(callSid, { person, history: [], finalLogged: true });
          logResponse({
            personId: person.id,
            naam: person.naam,
            tijdslot: person.tijdslot,
            callSid,
            classification: args.classification,
            followUp: args.followUp,
            rawResponse: args.rawResponse,
            answeredCall: true,
          });
          markCallDone();
          console.log(`[REALTIME] ${person.naam} → ${args.classification}`);
          if (streamSid) {
            twilioWs.send(JSON.stringify({
              event: 'mark',
              streamSid,
              mark: { name: 'hangup' },
            }));
          }
        } catch (err) {
          console.error('[REALTIME] classify_response parse error:', err.message);
        }
      }

      if (event.type === 'error') {
        console.error('[REALTIME] OpenAI error:', JSON.stringify(event.error));
      }
    });

    openAiWs.on('error', (err) => console.error('[REALTIME] OpenAI WS error:', err.message));
    openAiWs.on('close', () => console.log('[REALTIME] OpenAI verbinding gesloten'));
  }

  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      const personId = msg.start.customParameters?.personId;

      person = sessions.get(`person-${personId}`);
      if (!person) {
        console.error(`[REALTIME] Geen sessie voor personId ${personId}`);
        twilioWs.close();
        return;
      }
      sessions.delete(`person-${personId}`);
      shiftSpeech = shiftToSpeech(person.tijdslot);

      sessions.set(callSid, { person, history: [], finalLogged: false });
      console.log(`[REALTIME] Stream gestart: ${callSid} → ${person.naam}`);
      connectToOpenAI();
    }

    if (msg.event === 'mark' && msg.mark?.name === 'hangup') {
      twilioClient.calls(callSid).update({ status: 'completed' }).catch(err =>
        console.error('[REALTIME] Hangup error:', err.message)
      );
    }

    if (msg.event === 'media' && openAiWs?.readyState === WebSocket.OPEN) {
      openAiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: msg.media.payload,
      }));
    }

    if (msg.event === 'stop') {
      openAiWs?.close();
    }
  });

  twilioWs.on('close', () => openAiWs?.close());
  twilioWs.on('error', (err) => {
    console.error('[REALTIME] Twilio WS error:', err.message);
    openAiWs?.close();
  });
}

module.exports = { handleMediaStream };
