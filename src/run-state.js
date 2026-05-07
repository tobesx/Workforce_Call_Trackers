let state = { total: 0, completed: 0, token: null };

function initRun(total) {
  state = { total, completed: 0, token: Date.now().toString() };
}

function getToken() {
  return state.token;
}

function markCallDone() {
  state.completed++;
}

function isComplete() {
  return state.total > 0 && state.completed >= state.total;
}

module.exports = { initRun, getToken, markCallDone, isComplete };
