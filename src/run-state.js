let state = { total: 0, completed: 0 };

function initRun(total) {
  state = { total, completed: 0 };
}

function markCallDone() {
  state.completed++;
}

function isComplete() {
  return state.total > 0 && state.completed >= state.total;
}

module.exports = { initRun, markCallDone, isComplete };
