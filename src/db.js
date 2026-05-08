const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_sid      TEXT UNIQUE NOT NULL,
      person_id     TEXT,
      name          TEXT,
      time_slot     TEXT,
      phone         TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      classification TEXT,
      follow_up     BOOLEAN,
      raw_response  TEXT,
      answered_call BOOLEAN,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[DB] calls table ready');
}

async function createCall(callSid, person) {
  const { rows } = await pool.query(
    `INSERT INTO calls (call_sid, person_id, name, time_slot, phone)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [callSid, String(person.id), person.naam, person.tijdslot, person.telefoon]
  );
  return rows[0].id;
}

async function updateCallBySid(callSid, { classification, followUp, rawResponse, answeredCall }) {
  await pool.query(
    `UPDATE calls
     SET status        = 'completed',
         classification = $2,
         follow_up      = $3,
         raw_response   = $4,
         answered_call  = $5,
         updated_at     = NOW()
     WHERE call_sid = $1`,
    [callSid, classification, followUp ?? false, rawResponse ?? null, answeredCall ?? false]
  );
}

async function getCall(callId) {
  const { rows } = await pool.query('SELECT * FROM calls WHERE id = $1', [callId]);
  return rows[0] || null;
}

async function getCallsSince(since) {
  const { rows } = await pool.query(
    'SELECT * FROM calls WHERE created_at >= $1 ORDER BY created_at ASC',
    [since]
  );
  return rows;
}

module.exports = { init, createCall, updateCallBySid, getCall, getCallsSince };
