const fs = require('fs');
const path = require('path');

const SHIFTS_FILE = path.join(__dirname, '../planning-data/shifts.json');

function getShifts() {
  return JSON.parse(fs.readFileSync(SHIFTS_FILE, 'utf-8'));
}

function updateShift(id, updates) {
  const shifts = getShifts();
  const idx = shifts.findIndex(s => s.id === id);
  if (idx === -1) return null;
  shifts[idx] = { ...shifts[idx], ...updates };
  fs.writeFileSync(SHIFTS_FILE, JSON.stringify(shifts, null, 2));
  return shifts[idx];
}

module.exports = { getShifts, updateShift };
