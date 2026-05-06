require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { initiateOutbound, initiateCallSingle } = require('./orchestrator');
const { handleCallStart, handleGather, handleStatus } = require('./call-handler');
const { getShifts, updateShift } = require('./shifts');
const { getLogs, clearLogs } = require('./logger');
const { isComplete } = require('./run-state');

// Ensure dirs exist
['audio', 'logs'].forEach(dir => {
  const p = path.join(__dirname, '..', dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p);
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/audio', express.static(path.join(__dirname, '../audio')));

// --- REST API (Retool) ---

app.get('/api/shifts', (req, res) => {
  res.json(getShifts());
});

app.patch('/api/shifts/:id', (req, res) => {
  const updated = updateShift(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Shift niet gevonden' });
  res.json(updated);
});

app.post('/api/outbound/start', async (req, res) => {
  try {
    clearLogs();
    const result = await initiateOutbound(req.body.persons);
    res.json(result);
  } catch (err) {
    console.error('Outbound error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/outbound/wait', (req, res) => {
  const TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_MS = 1000;
  const deadline = Date.now() + TIMEOUT_MS;

  const interval = setInterval(() => {
    if (isComplete()) {
      clearInterval(interval);
      return res.json({ status: 'complete', logs: getLogs().map(formatLog) });
    }
    if (Date.now() >= deadline) {
      clearInterval(interval);
      return res.json({ status: 'timeout', logs: getLogs().map(formatLog) });
    }
  }, POLL_MS);
});

const RESULTAAT_MAP = {
  YES: 'Bevestigd',
  NO: 'Geweigerd',
  OTHER: 'Opvolging',
  NO_ANSWER: 'Geen antwoord',
};

function formatLog(log, index) {
  const timeMatch = log.tijdslot && log.tijdslot.match(/(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})/);
  const tijdslot = timeMatch ? `${timeMatch[1]}–${timeMatch[2]}` : (log.tijdslot || '');
  const tijdstip = new Date(log.timestamp).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
  return {
    id: index + 1,
    naam: log.naam,
    tijdslot,
    resultaat: RESULTAAT_MAP[log.classification] || log.classification,
    antwoord: log.rawResponse || '—',
    tijdstip,
  };
}

// --- Single-call endpoints (frontend-orchestrated flow) ---

app.post('/api/outbound/call', async (req, res) => {
  try {
    const result = await initiateCallSingle(req.body.person);
    res.json(result);
  } catch (err) {
    console.error('Single call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/outbound/call/:callSid/wait', (req, res) => {
  const { callSid } = req.params;
  const TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_MS = 1000;
  const deadline = Date.now() + TIMEOUT_MS;

  const interval = setInterval(() => {
    const logs = getLogs();
    const log = logs.find(l => l.callSid === callSid);
    if (log) {
      clearInterval(interval);
      return res.json({ status: 'complete', result: formatLog(log, logs.indexOf(log)) });
    }
    if (Date.now() >= deadline) {
      clearInterval(interval);
      return res.json({ status: 'timeout' });
    }
  }, POLL_MS);
});

app.get('/api/logs', (req, res) => {
  res.json(getLogs().map(formatLog));
});

// --- Twilio webhooks ---

app.post('/voice/start', handleCallStart);
app.post('/voice/gather', handleGather);
app.post('/voice/status', handleStatus);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ICO Terminals voice server → http://localhost:${PORT}`);
  console.log(`Public URL: ${process.env.BASE_URL || '(BASE_URL niet ingesteld)'}`);
});
