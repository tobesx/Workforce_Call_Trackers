const twilio = require('twilio');
const sessions = require('./sessions');
const db = require('./db');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Demo: these 2 are called sequentially so they don't ring simultaneously during a presentation
const SEQUENTIAL_NAMES = ['Dennis De Reyer', 'Michiel Schepers'];
let seqActiveCallSid = null;
const seqQueue = []; // [{ person, runId }]

async function dialOut(person, runId) {
  sessions.set(`person-${person.id}`, person);

  const call = await client.calls.create({
    to: person.phone,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${process.env.BASE_URL}/voice/start?personId=${person.id}`,
    statusCallback: `${process.env.BASE_URL}/voice/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['no-answer', 'busy', 'failed', 'completed'],
  });

  const callId = await db.createCall(call.sid, person, runId);
  sessions.set(call.sid, { person, history: [], finalLogged: false });

  console.log(`[OUTBOUND] ${call.sid} → ${person.name} callId: ${callId} runId: ${runId}`);
  return { callId, callSid: call.sid };
}

function notifyCallDone(callSid) {
  if (callSid !== seqActiveCallSid) return;
  seqActiveCallSid = null;
  if (seqQueue.length > 0) {
    const { person, runId } = seqQueue.shift();
    console.log(`[SEQ] Nu bellen: ${person.name}`);
    dialOut(person, runId)
      .then(({ callSid: sid }) => { seqActiveCallSid = sid; })
      .catch(e => console.error(`[SEQ] dial mislukt voor ${person.name}: ${e.message}`));
  }
}

async function initiateCallSingle(person, runId) {
  if (SEQUENTIAL_NAMES.includes(person.name)) {
    if (seqActiveCallSid !== null) {
      seqQueue.push({ person, runId });
      console.log(`[SEQ] ${person.name} in wachtrij (actief: ${seqActiveCallSid})`);
      return { callId: null, callSid: null, queued: true };
    }
    seqActiveCallSid = 'PENDING';
    const result = await dialOut(person, runId);
    seqActiveCallSid = result.callSid;
    return result;
  }
  return dialOut(person, runId);
}

module.exports = { initiateCallSingle, notifyCallDone };
