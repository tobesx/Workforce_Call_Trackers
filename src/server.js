require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { initiateCallSingle } = require('./orchestrator');
const { handleCallStart, handleGather, handleStatus } = require('./call-handler');
const db = require('./db');

const audioDir = path.join(__dirname, '../audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/audio', express.static(audioDir));

// --- REST API (Retool) ---

app.post('/api/runs', async (req, res) => {
  try {
    const { total } = req.body;
    if (!total || total < 1) return res.status(400).json({ error: 'total required' });
    const runId = await db.createRun(total);
    res.json({ runId });
  } catch (err) {
    console.error('createRun error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId', async (req, res) => {
  try {
    const run = await db.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  } catch (err) {
    console.error('getRun error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/outbound/call', async (req, res) => {
  try {
    const { person, runId } = req.body;
    const result = await initiateCallSingle(person, runId);
    res.json(result);
  } catch (err) {
    console.error('Single call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Twilio webhooks ---

app.post('/voice/start', handleCallStart);
app.post('/voice/gather', handleGather);
app.post('/voice/status', handleStatus);

const PORT = process.env.PORT || 3001;
db.init()
  .then(() => app.listen(PORT, () => {
    console.log(`ICO Terminals voice server → http://localhost:${PORT}`);
    console.log(`Public URL: ${process.env.BASE_URL || '(BASE_URL niet ingesteld)'}`);
  }))
  .catch(err => {
    console.error('[DB] Init failed, exiting:', err.message);
    process.exit(1);
  });
