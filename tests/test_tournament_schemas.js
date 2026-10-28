const assert = require('assert');
const path = require('path');
const fs = require('fs');

// We test the tournament schema management logic
const server = require('../server.js');

console.log('Testing Tournament Schemas & Persistence Helpers...');

// Check that functions are exported
assert.strictEqual(typeof server.getRiddleBank, 'function', 'getRiddleBank must be a function');
assert.strictEqual(typeof server.saveRiddleBank, 'function', 'saveRiddleBank must be a function');
assert.strictEqual(typeof server.getTournamentAssignments, 'function', 'getTournamentAssignments must be a function');
assert.strictEqual(typeof server.saveTournamentAssignments, 'function', 'saveTournamentAssignments must be a function');
assert.strictEqual(typeof server.getRoundState, 'function', 'getRoundState must be a function');
assert.strictEqual(typeof server.saveRoundState, 'function', 'saveRoundState must be a function');
assert.strictEqual(typeof server.logAuditEvent, 'function', 'logAuditEvent must be a function');

// Test assignments structure
const assignments = server.getTournamentAssignments();
assert.ok(assignments.rounds, 'Assignments must contain rounds');
assert.strictEqual(assignments.rounds['1'].slots.length, 10, 'Round 1 must have 10 slots');
assert.strictEqual(assignments.rounds['2'].groups.A.slots.length, 3, 'Round 2 Group A must have 3 slots');
assert.strictEqual(assignments.rounds['2'].groups.B.slots.length, 3, 'Round 2 Group B must have 3 slots');
assert.strictEqual(assignments.rounds['3'].groups.A.slots.length, 1, 'Round 3 Group A must have 1 slot');
assert.strictEqual(assignments.rounds['3'].groups.B.slots.length, 1, 'Round 3 Group B must have 1 slot');
assert.ok(assignments.rounds['4'].slots.length >= 1, 'Round 4 must have at least 1 slot');

// Test round state
const roundState = server.getRoundState();
assert.ok(roundState['1'], 'Round 1 state must exist');
assert.ok(['Draft', 'Live', 'Completed'].includes(roundState['1'].status), 'Round 1 status should be Draft, Live, or Completed');
assert.ok(['Locked', 'Live', 'Completed'].includes(roundState['2'].status), 'Round 2 status should be Locked, Live, or Completed');
assert.ok(['Locked', 'Live', 'Completed'].includes(roundState['3'].status), 'Round 3 status should be Locked, Live, or Completed');
assert.ok(['Locked', 'Live', 'Completed'].includes(roundState['4'].status), 'Round 4 status should be Locked, Live, or Completed');

// Test audit logging
const testEvent = {
  action: 'TEST_AUDIT',
  admin: 'admin@lostcode',
  reason: 'Automated test audit event',
  details: { test: true }
};
server.logAuditEvent(testEvent);
const auditLog = JSON.parse(fs.readFileSync(path.join(__dirname, '../private/audit_log.json'), 'utf8'));
const recorded = auditLog.find(e => e.action === 'TEST_AUDIT');
assert.ok(recorded, 'Audit event must be logged and persisted');
assert.strictEqual(recorded.reason, 'Automated test audit event');

console.log('✅ Tournament Schemas & Persistence Helpers verified successfully!');
