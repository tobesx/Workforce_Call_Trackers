const fs = require('fs');
const path = require('path');

const LOGS_FILE = path.join(__dirname, '../logs/responses.json');

function readLogs() {
  if (!fs.existsSync(LOGS_FILE)) return [];
  return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
}

function logResponse({ personId, naam, tijdslot, callSid, classification, rawResponse, answeredCall }) {
  const logs = readLogs();
  logs.push({
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    personId,
    naam,
    tijdslot,
    callSid,
    classification,
    rawResponse: rawResponse || null,
    answeredCall,
  });
  fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
}

function getLogs() {
  return readLogs();
}

function clearLogs() {
  fs.writeFileSync(LOGS_FILE, JSON.stringify([], null, 2));
}

module.exports = { logResponse, getLogs, clearLogs };
