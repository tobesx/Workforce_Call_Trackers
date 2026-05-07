const twilio = require('twilio');
const { getShifts } = require('./shifts');
const { initRun } = require('./run-state');
const sessions = require('./sessions');
const { synthesize } = require('./tts');
const { buildOpeningText } = require('./call-handler');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function initiateOutbound(persons) {
  const toContact = persons ?? getShifts().filter(s => s.te_contacteren);

  if (toContact.length === 0) {
    return { initiated: 0, failed: 0, message: 'Niemand te contacteren.' };
  }

  initRun(toContact.length);
  const results = await Promise.allSettled(toContact.map(person => initiateCall(person)));

  const initiated = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Call failed for ${toContact[i].naam}:`, r.reason.message);
    }
  });

  return { initiated, failed, total: toContact.length };
}

async function initiateCall(person) {
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

  sessions.set(call.sid, { person, history: [], finalLogged: false, openingAudio });

  console.log(`[OUTBOUND] ${call.sid} → ${person.naam} (${person.telefoon})`);
  return call.sid;
}

async function initiateCallSingle(person) {
  const callSid = await initiateCall(person);
  return { callSid };
}

module.exports = { initiateOutbound, initiateCallSingle };
