# ICO Terminals — AI Planning Voice Agent

Automated availability checking for port logistics shift planning. An AI voice agent calls workers via Twilio, conducts a natural Dutch conversation to confirm availability, and returns structured results.

## How it works

1. A planning tool (Retool) sends a list of workers to the backend
2. The backend initiates parallel outbound calls via Twilio
3. When a worker picks up, an AI agent (GPT-4o) conducts a short conversation in Dutch
4. Responses are synthesized to speech via ElevenLabs and played over the call
5. The agent classifies the outcome: confirmed, refused, follow-up needed, or no answer
6. Results are returned to the planning tool via a long-poll endpoint

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ / Express |
| AI | OpenAI GPT-4o |
| Text-to-speech | ElevenLabs |
| Telephony | Twilio Voice |
| Frontend | Retool |

## Prerequisites

- Node.js 18+
- [ngrok](https://ngrok.com) or a public HTTPS URL (required for Twilio webhooks)
- Accounts and API keys for: Twilio, OpenAI, ElevenLabs

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
# Server
PORT=3001
BASE_URL=https://your-ngrok-or-public-url.dev

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+32460000000

# OpenAI
OPENAI_API_KEY=sk-...

# ElevenLabs
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=your_voice_id

# Demo mode — only this number receives a real call, all others get mocked
REAL_PHONE=+32471000000
```

### 3. Expose the server publicly (local development)

Twilio needs to reach your webhooks. Use ngrok:

```bash
ngrok http 3001
```

Copy the HTTPS URL into `BASE_URL` in your `.env`.

### 4. Start the server

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

Server runs on `http://localhost:3001`.

## API Reference

### Start outbound calls

```
POST /api/outbound/start
Content-Type: application/json

{
  "persons": [
    {
      "id": "1",
      "naam": "Jan Declercq",
      "telefoon": "+32471461722",
      "tijdslot": "morgen nacht (22:00 - 06:00)",
      "te_contacteren": true
    }
  ]
}
```

Returns `{ initiated, failed, total }` immediately. Calls are made in parallel.
Clears previous call logs on each new run.

### Wait for results (long-poll)

```
GET /api/outbound/wait
```

Blocks until all calls have a final status (max 5 minutes). Returns:

```json
{
  "status": "complete",
  "logs": [
    {
      "id": 1,
      "naam": "Jan Declercq",
      "tijdslot": "22:00–06:00",
      "resultaat": "Bevestigd",
      "antwoord": "Ja, ik ben beschikbaar.",
      "tijdstip": "14:32"
    }
  ]
}
```

### Get current logs

```
GET /api/logs
```

Returns the formatted log array without blocking.

### Shifts (fallback data)

```
GET  /api/shifts          # list all shifts
PATCH /api/shifts/:id     # update a shift
```

## Call outcomes

| Classification | Dutch label | Meaning |
|---------------|-------------|---------|
| `YES` | Bevestigd | Worker confirmed availability |
| `NO` | Geweigerd | Worker refused or unavailable |
| `OTHER` | Opvolging | Unclear response — human follow-up needed |
| `NO_ANSWER` | Geen antwoord | Call not answered, busy, or failed |

## Demo mode

Set `REAL_PHONE` in `.env` to your own number. When calls are triggered:
- The number matching `REAL_PHONE` receives a real Twilio call
- All other numbers receive an instant mock response with a random outcome

This allows end-to-end testing without calling real workers.

## Project structure

```
src/
├── server.js          Express app, REST API, Twilio webhook routes
├── orchestrator.js    Parallel outbound call logic, demo mock mode
├── call-handler.js    Twilio webhook handlers, GPT-4o conversation loop
├── tts.js             ElevenLabs text-to-speech
├── sessions.js        In-memory call session store (callSid → person + history)
├── run-state.js       Tracks call completion for long-poll endpoint
├── logger.js          Writes and reads call results (logs/responses.json)
└── shifts.js          Reads/writes planning-data/shifts.json (fallback data)

planning-data/
└── shifts.json        Fallback worker data when no body is sent to /api/outbound/start
```

## Twilio webhook routes

| Route | Trigger |
|-------|---------|
| `POST /voice/start?personId=X` | Call answered — generates and plays opening message |
| `POST /voice/gather` | Worker speech received — runs GPT-4o, plays response |
| `POST /voice/status` | Call status update (completed / no-answer / busy / failed) |
