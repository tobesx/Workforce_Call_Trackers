require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { VoiceResponse } = require('twilio').twiml;

const { initiateCallSingle } = require('./orchestrator');
const { handleStatus, handleAmd } = require('./call-handler');
const { handleMediaStream } = require('./realtime-bridge');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.post('/voice/start', (req, res) => {
  const { personId } = req.query;
  const wsUrl = `${process.env.BASE_URL.replace('https://', 'wss://')}/media-stream`;
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({ url: wsUrl });
  stream.parameter({ name: 'personId', value: personId });
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/status', handleStatus);
app.post('/voice/amd', handleAmd);

// --- WebSocket server (Twilio Media Streams) ---

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleMediaStream(ws);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3001;
db.init()
  .then(() => server.listen(PORT, () => {
    console.log(`Sixth Generation voice server → http://localhost:${PORT}`);
    console.log(`Public URL: ${process.env.BASE_URL || '(BASE_URL niet ingesteld)'}`);
  }))
  .catch(err => {
    console.error('[DB] Init failed, exiting:', err.message);
    process.exit(1);
  });
