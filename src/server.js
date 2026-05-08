require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { VoiceResponse } = require('twilio').twiml;

const { initiateCallSingle } = require('./orchestrator');
const { handleStatus } = require('./call-handler');
const { handleMediaStream } = require('./realtime-bridge');
const db = require('./db');

const audioDir = path.join(__dirname, '../audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/audio', express.static(audioDir));

// --- REST API (Retool) ---

app.get('/api/calls/:callId', async (req, res) => {
  try {
    const record = await db.getCall(req.params.callId);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (err) {
    console.error('getCall error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
    console.log(`ICO Terminals voice server → http://localhost:${PORT}`);
    console.log(`Public URL: ${process.env.BASE_URL || '(BASE_URL niet ingesteld)'}`);
  }))
  .catch(err => {
    console.error('[DB] Init failed, exiting:', err.message);
    process.exit(1);
  });
