const twilio = require('twilio');
const { getShifts } = require('./shifts');
const { initRun, markCallDone } = require('./run-state');
const { logResponse } = require('./logger');
const sessions = require('./sessions');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const REAL_PHONE = process.env.REAL_PHONE || '+32471461722';

const MOCK_RESPONSES = [
  { classification: 'YES',       followUp: false, rawResponse: 'Ja, ik ben beschikbaar.' },
  { classification: 'YES',       followUp: true,  rawResponse: 'Ja, maar kunt u me even terugbellen over het tijdstip?' },
  { classification: 'NO',        followUp: false, rawResponse: 'Nee, ik kan die dag niet.' },
  { classification: 'NO',        followUp: true,  rawResponse: 'Niet beschikbaar vandaag, maar misschien volgende week.' },
  { classification: 'OTHER',     followUp: true,  rawResponse: 'Ik bel later terug.' },
  { classification: 'NO_ANSWER', followUp: false, rawResponse: null },
];

async function initiateOutbound(persons) {
  const toContact = persons ?? getShifts().filter(s => s.te_contacteren);

  if (toContact.length === 0) {
    return { initiated: 0, failed: 0, message: 'Niemand te contacteren.' };
  }

  initRun(toContact.length);
  const results = await Promise.allSettled(toContact.map(person =>
    person.telefoon === REAL_PHONE ? initiateCall(person) : mockCall(person)
  ));

  const initiated = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Call failed for ${toContact[i].naam}:`, r.reason.message);
    }
  });

  return { initiated, failed, total: toContact.length };
}

async function initiateCall(person) {
  sessions.set(`person-${person.id}`, person);

  const call = await client.calls.create({
    to: person.telefoon,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${process.env.BASE_URL}/voice/start?personId=${person.id}`,
    statusCallback: `${process.env.BASE_URL}/voice/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['no-answer', 'busy', 'failed', 'completed'],
  });

  // Pre-seed session by callSid so handleStatus can find person even if call is never answered
  sessions.set(call.sid, { person, history: [], finalLogged: false });

  console.log(`[OUTBOUND] ${call.sid} → ${person.naam} (${person.telefoon})`);
  return call.sid;
}

async function mockCall(person) {
  const mock = MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)];
  const callSid = `MOCK-${person.id}-${Date.now()}`;

  logResponse({
    personId:     person.id,
    naam:         person.naam,
    tijdslot:     person.tijdslot,
    callSid,
    classification: mock.classification,
    followUp:     mock.followUp,
    rawResponse:  mock.rawResponse,
    answeredCall: mock.classification !== 'NO_ANSWER',
  });

  markCallDone();
  console.log(`[MOCK] ${person.naam} → ${mock.classification}`);
  return callSid;
}

async function initiateCallSingle(person) {
  const callSid = person.telefoon === REAL_PHONE
    ? await initiateCall(person)
    : await mockCall(person);
  return { callSid };
}

module.exports = { initiateOutbound, initiateCallSingle };
