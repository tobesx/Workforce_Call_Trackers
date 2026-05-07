require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { initiateCallSingle } = require('./orchestrator');
const { handleCallStart, handleGather, handleStatus } = require('./call-handler');
const { getLogs, clearLogs } = require('./logger');
const { initRun, isComplete } = require('./run-state');

const audioDir = path.join(__dirname, '../audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/audio', express.static(audioDir));

// --- REST API (Retool) ---

app.post('/api/outbound/session/start', (req, res) => {
  const { total } = req.body;
  if (!total || total < 1) return res.status(400).json({ error: 'total vereist' });
  clearLogs();
  initRun(total);
  res.json({ ok: true, total });
});

app.post('/api/outbound/call', async (req, res) => {
  try {
    const result = await initiateCallSingle(req.body.person);
    res.json(result);
  } catch (err) {
    console.error('Single call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: getLogs().map(formatLog), complete: isComplete() });
});

// --- Twilio webhooks ---

app.post('/voice/start', handleCallStart);
app.post('/voice/gather', handleGather);
app.post('/voice/status', handleStatus);

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
    opvolging: log.followUp === true,
    antwoord: log.rawResponse || '—',
    tijdstip,
  };
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ICO Terminals voice server → http://localhost:${PORT}`);
  console.log(`Public URL: ${process.env.BASE_URL || '(BASE_URL niet ingesteld)'}`);
});
