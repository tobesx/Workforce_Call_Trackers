# Sixth Generation — AI Planning Voice Agent

Automated availability checking for port logistics shift planning. An AI voice agent calls workers via Twilio, conducts a natural Dutch conversation to confirm availability, and returns structured results.

## How it works

1. A planning tool sends a list of workers to the backend
2. The backend initiates parallel outbound calls via Twilio
3. When a worker picks up, the OpenAI Realtime API conducts a short conversation in Dutch (native STT + TTS)
4. The agent classifies the outcome: YES, NO, OTHER, or NO_ANSWER
5. Results are polled by the frontend via `GET /api/runs/:runId`

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ / Express |
| AI + Voice | OpenAI Realtime API (`gpt-realtime-2`) |
| Telephony | Twilio Voice (Media Streams) |
| Database | PostgreSQL (Railway) |
| Frontend | Lovable (React) |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
PORT=3001
BASE_URL=https://your-public-url.dev

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+32460000000

OPENAI_API_KEY=sk-...

DATABASE_URL=postgresql://...
```

### 3. Expose the server publicly (local development)

Twilio needs to reach your webhooks:

```bash
ngrok http 3001
```

Copy the HTTPS URL into `BASE_URL`.

### 4. Start the server

```bash
npm start       # production
npm run dev     # development (auto-reload)
```

## API Reference

### Create a run

```
POST /api/runs
{ "total": 5 }
→ { "runId": "uuid" }
```

### Initiate a single call

```
POST /api/outbound/call
{ "person": { "id": "1", "name": "Jan Declercq", "phone": "+32471000000", "time_slot": "22:00 - 06:00" }, "runId": "uuid" }
→ { "callId": "uuid", "callSid": "CA..." }
```

### Poll run status

```
GET /api/runs/:runId
→ { id, total, status, complete, calls[] }
```

## Call flow

```
POST /api/outbound/call  →  Twilio.calls.create()
Twilio belt nummer
Twilio POST /voice/start  →  TwiML <Stream>
WebSocket /media-stream   →  OpenAI Realtime bridge
classify_response()       →  DB write → run completion check
```

## Call outcomes

| Classification | Meaning |
|---------------|---------|
| `YES` | Worker confirmed availability |
| `NO` | Worker refused or unavailable |
| `OTHER` | Unclear response — human follow-up needed |
| `NO_ANSWER` | Call not answered, busy, or failed |

## Project structure

```
src/
├── server.js           Express app, REST API, Twilio webhook routes
├── orchestrator.js     Outbound call initiation via Twilio
├── realtime-bridge.js  WebSocket bridge: Twilio ↔ OpenAI Realtime API
├── call-handler.js     Twilio status webhook, NO_ANSWER fallback
├── sessions.js         In-memory callSid → person store
└── db.js               PostgreSQL pool, schema init, CRUD
```

## Twilio webhook routes

| Route | Trigger |
|-------|---------|
| `POST /voice/start?personId=X` | Call answered — opens Media Stream |
| `POST /voice/status` | Call status update (completed / no-answer / busy / failed) |
