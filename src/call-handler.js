const sessions = require('./sessions');

async function handleStatus(req, res) {
  const { CallSid, CallStatus } = req.body;
  const TERMINAL = ['no-answer', 'busy', 'failed', 'completed'];

  if (!TERMINAL.includes(CallStatus)) return res.sendStatus(204);

  const session = sessions.get(CallSid);
  if (!session) return res.sendStatus(204);

  if (CallStatus === 'completed') sessions.delete(CallSid);

  res.sendStatus(204);
}

module.exports = { handleStatus };
