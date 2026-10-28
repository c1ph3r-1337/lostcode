const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const projectDir = path.join(__dirname, '..');
const masterJsonPath = path.join(projectDir, 'lost_code_master.json');
const riddleBankPath = path.join(projectDir, 'private', 'riddle_bank.json');
const tournamentAssignmentsPath = path.join(projectDir, 'private', 'tournament_assignments.json');
const flagsPath = path.join(projectDir, 'private', 'flags.json');
const teamsPath = path.join(projectDir, 'teams.json');

console.log('Loading master riddles from:', masterJsonPath);
const masterRiddles = JSON.parse(fs.readFileSync(masterJsonPath, 'utf8'));

// 1. Build Riddle Bank
const riddleBank = {};

const roundNameMap = {
  1: 'Round 1: Setting Sail',
  2: 'Round 2: High Seas',
  3: "Round 3: Dead Man's Creek",
  4: 'Round 4: Treasure Island'
};

masterRiddles.forEach(item => {
  let targetRound = 1;
  if (item.round === 'Round 2' || item.round === '2') targetRound = 2;
  else if (item.round === 'Round 3' || item.round === '3') targetRound = 3;
  else if (item.round === 'Round 4' || item.round === '4') targetRound = 4;

  riddleBank[item.id] = {
    id: item.id,
    title: item.subtitle || item.id,
    text: item.text,
    expectedAnswer: item.password,
    targetRound: targetRound,
    status: 'published',
    points: 100,
    answerMatchingRule: {
      caseSensitive: false,
      trim: true
    },
    hints: [
      {
        text: item.hint || 'No hint available.',
        cost: 0
      }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
});

fs.writeFileSync(riddleBankPath, JSON.stringify(riddleBank, null, 2), 'utf8');
console.log(`[PASS] Wrote ${Object.keys(riddleBank).length} riddles to riddle_bank.json`);

// 2. Build Tournament Assignments
const tournamentAssignments = {
  rounds: {
    "1": {
      roundNumber: 1,
      name: "Round 1: Setting Sail",
      startingTeams: 10,
      advancingTeams: 10,
      eliminations: 0,
      slots: [
        { slotId: "R1_S1", riddleId: "riddle_r1_1", assignedTeamId: "crew_1_buccaneers" },
        { slotId: "R1_S2", riddleId: "riddle_r1_2", assignedTeamId: "crew_2_cutthroats" },
        { slotId: "R1_S3", riddleId: "riddle_r1_3", assignedTeamId: "crew_3_corsairs" },
        { slotId: "R1_S4", riddleId: "riddle_r1_4", assignedTeamId: "crew_4_krakens" },
        { slotId: "R1_S5", riddleId: "riddle_r1_5", assignedTeamId: "crew_5_scallywags" },
        { slotId: "R1_S6", riddleId: "riddle_r1_6", assignedTeamId: "crew_6_privateers" },
        { slotId: "R1_S7", riddleId: "riddle_r1_7", assignedTeamId: "crew_7_blackflags" },
        { slotId: "R1_S8", riddleId: "riddle_r1_8", assignedTeamId: "crew_8_plunderers" },
        { slotId: "R1_S9", riddleId: "riddle_r1_9", assignedTeamId: "crew_9_dreadsails" },
        { slotId: "R1_S10", riddleId: "riddle_r1_10", assignedTeamId: "crew_10_searavens" }
      ]
    },
    "2": {
      roundNumber: 2,
      name: "Round 2: High Seas",
      startingTeams: 10,
      advancingTeams: 6,
      eliminations: 4,
      groups: {
        A: {
          groupName: "Group A",
          teams: [
            "crew_1_buccaneers",
            "crew_3_corsairs",
            "crew_5_scallywags",
            "crew_7_blackflags",
            "crew_9_dreadsails"
          ],
          slots: [
            {
              slotId: "R2_GA_S1",
              riddleId: "riddle_r2_g1_1",
              eligibleTeams: [
                "crew_1_buccaneers",
                "crew_3_corsairs",
                "crew_5_scallywags",
                "crew_7_blackflags",
                "crew_9_dreadsails"
              ]
            },
            {
              slotId: "R2_GA_S2",
              riddleId: "riddle_r2_g1_2",
              eligibleTeams: [
                "crew_1_buccaneers",
                "crew_3_corsairs",
                "crew_5_scallywags",
                "crew_7_blackflags",
                "crew_9_dreadsails"
              ]
            },
            {
              slotId: "R2_GA_S3",
              riddleId: "riddle_r2_g1_3",
              eligibleTeams: [
                "crew_1_buccaneers",
                "crew_3_corsairs",
                "crew_5_scallywags",
                "crew_7_blackflags",
                "crew_9_dreadsails"
              ]
            }
          ]
        },
        B: {
          groupName: "Group B",
          teams: [
            "crew_2_cutthroats",
            "crew_4_krakens",
            "crew_6_privateers",
            "crew_8_plunderers",
            "crew_10_searavens"
          ],
          slots: [
            {
              slotId: "R2_GB_S1",
              riddleId: "riddle_r2_g2_1",
              eligibleTeams: [
                "crew_2_cutthroats",
                "crew_4_krakens",
                "crew_6_privateers",
                "crew_8_plunderers",
                "crew_10_searavens"
              ]
            },
            {
              slotId: "R2_GB_S2",
              riddleId: "riddle_r2_g2_2",
              eligibleTeams: [
                "crew_2_cutthroats",
                "crew_4_krakens",
                "crew_6_privateers",
                "crew_8_plunderers",
                "crew_10_searavens"
              ]
            },
            {
              slotId: "R2_GB_S3",
              riddleId: "riddle_r2_g2_3",
              eligibleTeams: [
                "crew_2_cutthroats",
                "crew_4_krakens",
                "crew_6_privateers",
                "crew_8_plunderers",
                "crew_10_searavens"
              ]
            }
          ]
        }
      }
    },
    "3": {
      roundNumber: 3,
      name: "Round 3: Dead Man's Creek",
      startingTeams: 6,
      advancingTeams: 2,
      eliminations: 4,
      groups: {
        A: {
          groupName: "Group A",
          teams: [
            "crew_1_buccaneers",
            "crew_3_corsairs",
            "crew_5_scallywags"
          ],
          slots: [
            {
              slotId: "R3_GA_S1",
              riddleId: "riddle_r3_g1_1",
              eligibleTeams: [
                "crew_1_buccaneers",
                "crew_3_corsairs",
                "crew_5_scallywags",
                "crew_7_blackflags",
                "crew_9_dreadsails"
              ]
            }
          ]
        },
        B: {
          groupName: "Group B",
          teams: [
            "crew_2_cutthroats",
            "crew_4_krakens",
            "crew_6_privateers"
          ],
          slots: [
            {
              slotId: "R3_GB_S1",
              riddleId: "riddle_r3_g2_1",
              eligibleTeams: [
                "crew_2_cutthroats",
                "crew_4_krakens",
                "crew_6_privateers",
                "crew_8_plunderers",
                "crew_10_searavens"
              ]
            }
          ]
        }
      }
    },
    "4": {
      roundNumber: 4,
      name: "Round 4: Treasure Island",
      startingTeams: 2,
      advancingTeams: 1,
      eliminations: 1,
      teams: [],
      slots: [
        {
          slotId: "R4_S1",
          riddleId: "riddle_r4_s1",
          eligibleTeams: [
            "crew_1_buccaneers",
            "crew_3_corsairs",
            "crew_5_scallywags",
            "crew_7_blackflags",
            "crew_9_dreadsails"
          ]
        },
        {
          slotId: "R4_S2",
          riddleId: "riddle_r4_s2",
          eligibleTeams: [
            "crew_2_cutthroats",
            "crew_4_krakens",
            "crew_6_privateers",
            "crew_8_plunderers",
            "crew_10_searavens"
          ]
        }
      ]
    }
  }
};

fs.writeFileSync(tournamentAssignmentsPath, JSON.stringify(tournamentAssignments, null, 2), 'utf8');
console.log('[PASS] Wrote new tournament assignments to tournament_assignments.json');

// 3. Build Flags JSON (for backwards-compatibility & search fallback)
const flagsData = {};
Object.keys(riddleBank).forEach((key, index) => {
  const r = riddleBank[key];
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(r.expectedAnswer, salt);

  flagsData[key] = {
    round: r.targetRound,
    roundName: roundNameMap[r.targetRound] || `Round ${r.targetRound}`,
    riddleNumber: (index % 10) + 1,
    category: key,
    subtitle: r.title,
    difficulty: r.targetRound === 1 ? 'EASY' : (r.targetRound === 2 ? 'MEDIUM' : 'HARD'),
    points: 100,
    text: r.text,
    hint: r.hints[0] ? r.hints[0].text : '',
    hash: hash
  };
});
fs.writeFileSync(flagsPath, JSON.stringify(flagsData, null, 2), 'utf8');
console.log(`[PASS] Wrote ${Object.keys(flagsData).length} flags to flags.json`);

// 4. Update Teams JSON pre-allocated riddles
if (fs.existsSync(teamsPath)) {
  const teams = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
  const teamAllocations = {
    "BUCCANEERS": { "1": "riddle_r1_1", "2": "riddle_r2_g1_1", "3": "riddle_r3_g1_1", "4": "riddle_r4_s1" },
    "CUTTHROATS": { "1": "riddle_r1_2", "2": "riddle_r2_g2_1", "3": "riddle_r3_g2_1", "4": "riddle_r4_s2" },
    "CORSAIRS": { "1": "riddle_r1_3", "2": "riddle_r2_g1_2", "3": "riddle_r3_g1_1", "4": "riddle_r4_s1" },
    "KRAKENS": { "1": "riddle_r1_4", "2": "riddle_r2_g2_2", "3": "riddle_r3_g2_1", "4": "riddle_r4_s2" },
    "SCALLYWAGS": { "1": "riddle_r1_5", "2": "riddle_r2_g1_3", "3": "riddle_r3_g1_1", "4": "riddle_r4_s1" },
    "PRIVATEERS": { "1": "riddle_r1_6", "2": "riddle_r2_g2_3", "3": "riddle_r3_g2_1", "4": "riddle_r4_s2" },
    "BLACKFLAGS": { "1": "riddle_r1_7", "2": "riddle_r2_g1_1", "3": "riddle_r3_g1_1", "4": "riddle_r4_s1" },
    "PLUNDERERS": { "1": "riddle_r1_8", "2": "riddle_r2_g2_1", "3": "riddle_r3_g2_1", "4": "riddle_r4_s2" },
    "DREADSAILS": { "1": "riddle_r1_9", "2": "riddle_r2_g1_2", "3": "riddle_r3_g1_1", "4": "riddle_r4_s1" },
    "SEARAVENS": { "1": "riddle_r1_10", "2": "riddle_r2_g2_2", "3": "riddle_r3_g2_1", "4": "riddle_r4_s2" }
  };

  teams.forEach(team => {
    if (team.teamName === 'admin@lostcode') return;
    const nameUpper = team.teamName.toUpperCase();
    if (teamAllocations[nameUpper]) {
      team.allocatedRiddles = teamAllocations[nameUpper];
    }
  });

  fs.writeFileSync(teamsPath, JSON.stringify(teams, null, 2), 'utf8');
  console.log('[PASS] Updated teams.json with allocated riddles');
}

// 5. Update Canonical Default Credentials
const credentialsPath = path.join(projectDir, 'private', 'credentials.json');
const usersPath = path.join(projectDir, 'users.json');

const DEFAULT_TOURNAMENT_CREDENTIALS = {
  generatedAt: new Date().toISOString(),
  admin: {
    username: 'admin@lostcode',
    password: 'adm_xxcfyXMs'
  },
  teams: {
    BUCCANEERS: 'buccaneers_YkBk8b',
    CUTTHROATS: 'cutthroats_yZzjNq',
    CORSAIRS: 'corsairs_29kN79',
    KRAKENS: 'krakens_t5m6Ss',
    SCALLYWAGS: 'scallywags_mt6mvg',
    PRIVATEERS: 'privateers_JQcpxD',
    BLACKFLAGS: 'blackflags_QYsYa8',
    PLUNDERERS: 'plunderers_bddktL',
    DREADSAILS: 'dreadsails_QD5UDh',
    SEARAVENS: 'searavens_JusYnr'
  }
};

fs.writeFileSync(credentialsPath, JSON.stringify(DEFAULT_TOURNAMENT_CREDENTIALS, null, 2), 'utf8');
console.log('[PASS] Wrote default credentials to credentials.json');

if (fs.existsSync(teamsPath)) {
  const teams = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
  teams.forEach(t => {
    if (t.id === 'team_admin_1' || t.teamName === 'admin@lostcode') {
      t.password = bcrypt.hashSync(DEFAULT_TOURNAMENT_CREDENTIALS.admin.password, 10);
    } else {
      const pw = DEFAULT_TOURNAMENT_CREDENTIALS.teams[(t.teamName || '').toUpperCase()];
      if (pw) t.password = bcrypt.hashSync(pw, 10);
    }
  });
  fs.writeFileSync(teamsPath, JSON.stringify(teams, null, 2), 'utf8');
  console.log('[PASS] Updated teams.json with default password hashes');
}

if (fs.existsSync(usersPath)) {
  const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  users.forEach(u => {
    if (u.id === 'user_admin_1' || (u.username && u.username.toLowerCase() === 'admin@lostcode')) {
      u.password = bcrypt.hashSync(DEFAULT_TOURNAMENT_CREDENTIALS.admin.password, 10);
    } else {
      const pw = DEFAULT_TOURNAMENT_CREDENTIALS.teams[(u.username || '').toUpperCase()];
      if (pw) u.password = bcrypt.hashSync(pw, 10);
    }
  });
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf8');
  console.log('[PASS] Updated users.json with default password hashes');
}

console.log('\n🎉 ALL MASTER ROUNDS AND RIDDLES INTEGRATED SUCCESSFULLY!');
