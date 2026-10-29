const assert = require('assert');
const fs = require('fs');
const path = require('path');

const baseUrl = 'http://127.0.0.1:3000';

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
  console.log('=== Running Open Password & Dynamic Funnel Verification Suite ===\n');

  // Load credentials
  const credsPath = path.join(__dirname, '../private/credentials.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

  const adminCookie = await login('admin@lostcode', creds.admin.password);
  console.log('[PASS] Admin authenticated.');

  // Clear all submissions to ensure clean baseline
  const clearRes = await fetch(`${baseUrl}/api/admin/submissions/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ teamId: 'ALL' })
  });
  const clearData = await clearRes.json();
  assert.strictEqual(clearData.success, true);
  console.log('[PASS] Clean starting slate established via Admin submissions clear.');

  // Activate Round 1 & Start Tournament
  const actRes = await fetch(`${baseUrl}/api/admin/rounds/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ round: 1 })
  });
  const actData = await actRes.json();
  assert.strictEqual(actRes.status, 200, `Round 1 activation failed: ${JSON.stringify(actData)}`);

  const startRes = await fetch(`${baseUrl}/api/admin/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie }
  });
  assert.strictEqual(startRes.status, 200, 'Tournament start failed');
  console.log('[PASS] Round 1 activated & Tournament timer started.');

  // 1. Participant View: Verify NO hints, NO leaked riddles on island card
  const bfPassword = creds.teams['BLACKFLAGS']?.password || creds.teams['BLACKFLAGS'];
  const bfCookie = await login('BLACKFLAGS', bfPassword);

  const bfChalRes = await fetch(`${baseUrl}/api/team/challenge?round=1`, {
    headers: { 'Cookie': bfCookie }
  });
  const bfChal = await bfChalRes.json();
  assert.strictEqual(bfChal.success, true);
  assert.strictEqual(bfChal.riddle.hasHint, false, 'hasHint must be false');
  assert.strictEqual(bfChal.riddle.hint, null, 'hint must be null');
  assert.ok(bfChal.riddle.text.includes('physical realm'), 'Atmospheric placeholder text must be displayed');
  assert.strictEqual(bfChal.riddle.expectedAnswer, undefined, 'No expectedAnswer leaked');
  console.log('[PASS] Participant challenge screen is clean (no hints, no leaked riddle text).');

  // 2. Open Password Acceptance: Any team can submit ANY valid round password
  // Crew 1 (BUCCANEERS) submits chit R1-02: lostcode{router}
  const bPassword = creds.teams['BUCCANEERS']?.password || creds.teams['BUCCANEERS'];
  const bCookie = await login('BUCCANEERS', bPassword);

  const bSubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': bCookie },
    body: JSON.stringify({ answer: 'lostcode{router}', round: 1 })
  });
  const bSub = await bSubRes.json();
  assert.strictEqual(bSub.success, true, 'BUCCANEERS submit lostcode{router} should succeed');
  assert.strictEqual(bSub.qualified, true, 'BUCCANEERS should qualify for Round 2');
  console.log('[PASS] BUCCANEERS submitted open password lostcode{router} and qualified.');

  // 3. Single-Claim Policy: Another crew submitting lostcode{router} must be rejected
  const cPassword = creds.teams['CUTTHROATS']?.password || creds.teams['CUTTHROATS'];
  const cCookie = await login('CUTTHROATS', cPassword);

  const cDupSubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cCookie },
    body: JSON.stringify({ answer: 'lostcode{router}', round: 1 })
  });
  const cDupSub = await cDupSubRes.json();
  assert.strictEqual(cDupSub.success, false, 'Duplicate password claim must be rejected');
  assert.ok(cDupSub.message.includes('Treasure claimed'), `Expected treasure claimed message, got: ${cDupSub.message}`);
  console.log('[PASS] Single-claim policy enforced: CUTTHROATS duplicate submission rejected.');

  // CUTTHROATS submits chit R1-01: lostcode{fire_alarm}
  const cValidSubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cCookie },
    body: JSON.stringify({ answer: 'lostcode{fire_alarm}', round: 1 })
  });
  const cValidSub = await cValidSubRes.json();
  assert.strictEqual(cValidSub.success, true, 'CUTTHROATS submit lostcode{fire_alarm} should succeed');
  assert.strictEqual(cValidSub.qualified, true);
  console.log('[PASS] CUTTHROATS submitted distinct password lostcode{fire_alarm} and qualified.');

  // 4. Funnel Cutoff: 4 more crews submit distinct passwords (Total 6 solvers)
  const solvers = [
    { name: 'CORSAIRS', pass: 'lostcode{pc}' },
    { name: 'KRAKENS', pass: 'lostcode{hdmi}' },
    { name: 'SCALLYWAGS', pass: 'lostcode{dice}' },
    { name: 'PRIVATEERS', pass: 'lostcode{view_indian_flag}' }
  ];

  for (const s of solvers) {
    const sPassword = creds.teams[s.name]?.password || creds.teams[s.name];
    const sCookie = await login(s.name, sPassword);
    const sRes = await fetch(`${baseUrl}/api/team/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': sCookie },
      body: JSON.stringify({ answer: s.pass, round: 1 })
    });
    const sData = await sRes.json();
    assert.strictEqual(sData.success, true, `${s.name} submit ${s.pass} failed`);
  }
  console.log('[PASS] Top 6 crews successfully solved Round 1 and claimed Round 2 spots.');

  // 5. Auto-Elimination: Remaining 4 crews should be automatically eliminated
  const statusRes = await fetch(`${baseUrl}/api/tournament/status`, {
    headers: { 'Cookie': adminCookie }
  });
  const status = await statusRes.json();

  const outpacedTeams = ['BLACKFLAGS', 'PLUNDERERS', 'DREADSAILS', 'SEARAVENS'];
  outpacedTeams.forEach(name => {
    const t = status.teams.find(x => x.teamName === name);
    assert.ok(t, `Team ${name} found in status`);
    assert.strictEqual(t.eliminated, true, `Team ${name} should be eliminated after 6th solve`);
    assert.strictEqual(t.eliminatedRound, 1, `Team ${name} eliminated round should be 1`);
  });
  console.log('[PASS] Remaining 4 crews automatically walked the plank after 6th qualification.');

  // 6. Eliminated crew attempting to submit is rejected
  const bfLateSubRes = await fetch(`${baseUrl}/api/team/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': bfCookie },
    body: JSON.stringify({ answer: 'lostcode{white_board}', round: 1 })
  });
  assert.strictEqual(bfLateSubRes.status, 403, 'Eliminated crew submission must return 403');
  console.log('[PASS] Eliminated crew submission rejected with 403 Forbidden.');

  // 7. Verify Admin Submissions Clear / Reset
  const resetRes = await fetch(`${baseUrl}/api/admin/submissions/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ teamId: 'ALL' })
  });
  const resetData = await resetRes.json();
  assert.strictEqual(resetData.success, true);

  const postResetStatusRes = await fetch(`${baseUrl}/api/tournament/status`, {
    headers: { 'Cookie': adminCookie }
  });
  const postResetStatus = await postResetStatusRes.json();
  postResetStatus.teams.forEach(t => {
    assert.strictEqual(t.currentRound, 1, `${t.teamName} currentRound should be 1`);
    assert.strictEqual(t.eliminated, false, `${t.teamName} eliminated should be false`);
    assert.strictEqual(t.disqualified, false, `${t.teamName} disqualified should be false`);
    assert.strictEqual(t.score, 0, `${t.teamName} score should be 0`);
  });
  console.log('[PASS] Admin Submissions Clear restored all 10 crews to pristine un-eliminated Round 1 state.');

  console.log('\n✅ ALL OPEN PASSWORD & DYNAMIC FUNNEL TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
