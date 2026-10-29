const assert = require('assert');
const fs = require('fs');
const path = require('path');

const baseUrl = 'http://localhost:3000';

async function login(username, password) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamName: username, password })
  });
  assert.strictEqual(res.status, 200, `Login failed for ${username}`);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, `No cookie received for ${username}`);
  return cookie;
}

async function run() {
  console.log('=== Running Hybrid Expected Answer & Open Pool Verification Suite ===\n');

  // Load credentials
  const credsPath = path.join(__dirname, '../private/credentials.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

  const adminCookie = await login('admin@lostcode', creds.admin.password);
  console.log('[PASS] Admin authenticated.');

  // Reset submissions to clean slate
  const clearRes = await fetch(`${baseUrl}/api/admin/submissions/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ teamId: 'ALL' })
  });
  assert.strictEqual(clearRes.status, 200);
  console.log('[PASS] Clean starting slate established via Admin submissions clear.');

  // Activate Round 1 & Start Tournament
  const actRes = await fetch(`${baseUrl}/api/admin/rounds/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ round: 1 })
  });
  assert.strictEqual(actRes.status, 200, 'Round 1 activation failed');

  const startRes = await fetch(`${baseUrl}/api/admin/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie }
  });
  assert.strictEqual(startRes.status, 200, 'Tournament start failed');
  console.log('[PASS] Round 1 activated & Tournament started.');

  // =========================================================================
  // 1. ROUND 1: Assigned Expected Answer Test
  // =========================================================================
  console.log('\n--- Testing Round 1: Strict Assigned Expected Answer ---');
  const bPassword = creds.teams['BUCCANEERS']?.password || creds.teams['BUCCANEERS'];
  const bCookie = await login('BUCCANEERS', bPassword);

  // Check Round 1 challenge view: should display assigned riddle title & text
  const bChalRes = await fetch(`${baseUrl}/api/team/challenge?round=1`, {
    headers: { 'Cookie': bCookie }
  });
  const bChal = await bChalRes.json();
  assert.strictEqual(bChal.success, true);
  assert.strictEqual(bChal.riddle.title, 'The Silent Guardian', 'BUCCANEERS must receive assigned riddle title');
  assert.ok(bChal.riddle.text.includes('binary signal'), 'BUCCANEERS must receive assigned riddle text');
  assert.strictEqual(bChal.riddle.expectedAnswer, undefined, 'expectedAnswer must not be leaked');
  console.log('[PASS] BUCCANEERS challenge view contains assigned riddle "The Silent Guardian".');

  // Buccaneer attempts to submit Cutthroat\'s flag (lostcode{router})
  const bWrongSubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': bCookie },
    body: JSON.stringify({ answer: 'lostcode{router}', round: 1 })
  });
  const bWrongSub = await bWrongSubRes.json();
  assert.strictEqual(bWrongSub.success, false, 'Submitting unassigned flag in Round 1 must fail');
  assert.ok(bWrongSub.message.includes('does not match your crew\'s assigned riddle'),
    `Expected unassigned flag message, got: ${bWrongSub.message}`);
  console.log('[PASS] BUCCANEERS submission of another crew\'s flag rejected in Round 1.');

  // Buccaneer submits their own assigned flag (lostcode{fire_alarm})
  const bCorrectSubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': bCookie },
    body: JSON.stringify({ answer: 'lostcode{fire_alarm}', round: 1 })
  });
  const bCorrectSub = await bCorrectSubRes.json();
  assert.strictEqual(bCorrectSub.success, true, 'BUCCANEERS assigned flag must succeed');
  assert.strictEqual(bCorrectSub.qualified, true, 'BUCCANEERS must qualify for Round 2');
  console.log('[PASS] BUCCANEERS submitted their assigned flag lostcode{fire_alarm} and qualified.');

  // 5 more crews submit their own assigned flags to reach 6 qualifiers
  const round1AssignedSolvers = [
    { name: 'CUTTHROATS', pass: 'lostcode{router}' },
    { name: 'CORSAIRS', pass: 'lostcode{pc}' },
    { name: 'KRAKENS', pass: 'lostcode{hdmi}' },
    { name: 'SCALLYWAGS', pass: 'lostcode{dice}' },
    { name: 'PRIVATEERS', pass: 'lostcode{view_indian_flag}' }
  ];

  for (const s of round1AssignedSolvers) {
    const sPw = creds.teams[s.name]?.password || creds.teams[s.name];
    const sCookie = await login(s.name, sPw);
    const sRes = await fetch(`${baseUrl}/api/team/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': sCookie },
      body: JSON.stringify({ answer: s.pass, round: 1 })
    });
    const sData = await sRes.json();
    assert.strictEqual(sData.success, true, `${s.name} submit ${s.pass} failed`);
    assert.strictEqual(sData.qualified, true);
  }
  console.log('[PASS] 6 crews correctly solved their assigned Round 1 riddles.');

  // Verify remaining 4 crews are auto-eliminated
  const r1StatusRes = await fetch(`${baseUrl}/api/tournament/status`, {
    headers: { 'Cookie': adminCookie }
  });
  const r1Status = await r1StatusRes.json();
  const outpacedTeams = ['BLACKFLAGS', 'PLUNDERERS', 'DREADSAILS', 'SEARAVENS'];
  outpacedTeams.forEach(name => {
    const t = r1Status.teams.find(x => x.teamName === name);
    assert.strictEqual(t.eliminated, true, `${name} should be eliminated`);
    assert.strictEqual(t.eliminatedRound, 1);
  });
  console.log('[PASS] Remaining 4 crews auto-eliminated in Round 1.');

  // =========================================================================
  // 2. ROUND 2: Open Round-Wise Pool (No Pre-Assigned Expected Answer)
  // =========================================================================
  console.log('\n--- Testing Round 2: Open Round-Wise Pool ---');

  // Activate Round 2
  const actR2Res = await fetch(`${baseUrl}/api/admin/rounds/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ round: 2 })
  });
  assert.strictEqual(actR2Res.status, 200, 'Round 2 activation failed');
  console.log('[PASS] Round 2 activated to Live.');

  // Check Round 2 challenge view: should display atmospheric open-hunt placeholder
  const bR2ChalRes = await fetch(`${baseUrl}/api/team/challenge?round=2`, {
    headers: { 'Cookie': bCookie }
  });
  const bR2Chal = await bR2ChalRes.json();
  assert.strictEqual(bR2Chal.success, true);
  assert.ok(bR2Chal.riddle.text.includes('physical realm'), 'Round 2 must display open-hunt placeholder');
  console.log('[PASS] Round 2 displays atmospheric open-hunt placeholder.');

  // Crew 1 (BUCCANEERS) submits ANY Round 2 flag from the pool: lostcode{pipelines_in_hole}
  const bR2SubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': bCookie },
    body: JSON.stringify({ answer: 'lostcode{pipelines_in_hole}', round: 2 })
  });
  const bR2Sub = await bR2SubRes.json();
  assert.strictEqual(bR2Sub.success, true, 'BUCCANEERS open Round 2 submission should succeed');
  assert.strictEqual(bR2Sub.qualified, true);
  console.log('[PASS] BUCCANEERS submitted open Round 2 flag lostcode{pipelines_in_hole} and qualified.');

  // Crew 2 (CUTTHROATS) attempts to submit the already-claimed lostcode{pipelines_in_hole}
  const cPw = creds.teams['CUTTHROATS']?.password || creds.teams['CUTTHROATS'];
  const cCookie = await login('CUTTHROATS', cPw);
  const cDupR2SubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cCookie },
    body: JSON.stringify({ answer: 'lostcode{pipelines_in_hole}', round: 2 })
  });
  const cDupR2Sub = await cDupR2SubRes.json();
  assert.strictEqual(cDupR2Sub.success, false, 'Duplicate password claim in Round 2 must be rejected');
  assert.ok(cDupR2Sub.message.includes('Treasure claimed'), `Expected treasure claimed message, got: ${cDupR2Sub.message}`);
  console.log('[PASS] Single-claim policy enforced in Round 2: duplicate claim rejected.');

  // CUTTHROATS submits another valid Round 2 flag: lostcode{bulletin_board}
  const cValidR2SubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cCookie },
    body: JSON.stringify({ answer: 'lostcode{bulletin_board}', round: 2 })
  });
  const cValidR2Sub = await cValidR2SubRes.json();
  assert.strictEqual(cValidR2Sub.success, true, 'CUTTHROATS valid Round 2 flag must succeed');
  assert.strictEqual(cValidR2Sub.qualified, true);
  console.log('[PASS] CUTTHROATS submitted distinct Round 2 flag lostcode{bulletin_board} and qualified.');

  // Check Round 2 cutoff: 2 teams qualified (BUCCANEERS, CUTTHROATS), remaining 4 in R2 eliminated
  const r2StatusRes = await fetch(`${baseUrl}/api/tournament/status`, {
    headers: { 'Cookie': adminCookie }
  });
  const r2Status = await r2StatusRes.json();
  const r2Eliminated = ['CORSAIRS', 'KRAKENS', 'SCALLYWAGS', 'PRIVATEERS'];
  r2Eliminated.forEach(name => {
    const t = r2Status.teams.find(x => x.teamName === name);
    assert.strictEqual(t.eliminated, true, `${name} should be eliminated in Round 2`);
    assert.strictEqual(t.eliminatedRound, 2);
  });
  console.log('[PASS] Remaining 4 crews auto-eliminated in Round 2 after 2nd qualification.');

  // =========================================================================
  // 3. ROUND 3: Open Pool Semifinals (Both Advance)
  // =========================================================================
  console.log('\n--- Testing Round 3: Semifinals Open Pool ---');
  const actR3Res = await fetch(`${baseUrl}/api/admin/rounds/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ round: 3 })
  });
  assert.strictEqual(actR3Res.status, 200);

  // BUCCANEERS submits lostcode{motherboard}
  const bR3Sub = await (await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': bCookie },
    body: JSON.stringify({ answer: 'lostcode{motherboard}', round: 3 })
  })).json();
  assert.strictEqual(bR3Sub.success, true);

  // CUTTHROATS submits lostcode{lastrack}
  const cR3Sub = await (await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cCookie },
    body: JSON.stringify({ answer: 'lostcode{lastrack}', round: 3 })
  })).json();
  assert.strictEqual(cR3Sub.success, true);
  console.log('[PASS] Both semifinalists solved Round 3 open pool and advanced to Round 4.');

  // =========================================================================
  // 4. ROUND 4: Championship Showdown
  // =========================================================================
  console.log('\n--- Testing Round 4: Grand Championship Showdown ---');
  const actR4Res = await fetch(`${baseUrl}/api/admin/rounds/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ round: 4 })
  });
  assert.strictEqual(actR4Res.status, 200);

  // BUCCANEERS submits winning flag: lostcode{libraryengineering}
  const bR4Sub = await (await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': bCookie },
    body: JSON.stringify({ answer: 'lostcode{libraryengineering}', round: 4 })
  })).json();
  assert.strictEqual(bR4Sub.success, true);
  assert.strictEqual(bR4Sub.isWinner, true, 'BUCCANEERS must be crowned Champion');
  console.log('[PASS] BUCCANEERS solved Round 4 first and won the Championship!');

  // Check runner-up CUTTHROATS is eliminated
  const r4StatusRes = await fetch(`${baseUrl}/api/tournament/status`, {
    headers: { 'Cookie': adminCookie }
  });
  const r4Status = await r4StatusRes.json();
  const bucTeam = r4Status.teams.find(t => t.teamName === 'BUCCANEERS');
  const cutTeam = r4Status.teams.find(t => t.teamName === 'CUTTHROATS');
  assert.strictEqual(bucTeam.isWinner, true);
  assert.strictEqual(cutTeam.eliminated, true);
  assert.strictEqual(cutTeam.eliminatedRound, 4);
  console.log('[PASS] Tournament completed: Champion crowned and runner-up eliminated.');

  // Clean reset to pristine condition
  await fetch(`${baseUrl}/api/admin/submissions/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ teamId: 'ALL' })
  });
  console.log('[PASS] Submissions reset to clean starting condition.');

  console.log('\n✅ ALL HYBRID EXPECTED ANSWER & OPEN POOL TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
