const sessions = require('./sessions');
const db = require('./db');
const { notifyCallDone } = require('./orchestrator');

async function handleStatus(req, res) {
  const { CallSid, CallStatus } = req.body;
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

  if (CallStatus === 'completed') sessions.delete(CallSid);

  notifyCallDone(CallSid);
  res.sendStatus(204);
}

module.exports = { handleStatus };
