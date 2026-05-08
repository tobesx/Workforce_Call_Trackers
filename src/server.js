require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { initiateCallSingle } = require('./orchestrator');
const { handleCallStart, handleGather, handleStatus } = require('./call-handler');

const audioDir = path.join(__dirname, '../audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/audio', express.static(audioDir));

// --- REST API (Retool) ---

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

app.post('/voice/start', handleCallStart);
app.post('/voice/gather', handleGather);
app.post('/voice/status', handleStatus);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ICO Terminals voice server → http://localhost:${PORT}`);
  console.log(`Public URL: ${process.env.BASE_URL || '(BASE_URL niet ingesteld)'}`);
});
