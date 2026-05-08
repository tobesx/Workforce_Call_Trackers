const twilio = require('twilio');
const sessions = require('./sessions');
const { synthesize } = require('./tts');
const { buildOpeningText } = require('./call-handler');
const db = require('./db');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function initiateCallSingle(person, runId) {
  sessions.set(`person-${person.id}`, person);

  let openingAudio = null;
  try {
    openingAudio = await synthesize(buildOpeningText(person));
  } catch (err) {
    console.error(`[PRE-GEN TTS] ${person.naam}: ${err.message}`);
  }

  const call = await client.calls.create({
    to: person.telefoon,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${process.env.BASE_URL}/voice/start?personId=${person.id}`,
    statusCallback: `${process.env.BASE_URL}/voice/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['no-answer', 'busy', 'failed', 'completed'],
  });

  const callId = await db.createCall(call.sid, person, runId);
  sessions.set(call.sid, { person, history: [], finalLogged: false, openingAudio });

  console.log(`[OUTBOUND] ${call.sid} → ${person.naam} callId: ${callId} runId: ${runId}`);
  return { callId, callSid: call.sid };
}

module.exports = { initiateCallSingle };
