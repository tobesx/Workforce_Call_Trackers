const twilio = require('twilio');
const sessions = require('./sessions');
const db = require('./db');
const { resolveVoice } = require('./realtime-bridge');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function initiateCallSingle(person, runId) {
  sessions.set(`person-${person.id}`, person);

  const call = await client.calls.create({
    to: person.phone,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${process.env.BASE_URL}/voice/start?personId=${person.id}`,
    statusCallback: `${process.env.BASE_URL}/voice/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['no-answer', 'busy', 'failed', 'completed'],
    // Voicemail neemt op, dus Twilio ziet geen 'no-answer'. AMD draait
    // asynchroon zodat de begroeting voor echte mensen niet vertraagt.
    machineDetection: 'Enable',
    asyncAmd: 'true',
    asyncAmdStatusCallback: `${process.env.BASE_URL}/voice/amd`,
    asyncAmdStatusCallbackMethod: 'POST',
  });

  const callId = await db.createCall(call.sid, person, runId, resolveVoice(person.voice));
  sessions.set(call.sid, { person, history: [], finalLogged: false });

  console.log(`[OUTBOUND] ${call.sid} → ${person.name} callId: ${callId} runId: ${runId}`);
  return { callId, callSid: call.sid };
}

module.exports = { initiateCallSingle };
