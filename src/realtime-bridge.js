const WebSocket = require('ws');
const sessions = require('./sessions');
const { logResponse } = require('./logger');
const { markCallDone } = require('./run-state');

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
  return `Je bent een planning agent van ICO Terminals, een autologistiek bedrijf in de haven van Zeebrugge.
Je belt ${person.naam} om te vragen of hij/zij beschikbaar is voor een shift ${shiftSpeech}.

KERNREGELS:
- Spreek altijd vloeiend Nederlands
- Hou antwoorden kort en professioneel
- Begin het gesprek ALTIJD met exact: "Goedendag, u spreekt met de planningsagent van ICO Terminals. Bent u beschikbaar voor een shift ${shiftSpeech}?"
- Beantwoord NOOIT vragen buiten planning — verwijs altijd door naar een medewerker
- Probeer NOOIT een follow-up vraag zelf te beantwoorden

SLUITINGSZINNEN — gebruik exact bij finale classificatie:
- YES + geen follow-up: "Uitstekend, je bevestiging is geregistreerd. Tot dan!"
- YES + follow-up: "Uitstekend, je bevestiging is geregistreerd. Voor je verdere vraag zal een medewerker contact met je opnemen. Tot dan!"
- NO + geen follow-up: "Begrepen, bedankt voor je antwoord. Tot dan!"
- NO + follow-up: "Begrepen, bedankt voor je antwoord. Een medewerker zal contact met je opnemen. Tot dan!"
- OTHER: "Begrepen, een medewerker zal contact met je opnemen. Tot dan!"

Na de sluitingszin: roep classify_response aan met het resultaat.`;
}

function handleMediaStream(twilioWs, personId) {
  let streamSid = null;
  let callSid = null;
  let openAiWs = null;
  let finalLogged = false;

  const person = sessions.get(`person-${personId}`);
  if (!person) {
    console.error(`[REALTIME] Geen sessie voor personId ${personId}`);
    twilioWs.close();
    return;
  }
  sessions.delete(`person-${personId}`);

  const shiftSpeech = shiftToSpeech(person.tijdslot);

  function connectToOpenAI() {
    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
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
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
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
      sessions.set(callSid, { person, history: [], finalLogged: false });
      console.log(`[REALTIME] Stream gestart: ${callSid} → ${person.naam}`);
      connectToOpenAI();
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
