let logs = [];

function logResponse({ personId, naam, tijdslot, callSid, classification, rawResponse, answeredCall, followUp }) {
  logs.push({
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    personId,
    naam,
    tijdslot,
    callSid,
    classification,
    followUp: followUp === true,
    rawResponse: rawResponse || null,
    answeredCall,
  });
}

function getLogs() {
  return logs;
}

function clearLogs() {
  logs = [];
}

module.exports = { logResponse, getLogs, clearLogs };
