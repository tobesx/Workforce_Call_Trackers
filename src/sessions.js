const store = new Map();

module.exports = {
  set: (callSid, data) => store.set(callSid, data),
  get: (callSid) => store.get(callSid),
  update: (callSid, updates) => {
    const existing = store.get(callSid);
    if (existing) store.set(callSid, { ...existing, ...updates });
  },
  delete: (callSid) => store.delete(callSid),
};
