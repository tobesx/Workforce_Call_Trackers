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
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS
      run_id UUID REFERENCES runs(id) ON DELETE SET NULL
  `);

  // remove usage columns from calls if they were added in a previous deploy
  await pool.query(`ALTER TABLE calls DROP COLUMN IF EXISTS input_audio_tokens`);
  await pool.query(`ALTER TABLE calls DROP COLUMN IF EXISTS output_audio_tokens`);
  await pool.query(`ALTER TABLE calls DROP COLUMN IF EXISTS input_text_tokens`);
  await pool.query(`ALTER TABLE calls DROP COLUMN IF EXISTS output_text_tokens`);
  await pool.query(`ALTER TABLE calls DROP COLUMN IF EXISTS call_duration_seconds`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_usage (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_sid              TEXT NOT NULL,
      input_audio_tokens    INTEGER,
      output_audio_tokens   INTEGER,
      input_text_tokens     INTEGER,
      output_text_tokens    INTEGER,
      call_duration_seconds INTEGER,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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

async function createCall(callSid, person, runId) {
  const { rows } = await pool.query(
    `INSERT INTO calls (call_sid, person_id, name, time_slot, phone, run_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [callSid, String(person.id), person.name, person.time_slot, person.phone, runId || null]
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

async function createCallUsage(callSid, { inputAudioTokens, outputAudioTokens, inputTextTokens, outputTextTokens, durationSeconds }) {
  await pool.query(
    `INSERT INTO call_usage (call_sid, input_audio_tokens, output_audio_tokens, input_text_tokens, output_text_tokens, call_duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [callSid, inputAudioTokens ?? null, outputAudioTokens ?? null, inputTextTokens ?? null, outputTextTokens ?? null, durationSeconds ?? null]
  );
}

async function getUsage() {
  const { rows } = await pool.query(`
    SELECT
      cu.call_sid,
      c.name,
      c.time_slot,
      c.classification,
      c.answered_call,
      SUM(cu.input_audio_tokens)    AS input_audio_tokens,
      SUM(cu.output_audio_tokens)   AS output_audio_tokens,
      SUM(cu.input_text_tokens)     AS input_text_tokens,
      SUM(cu.output_text_tokens)    AS output_text_tokens,
      SUM(cu.call_duration_seconds) AS call_duration_seconds
    FROM call_usage cu
    JOIN calls c ON c.call_sid = cu.call_sid
    GROUP BY cu.call_sid, c.name, c.time_slot, c.classification, c.answered_call
    ORDER BY c.name
  `);
  return rows;
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

module.exports = { init, createRun, createCall, updateCallBySid, createCallUsage, getUsage, getRun, getCall };
