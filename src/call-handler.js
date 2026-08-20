const twilio = require('twilio');
const sessions = require('./sessions');
const db = require('./db');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function handleStatus(req, res) {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const TERMINAL = ['no-answer', 'busy', 'failed', 'completed'];

  if (!TERMINAL.includes(CallStatus)) return res.sendStatus(204);

  const session = sessions.get(CallSid);
  if (!session) return res.sendStatus(204);

  if (!session.finalLogged) {
    db.updateCallBySid(CallSid, {
      classification: 'NO_ANSWER',
      followUp: false,
      rawResponse: null,
      answeredCall: false,
    }).catch(e => console.error(`[DB] NO_ANSWER update failed for ${CallSid}: ${e.message}`));
  }

  if (CallStatus === 'completed') {
    sessions.delete(CallSid);
  }

  res.sendStatus(204);
}

// Twilio meldt asynchroon of een mens of een machine opnam. Bij een machine
// heeft doorpraten geen zin: meteen NO_ANSWER en ophangen, in plaats van de
// hele voicemailboodschap uitzitten.
async function handleAmd(req, res) {
  const { CallSid, AnsweredBy } = req.body;
  res.sendStatus(204);

  // 'unknown' betekent dat Twilio het niet zeker weet — dan niet ingrijpen.
  if (!AnsweredBy || AnsweredBy === 'human' || AnsweredBy === 'unknown') {
    console.log(`[AMD] ${CallSid}: ${AnsweredBy || 'geen waarde'}, gesprek loopt door`);
    return;
  }

  const session = sessions.get(CallSid);
  if (session?.finalLogged) return;

  console.log(`[AMD] ${CallSid}: ${AnsweredBy} → NO_ANSWER, ophangen`);
  sessions.update(CallSid, { finalLogged: true });

  db.updateCallBySid(CallSid, {
    classification: 'NO_ANSWER',
    followUp: false,
    rawResponse: `Antwoordapparaat gedetecteerd (${AnsweredBy})`,
    answeredCall: false,
  }).catch(e => console.error(`[AMD] DB update mislukt voor ${CallSid}: ${e.message}`));

  twilioClient.calls(CallSid).update({ status: 'completed' })
    .catch(e => console.error(`[AMD] Ophangen mislukt voor ${CallSid}: ${e.message}`));
}

module.exports = { handleStatus, handleAmd };
