const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      total      INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'in_progress',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id         UUID REFERENCES runs(id) ON DELETE SET NULL,
      call_sid       TEXT UNIQUE NOT NULL,
      person_id      TEXT,
      name           TEXT,
      time_slot      TEXT,
      phone          TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      classification TEXT,
      follow_up      BOOLEAN,
      raw_response   TEXT,
      answered_call  BOOLEAN,
      voice          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS
      run_id UUID REFERENCES runs(id) ON DELETE SET NULL
  `);

  await pool.query(`
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS voice TEXT
  `);

  console.log('[DB] schema ready');
}

async function createRun(total) {
  const { rows } = await pool.query(
    'INSERT INTO runs (total) VALUES ($1) RETURNING id',
    [total]
  );
  return rows[0].id;
}

async function createCall(callSid, person, runId, voice) {
  const { rows } = await pool.query(
    `INSERT INTO calls (call_sid, person_id, name, time_slot, phone, run_id, voice)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [callSid, String(person.id), person.name, person.time_slot, person.phone, runId || null, voice || null]
  );
  return rows[0].id;
}

async function updateCallBySid(callSid, { classification, followUp, rawResponse, answeredCall }) {
  const { rows } = await pool.query(
    `UPDATE calls
     SET status         = 'completed',
         classification = $2,
         follow_up      = $3,
         raw_response   = $4,
         answered_call  = $5,
         updated_at     = NOW()
     WHERE call_sid = $1
     RETURNING run_id`,
    [callSid, classification, followUp ?? false, rawResponse ?? null, answeredCall ?? false]
  );

  const runId = rows[0]?.run_id;
  if (runId) {
    const { rows: runRows } = await pool.query('SELECT total FROM runs WHERE id = $1', [runId]);
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) FROM calls WHERE run_id = $1 AND status = 'completed'",
      [runId]
    );
    if (parseInt(countRows[0].count) >= runRows[0]?.total) {
      await pool.query(
        "UPDATE runs SET status = 'completed', updated_at = NOW() WHERE id = $1",
        [runId]
      );
    }
  }
}

async function getRun(runId) {
  const { rows: runRows } = await pool.query('SELECT * FROM runs WHERE id = $1', [runId]);
  if (!runRows[0]) return null;
  const run = runRows[0];

  const { rows: calls } = await pool.query(
    'SELECT * FROM calls WHERE run_id = $1 ORDER BY created_at ASC',
    [runId]
  );

  const complete = calls.length >= run.total &&
    calls.every(c => c.status === 'completed');

  return { ...run, calls, complete };
}

async function getCall(callId) {
  const { rows } = await pool.query('SELECT * FROM calls WHERE id = $1', [callId]);
  return rows[0] || null;
}

module.exports = { init, createRun, createCall, updateCallBySid, getRun, getCall };
