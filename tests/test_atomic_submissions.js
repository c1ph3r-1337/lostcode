const http = require('http');
const assert = require('assert');
const {
  app,
  teams,
  getRiddleBank,
  saveRiddleBank,
  getTournamentAssignments,
  saveTournamentAssignments,
  getRoundState,
  saveRoundState,
  getCredentials
} = require('../server.js');

async function runTests() {
  console.log('Testing Authoritative Concurrency-Safe Submission & Slot Claiming Engine...');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const initialRiddleBank = JSON.parse(JSON.stringify(getRiddleBank()));
  const initialAssignments = JSON.parse(JSON.stringify(getTournamentAssignments()));
  const initialRoundState = JSON.parse(JSON.stringify(getRoundState()));
  const fs = require('fs');
  const path = require('path');
  const teamsPath = path.join(__dirname, '../teams.json');
  const initialTeams = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));

  try {
    // 1. Setup Round 2 scenario: Group A has 2 teams (buccaneers, corsairs) competing for Slot 1
    const riddleBank = getRiddleBank();
    riddleBank['riddle_r2_ga_s1'] = {
      id: 'riddle_r2_ga_s1',
      title: 'Dead Man Reef',
      text: 'What has no heart yet beats?',
      expectedAnswer: 'An ocean wave',
      targetRound: 2,
      status: 'published',
      answerMatchingRule: { caseSensitive: false, trim: true },
      points: 250,
      hints: []
    };
    saveRiddleBank(riddleBank);

    const assignments = getTournamentAssignments();
    assignments.rounds['2'].groups.A.slots[0].riddleId = 'riddle_r2_ga_s1';
    assignments.rounds['2'].groups.A.slots[0].claimed = false;
    assignments.rounds['2'].groups.A.slots[0].claimedBy = null;
    assignments.rounds['2'].groups.A.slots[0].eligibleTeams = ['crew_1_buccaneers', 'crew_3_corsairs'];
    assignments.rounds['2'].groups.A.slots[1].eligibleTeams = ['crew_5_scallywags'];
    assignments.rounds['2'].groups.A.slots[2].eligibleTeams = ['crew_7_blackflags', 'crew_9_dreadsails'];
    saveTournamentAssignments(assignments);

    const roundState = getRoundState();
    roundState['2'].status = 'Live';
    roundState['2'].qualifiers = [];
    roundState['2'].eliminations = [];
    saveRoundState(roundState);

    // Set test crews currentRound to 2 for Round 2 competition
    const bucMem = teams.find(t => t.id === 'crew_1_buccaneers');
    if (bucMem) {
      bucMem.currentRound = 2;
      bucMem.disqualified = false;
      delete bucMem.disqualifiedReason;
      if (bucMem.roundSolves) delete bucMem.roundSolves['2'];
      if (bucMem.roundTimers) delete bucMem.roundTimers['2'];
    }
    const corMem = teams.find(t => t.id === 'crew_3_corsairs');
    if (corMem) {
      corMem.currentRound = 2;
      corMem.disqualified = false;
      delete corMem.disqualifiedReason;
      if (corMem.roundSolves) delete corMem.roundSolves['2'];
      if (corMem.roundTimers) delete corMem.roundTimers['2'];
    }

    const creds = getCredentials();
    const bucPass = creds.teams.BUCCANEERS || creds.teams.buccaneers;
    const corPass = creds.teams.CORSAIRS || creds.teams.corsairs;

    // Login buccaneers
    const loginB = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamName: 'BUCCANEERS', password: bucPass })
    });
    const cookieB = loginB.headers.get('set-cookie');

    // Login corsairs
    const loginC = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamName: 'CORSAIRS', password: corPass })
    });
    const cookieC = loginC.headers.get('set-cookie');

    // 2. Unauthenticated submission
    const unauthSub = await fetch(`${baseUrl}/api/team/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'An ocean wave', round: 2 })
    });
    assert.strictEqual(unauthSub.status, 401, 'Unauthenticated submission must return 401');

    // 3. Invalid answer submission
    const wrongSub = await fetch(`${baseUrl}/api/team/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieB },
      body: JSON.stringify({ answer: 'A pirate clock', round: 2 })
    });
    assert.strictEqual(wrongSub.status, 200);
    const wrongData = await wrongSub.json();
    assert.strictEqual(wrongData.success, false, 'Wrong answer must fail');
    assert.strictEqual(wrongData.qualified, false, 'Wrong answer must not qualify');

    // 4. Correct answer submission by Buccaneers (case insensitive + trimmed)
    const validSubB = await fetch(`${baseUrl}/api/team/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieB },
      body: JSON.stringify({ answer: '   AN OCEAN WAVE   ', round: 2 })
    });
    assert.strictEqual(validSubB.status, 200);
    const validDataB = await validSubB.json();
    assert.strictEqual(validDataB.success, true, 'Valid submission must succeed');
    assert.strictEqual(validDataB.qualified, true, 'Team must be qualified for slot');
    assert.strictEqual(validDataB.slotId, 'R2_GA_S1');

    // Verify slot is recorded as claimed in persistent state
    const afterAssignments = getTournamentAssignments();
    const slot = afterAssignments.rounds['2'].groups.A.slots[0];
    assert.strictEqual(slot.claimed, true, 'Slot must be marked claimed in storage');
    assert.strictEqual(slot.claimedBy, 'crew_1_buccaneers', 'Slot claimedBy must be buccaneers');

    // 5. Secondary submission for the ALREADY CLAIMED slot by Corsairs
    const validSubC = await fetch(`${baseUrl}/api/team/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieC },
      body: JSON.stringify({ answer: 'An ocean wave', round: 2 })
    });
    assert.strictEqual(validSubC.status, 200);
    const validDataC = await validSubC.json();
    assert.strictEqual(validDataC.success, false, 'Must reject because slot is already claimed');
    assert.ok(validDataC.message.toLowerCase().includes('claimed'), 'Message must indicate slot was claimed');

    // 6. Round 4 Final Duel simulation:
    riddleBank['riddle_r4_final'] = {
      id: 'riddle_r4_final',
      title: 'The Final Compass',
      text: 'Where does the golden sun set at midnight?',
      expectedAnswer: 'At the North Pole',
      targetRound: 4,
      status: 'published',
      answerMatchingRule: { caseSensitive: false, trim: true },
      points: 1000,
      hints: []
    };
    saveRiddleBank(riddleBank);

    afterAssignments.rounds['4'].slots[0].riddleId = 'riddle_r4_final';
    afterAssignments.rounds['4'].slots[0].claimed = false;
    saveTournamentAssignments(afterAssignments);

    const rs4 = getRoundState();
    rs4['4'].status = 'Live';
    saveRoundState(rs4);

    if (bucMem) bucMem.currentRound = 4;

    const finalSub = await fetch(`${baseUrl}/api/team/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieB },
      body: JSON.stringify({ answer: 'At the North Pole', round: 4 })
    });
    const finalData = await finalSub.json();
    assert.strictEqual(finalData.success, true);
    assert.strictEqual(finalData.isWinner, true, 'First correct solve in Round 4 must crown winner');

    // Verify round 4 status updated to Completed / Locked
    const finalRoundState = getRoundState();
    assert.strictEqual(finalRoundState['4'].winner, 'crew_1_buccaneers');

    console.log('✅ Authoritative Concurrency-Safe Submission & Slot Claiming Engine verified successfully!');
  } finally {
    saveRiddleBank(initialRiddleBank);
    saveTournamentAssignments(initialAssignments);
    saveRoundState(initialRoundState);
    fs.writeFileSync(teamsPath, JSON.stringify(initialTeams, null, 2), 'utf8');
    server.close();
  }
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
