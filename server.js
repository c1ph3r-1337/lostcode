const crypto = require('crypto');
const path = require("path");
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const downloadsDir = path.join(__dirname, 'public', 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, downloadsDir) },
  filename: function (req, file, cb) {
    const safeCat = (req.body.category || 'misc').replace(/[^a-zA-Z0-9]/g, '');
    cb(null, safeCat + '_' + Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9.]/g, ''));
  }
});
const upload = multer({ storage: storage });

const bcrypt = require('bcrypt');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());


app.use(express.urlencoded({ extended: false }));

// Set up session middleware
app.use(session({
  store: new FileStore({ path: './sessions', logFn: function(){} }),
  secret: 'someRandomSecretKey',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// Load Config
const configFilePath = path.join(__dirname, 'private', 'config.json');
let ctfConfig = { ctfStartTime: null, unlockedRounds: [1] };
if (fs.existsSync(configFilePath)) {
  ctfConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
} else {
  fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));
}
if (!Array.isArray(ctfConfig.unlockedRounds)) {
  ctfConfig.unlockedRounds = [1];
}
if (!ctfConfig.roundDurations || typeof ctfConfig.roundDurations !== 'object') {
  ctfConfig.roundDurations = { "1": 30, "2": 25, "3": 20, "4": 15 };
}
if (ctfConfig.fullscreenEnforced === undefined) {
  ctfConfig.fullscreenEnforced = true;
}

// -----------------------
// Tournament Engine Persistence Helpers
// -----------------------
const riddleBankFilePath = path.join(__dirname, 'private', 'riddle_bank.json');
const tournamentAssignmentsFilePath = path.join(__dirname, 'private', 'tournament_assignments.json');
const roundStateFilePath = path.join(__dirname, 'private', 'round_state.json');
const auditLogFilePath = path.join(__dirname, 'private', 'audit_log.json');
const credentialsFilePath = path.join(__dirname, 'private', 'credentials.json');

function generateRandomPassword(length = 8, prefix = '') {
  const charset = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(length);
  let res = prefix;
  for (let i = 0; i < length; i++) {
    res += charset[bytes[i] % charset.length];
  }
  return res;
}

const DEFAULT_TOURNAMENT_CREDENTIALS = {
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

function restoreDefaultTournamentCredentials() {
  const creds = {
    generatedAt: new Date().toISOString(),
    admin: {
      username: DEFAULT_TOURNAMENT_CREDENTIALS.admin.username,
      password: DEFAULT_TOURNAMENT_CREDENTIALS.admin.password
    },
    teams: { ...DEFAULT_TOURNAMENT_CREDENTIALS.teams }
  };
  saveCredentials(creds);

  // Update teams in-memory and on disk
  teams.forEach(t => {
    if (isAdminTeam(t)) {
      t.password = bcrypt.hashSync(creds.admin.password, 10);
    } else {
      const pw = creds.teams[(t.teamName || '').toUpperCase()];
      if (pw) t.password = bcrypt.hashSync(pw, 10);
    }
  });

  // Update users in-memory and on disk
  users.forEach(u => {
    if (u.id === 'user_admin_1' || (u.username && u.username.toLowerCase() === 'admin@lostcode')) {
      u.password = bcrypt.hashSync(creds.admin.password, 10);
    } else {
      const pw = creds.teams[(u.username || '').toUpperCase()];
      if (pw) u.password = bcrypt.hashSync(pw, 10);
    }
  });

  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
  } catch (e) {}

  return creds;
}

function generateTournamentCredentials(existingCreds = null) {
  const crewNames = [
    "BUCCANEERS",
    "CUTTHROATS",
    "CORSAIRS",
    "KRAKENS",
    "SCALLYWAGS",
    "PRIVATEERS",
    "BLACKFLAGS",
    "PLUNDERERS",
    "DREADSAILS",
    "SEARAVENS"
  ];

  const adminPw = (existingCreds && existingCreds.admin && existingCreds.admin.password)
    ? existingCreds.admin.password
    : generateRandomPassword(8, 'adm_');

  const teamCreds = {};
  crewNames.forEach(name => {
    teamCreds[name] = generateRandomPassword(6, `${name.toLowerCase()}_`);
  });

  const creds = {
    generatedAt: new Date().toISOString(),
    admin: {
      username: 'admin@lostcode',
      password: adminPw
    },
    teams: teamCreds
  };

  saveCredentials(creds);
  return creds;
}

function getCredentials() {
  if (fs.existsSync(credentialsFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(credentialsFilePath, 'utf8'));
    } catch (e) {
      console.error("Error reading credentials.json:", e);
    }
  }
  return generateTournamentCredentials();
}

function saveCredentials(data) {
  atomicWriteJsonSync(credentialsFilePath, data);
}

function atomicWriteJsonSync(filePath, data) {
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function getRiddleBank() {
  if (!fs.existsSync(riddleBankFilePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(riddleBankFilePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveRiddleBank(data) {
  atomicWriteJsonSync(riddleBankFilePath, data);
}

function reconcileTournamentAssignmentsWithTeams(assignments) {
  if (!assignments || !assignments.rounds || !Array.isArray(teams)) return assignments;
  let changed = false;

  // Round 1 check
  const r1 = assignments.rounds['1'];
  if (r1 && Array.isArray(r1.slots)) {
    r1.slots.forEach(slot => {
      if (slot.claimed) {
        const team = teams.find(t => t.id === slot.assignedTeamId || t.id === slot.claimedBy);
        const hasSolved = team && team.roundSolves && team.roundSolves['1'];
        if (!hasSolved) {
          delete slot.claimed;
          delete slot.claimedBy;
          delete slot.claimedAt;
          changed = true;
        }
      }
    });
  }

  // Round 2 check
  const r2 = assignments.rounds['2'];
  if (r2 && r2.groups) {
    Object.keys(r2.groups).forEach(g => {
      const slots = r2.groups[g]?.slots;
      if (Array.isArray(slots)) {
        slots.forEach(slot => {
          if (slot.claimed) {
            const team = teams.find(t => t.id === slot.claimedBy);
            const hasSolved = team && team.roundSolves && team.roundSolves['2'];
            if (!hasSolved) {
              delete slot.claimed;
              delete slot.claimedBy;
              delete slot.claimedAt;
              changed = true;
            }
          }
        });
      }
    });
  }

  // Round 3 check
  const r3 = assignments.rounds['3'];
  if (r3 && r3.groups) {
    Object.keys(r3.groups).forEach(g => {
      const slots = r3.groups[g]?.slots;
      if (Array.isArray(slots)) {
        slots.forEach(slot => {
          if (slot.claimed) {
            const team = teams.find(t => t.id === slot.claimedBy);
            const hasSolved = team && team.roundSolves && team.roundSolves['3'];
            if (!hasSolved) {
              delete slot.claimed;
              delete slot.claimedBy;
              delete slot.claimedAt;
              changed = true;
            }
          }
        });
      }
    });
  }

  // Round 4 check
  const r4 = assignments.rounds['4'];
  if (r4 && Array.isArray(r4.slots)) {
    r4.slots.forEach(slot => {
      if (slot.claimed) {
        const team = teams.find(t => t.id === slot.claimedBy);
        const hasSolved = team && team.roundSolves && team.roundSolves['4'];
        if (!hasSolved) {
          delete slot.claimed;
          delete slot.claimedBy;
          delete slot.claimedAt;
          changed = true;
        }
      }
    });
  }

  if (changed) {
    try {
      atomicWriteJsonSync(tournamentAssignmentsFilePath, assignments);
    } catch (e) {}
  }
  return assignments;
}

function getTournamentAssignments() {
  if (!fs.existsSync(tournamentAssignmentsFilePath)) return { rounds: {} };
  try {
    const data = JSON.parse(fs.readFileSync(tournamentAssignmentsFilePath, 'utf8'));
    return reconcileTournamentAssignmentsWithTeams(data);
  } catch (e) {
    return { rounds: {} };
  }
}

function saveTournamentAssignments(data) {
  atomicWriteJsonSync(tournamentAssignmentsFilePath, data);
}

function getRoundState() {
  if (!fs.existsSync(roundStateFilePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(roundStateFilePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveRoundState(data) {
  atomicWriteJsonSync(roundStateFilePath, data);
}

function getConfig() {
  return ctfConfig;
}

function saveConfig(data) {
  ctfConfig = data;
  atomicWriteJsonSync(configFilePath, data);
}

function logAuditEvent(event) {
  let log = [];
  if (fs.existsSync(auditLogFilePath)) {
    try {
      log = JSON.parse(fs.readFileSync(auditLogFilePath, 'utf8'));
    } catch (e) {
      log = [];
    }
  }
  const entry = {
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...event
  };
  log.unshift(entry);
  atomicWriteJsonSync(auditLogFilePath, log);
  return entry;
}

function findTeamSlotInRound(assignments, roundNum, teamId) {
  const roundKey = String(roundNum);
  const roundData = assignments.rounds && assignments.rounds[roundKey];
  if (!roundData) return null;

  if (roundNum === 1) {
    const slots = roundData.slots || [];
    return slots.find(s => s.assignedTeamId === teamId) || null;
  }

  if (roundNum === 2 || roundNum === 3) {
    const groups = roundData.groups || {};
    for (const gKey of ['A', 'B']) {
      const group = groups[gKey];
      if (!group) continue;
      const teamObj = teams.find(t => t.id === teamId);
      const teamGroup = teamObj ? (teamObj.groupRound3 || teamObj.groupRound2) : null;
      const isTeamInGroup = (Array.isArray(group.teams) && group.teams.includes(teamId)) || (teamGroup === gKey);
      if (isTeamInGroup) {
        const slots = group.slots || [];
        const teamAllocatedRiddle = (teamObj && teamObj.allocatedRiddles && teamObj.allocatedRiddles[roundKey]) || null;

        // 1. If team already claimed a slot, return that claimed slot
        let slot = slots.find(s => s.claimedBy === teamId);
        if (slot) return { ...slot, groupId: gKey };

        // 2. Explicit team assignment
        slot = slots.find(s => s.assignedTeamId === teamId);
        if (slot) return { ...slot, groupId: gKey };

        // 3. If no explicit assignedTeamId, find first unclaimed slot team is eligible for
        slot = slots.find(s => Array.isArray(s.eligibleTeams) && s.eligibleTeams.includes(teamId) && !s.claimed);
        if (!slot) {
          slot = slots.find(s => !s.claimed);
        }
        // 4. Fallback to any slot team is eligible for (even if claimed)
        if (!slot) {
          slot = slots.find(s => Array.isArray(s.eligibleTeams) && s.eligibleTeams.includes(teamId));
        }
        // 5. Fallback to first slot
        if (!slot) {
          slot = slots[0] || null;
        }
        if (slot) {
          return { ...slot, groupId: gKey };
        }
      }
    }
    return null;
  }

  if (roundNum === 4) {
    const slots = roundData.slots || [];
    if (slots.length === 0) return null;
    const teamObj = teams.find(t => t.id === teamId);
    const grp = teamObj ? (teamObj.groupRound3 || teamObj.groupRound2) : null;
    const targetSlot = (grp === 'B' && slots[1]) ? slots[1] : slots[0];
    return { ...targetSlot };
  }

  return null;
}

// -----------------------
// Individual Crew Round Timing Model
// -----------------------
function getTeamRoundTimer(team, rKey) {
  if (!team) return null;
  if (!team.roundTimers) team.roundTimers = {};
  const roundState = getRoundState();
  const rState = roundState[rKey] || { status: 'Locked' };
  const isRoundLive = rState.status === 'Live';
  const duration = (ctfConfig.roundDurations && ctfConfig.roundDurations[rKey]) || (rKey === '1' ? 30 : (rKey === '2' ? 25 : (rKey === '3' ? 20 : 15)));
  
  if (!team.roundTimers[rKey]) {
    team.roundTimers[rKey] = {
      startedAt: null,
      durationMinutes: duration,
      hintPenaltiesMinutes: 0,
      bonusMinutes: 0,
      solved: false,
      solvedAt: null,
      finalSolveSeconds: null
    };
  }

  const tState = team.roundTimers[rKey];
  const durMin = tState.durationMinutes || duration;
  const allocatedSec = durMin * 60;
  const penaltySec = (tState.hintPenaltiesMinutes || 0) * 60;
  const bonusSec = (tState.bonusMinutes || 0) * 60;

  const roundSolveEntry = team.roundSolves && team.roundSolves[rKey] && (team.roundSolves[rKey].completed || typeof team.roundSolves[rKey] === 'string')
    ? team.roundSolves[rKey]
    : null;

  if (roundSolveEntry && !tState.solved) {
    tState.solved = true;
    if (!tState.solvedAt && roundSolveEntry.solvedAt) {
      tState.solvedAt = new Date(roundSolveEntry.solvedAt).getTime() || Date.now();
    }
    if (!tState.finalSolveSeconds && roundSolveEntry.solveTimeSeconds) {
      tState.finalSolveSeconds = roundSolveEntry.solveTimeSeconds;
    }
  }

  if (tState.solved && tState.solvedAt) {
    const elapsedSec = Math.max(0, Math.floor((tState.solvedAt - (tState.startedAt || tState.solvedAt)) / 1000));
    return {
      startedAt: tState.startedAt,
      durationMinutes: durMin,
      hintPenaltiesMinutes: tState.hintPenaltiesMinutes || 0,
      penaltyMinutes: tState.hintPenaltiesMinutes || 0,
      bonusMinutes: tState.bonusMinutes || 0,
      solved: true,
      solvedAt: tState.solvedAt,
      elapsedSeconds: elapsedSec,
      remainingSeconds: Math.max(0, allocatedSec + bonusSec - penaltySec - elapsedSec),
      solveTimeSeconds: tState.finalSolveSeconds || Math.max(0, elapsedSec + penaltySec - bonusSec),
      isReady: false,
      isLive: false
    };
  }

  // If round is NOT live or team has not started this round yet:
  // Timer is in READY state, full duration remaining, NOT expired!
  // CRITICAL REQUIREMENT:
  // "the timer of 1st roudn should only start after i start the tournamment and for other rounds after i activate the round"
  const isRound1TimerRunning = (rKey === '1') && Boolean(ctfConfig.ctfStartTime) && isRoundLive && Boolean(tState.startedAt);
  const isOtherRoundTimerRunning = (rKey !== '1') && isRoundLive && Boolean(tState.startedAt);

  if (!isRound1TimerRunning && !isOtherRoundTimerRunning) {
    return {
      startedAt: null,
      durationMinutes: durMin,
      hintPenaltiesMinutes: tState.hintPenaltiesMinutes || 0,
      penaltyMinutes: tState.hintPenaltiesMinutes || 0,
      bonusMinutes: tState.bonusMinutes || 0,
      solved: false,
      solvedAt: null,
      elapsedSeconds: 0,
      remainingSeconds: allocatedSec,
      solveTimeSeconds: null,
      isReady: true,
      isLive: false
    };
  }

  // Round IS live and team timer has started
  const elapsedSec = Math.max(0, Math.floor((Date.now() - tState.startedAt) / 1000));
  const remainingSec = Math.max(0, allocatedSec + bonusSec - penaltySec - elapsedSec);

  return {
    startedAt: tState.startedAt,
    durationMinutes: durMin,
    hintPenaltiesMinutes: tState.hintPenaltiesMinutes || 0,
    penaltyMinutes: tState.hintPenaltiesMinutes || 0,
    bonusMinutes: tState.bonusMinutes || 0,
    solved: false,
    solvedAt: null,
    elapsedSeconds: elapsedSec,
    remainingSeconds: remainingSec,
    solveTimeSeconds: null,
    isReady: false,
    isLive: remainingSec > 0
  };
}

// -----------------------
// Server-Side Tournament Heartbeat Service & Auto-Disqualification Engine
// -----------------------
function checkTeamExpiryAndDisqualify(team, rKey) {
  if (!team || isAdminTeam(team) || team.eliminated || team.disqualified || team.isWinner) return false;
  const roundState = getRoundState();
  const curR = rKey ? String(rKey) : String(team.currentRound || 1);
  const rState = roundState[curR] || { status: 'Locked' };
  const isRoundLive = rState.status === 'Live';

  const isRound1TimerRunning = (curR === '1') && Boolean(ctfConfig.ctfStartTime) && isRoundLive && Boolean(team.roundTimers?.[curR]?.startedAt);
  const isOtherRoundTimerRunning = (curR !== '1') && isRoundLive && Boolean(team.roundTimers?.[curR]?.startedAt);

  if (!isRound1TimerRunning && !isOtherRoundTimerRunning) return false;

  const tTimer = getTeamRoundTimer(team, curR);
  if (!tTimer || tTimer.solved) return false;

  if (tTimer.remainingSeconds <= 0) {
    team.disqualified = true;
    team.disqualifiedAt = Date.now();
    team.disqualifiedReason = `Round ${curR} timer expired (00:00)! Your crew was out of time and has been defaulted.`;
    return true;
  }
  return false;
}

let _heartbeatInterval = null;
function startTournamentHeartbeatService() {
  if (_heartbeatInterval) clearInterval(_heartbeatInterval);
  _heartbeatInterval = setInterval(() => {
    try {
      let teamsChanged = false;
      const disqualifiedCrews = [];

      teams.forEach(team => {
        const curR = String(team.currentRound || 1);
        if (checkTeamExpiryAndDisqualify(team, curR)) {
          teamsChanged = true;
          disqualifiedCrews.push({
            teamId: team.id,
            teamName: team.teamName,
            reason: team.disqualifiedReason
          });
        }
      });

      if (teamsChanged) {
        try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}
        disqualifiedCrews.forEach(info => {
          console.log(`[AUTO-DISQUALIFIED] ${info.teamName}: ${info.reason}`);
          io.emit('team:disqualified', info);
        });
        io.emit('teamsUpdate');
        io.emit('tournamentUpdate');
      }
    } catch (err) {
      console.error("Error in tournamentHeartbeatService:", err);
    }
  }, 1000);
}

function stopTournamentHeartbeatService() {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

// -----------------------
// Private Participant Challenge Endpoint (Strict Privacy Enforced)
// -----------------------
app.get('/api/team/challenge', (req, res) => {
  const team = getCurrentTeam(req);
  if (!team) {
    return res.status(401).json({ error: 'Authentication required. Please board your ship.' });
  }

  const requestedRound = parseInt(req.query.round, 10);
  const roundNum = (!isNaN(requestedRound) && requestedRound >= 1 && requestedRound <= 4)
    ? requestedRound
    : (team.currentRound || 1);

  // Check if active timer has expired
  if (checkTeamExpiryAndDisqualify(team, String(roundNum))) {
    try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}
    io.emit('team:disqualified', {
      teamId: team.id,
      teamName: team.teamName,
      reason: team.disqualifiedReason
    });
    io.emit('teamsUpdate');
    io.emit('tournamentUpdate');
  }

  if (team.disqualified) {
    return res.status(403).json({
      success: false,
      isDisqualified: true,
      error: team.disqualifiedReason || 'Your crew has been disqualified due to proctoring violations.',
      reason: team.disqualifiedReason || 'Your crew has been disqualified due to proctoring violations.',
      riddle: null
    });
  }

  const curRound = team.currentRound || 1;
  const roundState = getRoundState();
  const currentRoundState = roundState[String(roundNum)] || { status: 'Locked' };
  const roundStatus = currentRoundState.status || 'Locked';

  // "fro those who have not solved the round 1 but the round 2 is already activated fro them they should see 'complete the round 1 for unlocking the round 2' and same for the other rounds"
  if (!isAdminSession(req) && roundNum > curRound) {
    const prevRound = roundNum - 1;
    return res.json({
      success: false,
      round: roundNum,
      roundStatus,
      isLockedPrereq: true,
      message: `Complete the round ${prevRound} for unlocking the round ${roundNum}`,
      riddle: null
    });
  }

  if (team.eliminated) {
    return res.json({
      success: false,
      round: roundNum,
      roundStatus,
      isEliminated: true,
      eliminatedRound: team.eliminatedRound,
      message: `Your crew was marooned in Round ${team.eliminatedRound || roundNum}. Ye cannot participate in active challenges.`,
      riddle: null
    });
  }

  const assignments = getTournamentAssignments();
  const slot = findTeamSlotInRound(assignments, roundNum, team.id);
  const solveRecord = team.roundSolves && team.roundSolves[String(roundNum)];
  const isQualified = !!(currentRoundState.qualifiers || []).includes(team.id);
  const isAlreadySolved = !!(
    (solveRecord && (solveRecord.completed || typeof solveRecord === 'string')) ||
    (isQualified && (solveRecord || roundStatus === 'Completed'))
  );

  const timerInfo = getTeamRoundTimer(team, String(roundNum));

  const roundTitles = {
    1: 'Round 1: Setting Sail',
    2: 'Round 2: High Seas',
    3: "Round 3: Dead Man's Creek",
    4: 'Round 4: Treasure Island'
  };

  // If already solved, return clean completed view with solved answer
  if (isAlreadySolved) {
    const solvedAns = (typeof solveRecord === 'object' && solveRecord?.answer) ? solveRecord.answer : 'Flag Salvaged';
    return res.json({
      success: true,
      round: roundNum,
      slotId: solveRecord?.slotId || null,
      riddle: {
        id: `island_r${roundNum}`,
        title: roundTitles[roundNum] || `Round ${roundNum} Island`,
        text: 'Physical relic salvaged! Your crew has secured this island and claimed the bounty.',
        hasHint: false,
        hint: null,
        hintUnlocked: false
      },
      roundStatus,
      isSolved: true,
      isQualified: true,
      isClaimed: true,
      solvedAnswer: solvedAns,
      timer: timerInfo,
      message: 'Island cleared! Your crew has claimed this island\'s treasure.'
    });
  }

  if (roundStatus !== 'Live') {
    return res.json({
      success: false,
      round: roundNum,
      roundStatus,
      isEliminated: false,
      isQualified: false,
      timer: timerInfo,
      message: `Waters uncharted: Round ${roundNum} is currently ${roundStatus}.`,
      riddle: null
    });
  }

  // For Round 1: Return team's assigned riddle ("same as before to have expected answer")
  // For Rounds 2, 3, 4: Open pool with atmospheric placeholder
  let participantIslandRiddle;
  if (roundNum === 1) {
    const riddleBank = getRiddleBank();
    const assignedRiddleId = slot?.riddleId || (team.allocatedRiddles && team.allocatedRiddles['1']);
    const assignedRiddle = assignedRiddleId ? riddleBank[assignedRiddleId] : null;
    if (assignedRiddle) {
      participantIslandRiddle = {
        id: assignedRiddle.id,
        title: assignedRiddle.title,
        text: assignedRiddle.text,
        points: assignedRiddle.points || 100,
        hasHint: false,
        hint: null,
        hintUnlocked: false
      };
    }
  }

  if (!participantIslandRiddle) {
    participantIslandRiddle = {
      id: slot?.riddleId || `island_r${roundNum}`,
      title: roundTitles[roundNum] || `Island ${roundNum}`,
      text: 'The physical realm holds the salvaged secrets of this island. Search the venue coordinates for hidden chits, decode the paper clues, and submit your retrieved password below.',
      hasHint: false,
      hint: null,
      hintUnlocked: false,
      points: 100
    };
  }

  return res.json({
    success: true,
    round: roundNum,
    slotId: slot ? slot.slotId : null,
    riddle: participantIslandRiddle,
    roundStatus,
    timer: timerInfo,
    isClaimed: false,
    isQualified: false,
    isEliminated: false,
    message: 'Explore the venue coordinates and enter the salvaged flag to claim this island.'
  });
});

// -----------------------
// Authoritative Concurrency-Safe Submission & Slot Claiming Engine
// -----------------------
function checkAnswerMatch(submitted, expected, rule) {
  if (!submitted || !expected) return false;
  let s = String(submitted);
  let e = String(expected);
  const trim = (rule && rule.trim !== undefined) ? rule.trim : true;
  const caseSensitive = (rule && rule.caseSensitive !== undefined) ? rule.caseSensitive : false;
  
  if (trim) {
    s = s.trim();
    e = e.trim();
  }
  if (!caseSensitive) {
    s = s.toLowerCase();
    e = e.toLowerCase();
  }
  if (s === e) return true;

  // Flexible wrapper normalization for lostcode{...} and lost_code{...}
  const unwrap = (str) => {
    const m = str.match(/^(?:lostcode|lost_code)\{(.*)\}$/i);
    return m ? m[1].trim() : str;
  };
  const uS = unwrap(s);
  const uE = unwrap(e);
  if (uS === uE) return true;

  // Space, hyphen, and underscore tolerance: normalize sequences of spaces/hyphens/underscores
  const norm = (str) => str.replace(/[\s\-_]+/g, '_').toLowerCase();
  return norm(uS) === norm(uE);
}

app.post('/api/team/submit', (req, res) => {
  const team = getCurrentTeam(req);
  if (!team) {
    return res.status(401).json({ error: 'Authentication required. Please board your ship.' });
  }

  if (team.disqualified) {
    return res.status(403).json({
      error: team.disqualifiedReason || 'Your crew has been disqualified and cannot submit flags.',
      reason: team.disqualifiedReason || 'Your crew has been disqualified and cannot submit flags.'
    });
  }

  const { answer, round } = req.body || {};
  if (!answer || typeof answer !== 'string' || !answer.trim()) {
    return res.status(400).json({ error: 'Flag or answer cannot be empty.' });
  }

  const requestedRound = parseInt(round, 10);
  const roundNum = (!isNaN(requestedRound) && requestedRound >= 1 && requestedRound <= 4)
    ? requestedRound
    : (team.currentRound || 1);

  const roundState = getRoundState();
  const currentRoundState = roundState[String(roundNum)];
  if (currentRoundState && currentRoundState.status === 'Completed') {
    return res.status(400).json({
      error: `Round ${roundNum} is not currently Live (Status: Completed).`
    });
  }

  if (team.eliminated) {
    return res.status(403).json({
      error: `Your crew was marooned in Round ${team.eliminatedRound || 'previous'} and cannot submit flags.`
    });
  }

  // Check if round timer has expired
  if (checkTeamExpiryAndDisqualify(team, String(roundNum))) {
    try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}
    io.emit('team:disqualified', {
      teamId: team.id,
      teamName: team.teamName,
      reason: team.disqualifiedReason
    });
    io.emit('teamsUpdate');
    io.emit('tournamentUpdate');
    return res.status(403).json({
      error: team.disqualifiedReason || `Round ${roundNum} timer has expired! Your crew has been defaulted.`
    });
  }

  const curRound = team.currentRound || 1;
  if (!isAdminSession(req) && roundNum > curRound) {
    return res.status(400).json({
      error: `Complete the round ${roundNum - 1} for unlocking the round ${roundNum}`
    });
  }

  if (!currentRoundState || currentRoundState.status !== 'Live') {
    return res.status(400).json({
      error: `Round ${roundNum} is not currently Live (Status: ${currentRoundState?.status || 'Locked'}).`
    });
  }

  const existingSolve = team.roundSolves && team.roundSolves[String(roundNum)];
  if ((existingSolve && existingSolve.completed) || (Array.isArray(currentRoundState.qualifiers) && currentRoundState.qualifiers.includes(team.id))) {
    return res.status(400).json({
      error: `Your crew has already secured qualification for Round ${roundNum}!`
    });
  }

  const assignments = getTournamentAssignments();
  const group = (roundNum >= 3 ? team.groupRound3 : team.groupRound2) || 'A';
  const riddleBank = getRiddleBank();

  // 1. Funnel Capacity Checks
  if (roundNum === 1) {
    const r1Solvers = teams.filter(t => !isAdminTeam(t) && t.roundSolves && t.roundSolves['1']);
    if (r1Solvers.length >= 6) {
      team.eliminated = true;
      team.eliminatedRound = 1;
      team.eliminatedAt = Date.now();
      team.eliminatedReason = 'Walked the Plank in Round 1: All 6 qualifying spots for Round 2 have already been claimed! Your crew was outpaced.';
      try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}
      io.emit('teamsUpdate');
      io.emit('tournamentUpdate');
      return res.json({
        success: false,
        message: 'Treasure claimed! All 6 qualifying spots for Round 2 have already been claimed! Your crew was outpaced and has Walked the Plank.',
        qualified: false,
        eliminated: true
      });
    }
  } else if (roundNum === 2) {
    const r2Solvers = teams.filter(t => !isAdminTeam(t) && t.roundSolves && t.roundSolves['2']);
    if (r2Solvers.length >= 2) {
      team.eliminated = true;
      team.eliminatedRound = 2;
      team.eliminatedAt = Date.now();
      team.eliminatedReason = 'Walked the Plank in Round 2: Top 2 qualifying spots for Round 3 have already been claimed! Your crew was outpaced.';
      try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}
      io.emit('teamsUpdate');
      io.emit('tournamentUpdate');
      return res.json({
        success: false,
        message: 'Treasure claimed! Top 2 qualifying spots for Round 3 have already been claimed! Your crew has Walked the Plank.',
        qualified: false,
        eliminated: true
      });
    }
  }

  // 2. Submission Matching:
  // For Round 1: Strict team-specific assigned expected answer ("same as before to have expected answer")
  // For Rounds 2, 3, 4: Open pool ("no expected answer, any right answer can be filled by any team round wise")
  let matchedRiddle = null;

  if (roundNum === 1) {
    const slot = findTeamSlotInRound(assignments, 1, team.id);
    const assignedRiddleId = slot?.riddleId || (team.allocatedRiddles && team.allocatedRiddles['1']);
    const assignedRiddle = assignedRiddleId ? riddleBank[assignedRiddleId] : null;

    if (!assignedRiddle) {
      return res.status(400).json({
        success: false,
        message: 'No assigned riddle found for your crew in Round 1.',
        qualified: false
      });
    }

    if (!checkAnswerMatch(answer, assignedRiddle.expectedAnswer, assignedRiddle.answerMatchingRule)) {
      return res.json({
        success: false,
        message: "Avast! That flag does not match your crew's assigned riddle for Round 1. Check your coordinates and try again.",
        qualified: false
      });
    }
    matchedRiddle = assignedRiddle;
  } else {
    // Rounds 2, 3, 4: Open pool
    const roundPool = Object.values(riddleBank).filter(r => String(r.targetRound) === String(roundNum) && r.status === 'published');
    for (const rObj of roundPool) {
      if (checkAnswerMatch(answer, rObj.expectedAnswer, rObj.answerMatchingRule)) {
        matchedRiddle = rObj;
        break;
      }
    }

    if (!matchedRiddle) {
      return res.json({
        success: false,
        message: `Avast! That flag be incorrect for Round ${roundNum}. Check your coordinates and try again.`,
        qualified: false
      });
    }

    // 3. Single-Claim Check for open rounds: Has another crew already claimed this exact password/riddle in this round?
    const alreadyClaimedTeam = teams.find(t => !isAdminTeam(t) && t.id !== team.id && t.roundSolves && t.roundSolves[String(roundNum)]?.riddleId === matchedRiddle.id);
    if (alreadyClaimedTeam) {
      return res.json({
        success: false,
        message: 'Treasure claimed! Another crew claimed this relic seconds before ye. Search for another hidden clue!',
        qualified: false
      });
    }
  }

  // 4. Synchronously claim slot in persistent tournament assignments
  const claimTime = new Date().toISOString();
  let claimedSlotId = `R${roundNum}_S_CLAIMED`;

  let targetSlot = null;
  if (roundNum === 1) {
    targetSlot = (assignments.rounds['1']?.slots || []).find(s => s.riddleId === matchedRiddle.id);
  } else if (roundNum === 2) {
    targetSlot = (assignments.rounds['2']?.slots || []).find(s => s.riddleId === matchedRiddle.id)
      || (assignments.rounds['2']?.groups?.A?.slots || []).find(s => s.riddleId === matchedRiddle.id)
      || (assignments.rounds['2']?.groups?.B?.slots || []).find(s => s.riddleId === matchedRiddle.id);
  } else if (roundNum === 3) {
    targetSlot = (assignments.rounds['3']?.slots || []).find(s => s.riddleId === matchedRiddle.id)
      || (assignments.rounds['3']?.groups?.A?.slots || []).find(s => s.riddleId === matchedRiddle.id)
      || (assignments.rounds['3']?.groups?.B?.slots || []).find(s => s.riddleId === matchedRiddle.id);
  } else if (roundNum === 4) {
    targetSlot = (assignments.rounds['4']?.slots || []).find(s => s.riddleId === matchedRiddle.id);
  }

  if (targetSlot) {
    targetSlot.claimed = true;
    targetSlot.claimedBy = team.id;
    targetSlot.claimedAt = claimTime;
    claimedSlotId = targetSlot.slotId;
  }
  saveTournamentAssignments(assignments);

  // Update round state qualifiers
  if (!Array.isArray(currentRoundState.qualifiers)) {
    currentRoundState.qualifiers = [];
  }
  if (!currentRoundState.qualifiers.includes(team.id)) {
    currentRoundState.qualifiers.push(team.id);
  }

  let isWinner = false;
  if (roundNum === 4) {
    isWinner = true;
    team.isWinner = true;
    team.wonAt = claimTime;
    currentRoundState.winner = team.id;
    currentRoundState.status = 'Completed';
  }
  saveRoundState(roundState);

  // Stop crew's individual round timer and calculate solve time
  const solveTimestamp = Date.now();
  if (!team.roundTimers) team.roundTimers = {};
  if (!team.roundTimers[String(roundNum)]) {
    getTeamRoundTimer(team, String(roundNum));
  }
  if (team.roundTimers[String(roundNum)]) {
    const tTimer = team.roundTimers[String(roundNum)];
    tTimer.solved = true;
    tTimer.solvedAt = solveTimestamp;
    const elapsed = Math.max(0, Math.floor((solveTimestamp - (tTimer.startedAt || solveTimestamp)) / 1000));
    tTimer.finalSolveSeconds = elapsed + (tTimer.hintPenaltiesMinutes || 0) * 60;
  }

  if (!Array.isArray(team.solvedChallenges)) team.solvedChallenges = [];
  if (!team.solvedChallenges.includes(matchedRiddle.id)) {
    team.solvedChallenges.push(matchedRiddle.id);
  }
  if (!team.roundSolves) team.roundSolves = {};
  team.roundSolves[String(roundNum)] = {
    slotId: claimedSlotId,
    riddleId: matchedRiddle.id,
    answer: matchedRiddle.expectedAnswer,
    solvedAt: claimTime,
    completed: true,
    solveTimeSeconds: team.roundTimers[String(roundNum)]?.finalSolveSeconds || null
  };

  const pointsEarned = (typeof matchedRiddle.points === 'number' && !isNaN(matchedRiddle.points)) ? matchedRiddle.points : 100;
  team.score = (team.score || 0) + pointsEarned;
  if (!Array.isArray(team.scoreHistory)) {
    team.scoreHistory = [{ timestamp: solveTimestamp - 1000, time: new Date(solveTimestamp - 1000).toLocaleTimeString(), score: team.score - pointsEarned }];
  }
  const curCompletedCount = Object.values(team.roundSolves || {}).filter(s => s && (s.completed || typeof s === 'string')).length;
  team.scoreHistory.push({
    timestamp: solveTimestamp,
    time: new Date(solveTimestamp).toLocaleTimeString(),
    score: team.score,
    roundsCompleted: curCompletedCount
  });

  // Advance team round & unlock next round
  team.currentRound = Math.max(team.currentRound || 1, roundNum + 1);
  if (!Array.isArray(team.unlockedRounds)) team.unlockedRounds = [1];
  if (roundNum < 4 && !team.unlockedRounds.includes(roundNum + 1)) {
    team.unlockedRounds.push(roundNum + 1);
    team.unlockedRounds.sort((a, b) => a - b);
  }

  // Dynamic Funnel Cutoffs & Auto-Eliminations
  if (roundNum === 1) {
    const r1SolversCount = teams.filter(t => !isAdminTeam(t) && t.roundSolves && t.roundSolves['1']).length;
    if (r1SolversCount >= 6) {
      teams.forEach(t => {
        if (!isAdminTeam(t) && (!t.roundSolves || !t.roundSolves['1']) && !t.eliminated) {
          t.eliminated = true;
          t.eliminatedRound = 1;
          t.eliminatedAt = Date.now();
          t.eliminatedReason = 'Walked the Plank in Round 1: Top 6 spots for Round 2 have been claimed! Your crew was outpaced.';
        }
      });
    }
  } else if (roundNum === 2) {
    const r2SolversCount = teams.filter(t => !isAdminTeam(t) && t.roundSolves && t.roundSolves['2']).length;
    if (r2SolversCount >= 2) {
      teams.forEach(t => {
        if (!isAdminTeam(t) && t.currentRound === 2 && (!t.roundSolves || !t.roundSolves['2']) && !t.eliminated) {
          t.eliminated = true;
          t.eliminatedRound = 2;
          t.eliminatedAt = Date.now();
          t.eliminatedReason = 'Walked the Plank in Round 2: Top 2 spots for Round 3 Semifinals have been claimed! Your crew was outpaced.';
        }
      });
    }
  } else if (roundNum === 3) {
    // Both semifinalists advance to Round 4 upon solving
  } else if (roundNum === 4) {
    // Automatically eliminate runner-up
    teams.forEach(t => {
      if (!isAdminTeam(t) && t.id !== team.id && !t.eliminated) {
        t.eliminated = true;
        t.eliminatedRound = 4;
        t.eliminatedAt = Date.now();
        t.eliminatedReason = `Lost Code Championship: ${team.teamName} secured the final treasure first!`;
      }
    });
  }

  // Next round individual timer initialization:
  // "once the team has completed the 1 round and next island is already activated/unloacked,
  // the timer will only reset from new set timmer when the first rounded is scuessfult complted"
  if (roundNum < 4) {
    const nextRKey = String(roundNum + 1);
    const nextDur = (ctfConfig.roundDurations && ctfConfig.roundDurations[nextRKey]) || (nextRKey === '2' ? 25 : (nextRKey === '3' ? 20 : 15));
    const nextRoundState = roundState[nextRKey] || { status: 'Locked' };
    const isNextRoundLive = nextRoundState.status === 'Live';

    team.roundTimers[nextRKey] = {
      startedAt: isNextRoundLive ? solveTimestamp : null,
      durationMinutes: nextDur,
      hintPenaltiesMinutes: 0,
      bonusMinutes: 0,
      solved: false,
      solvedAt: null,
      finalSolveSeconds: null
    };
  }

  if (typeof team.score !== 'number') team.score = 0;

  fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2));

  // Real-time broadcasts
  io.emit('tournament:slot_claimed', {
    round: roundNum,
    slotId: claimedSlotId,
    teamId: team.id,
    teamName: team.teamName,
    claimedAt: claimTime
  });
  io.emit('teamsUpdate');
  io.emit('scoreboardUpdate');

  const finalSolveSec = team.roundTimers[String(roundNum)]?.finalSolveSeconds || 0;
  const mins = Math.floor(finalSolveSec / 60);
  const secs = finalSolveSec % 60;
  const timeFormatted = `${mins}m ${secs}s`;

  return res.json({
    success: true,
    message: isWinner
      ? '🏆 VICTORY! Your crew has solved the final riddle and won the Lost Code Championship!'
      : `⚓ Treasure secured! Solved in ${timeFormatted}! Qualification claimed for Round ${roundNum}!`,
    qualified: true,
    isWinner,
    slotId: claimedSlotId,
    solveTime: timeFormatted,
    solveTimeSeconds: finalSolveSec
  });
});

// -----------------------
// Admin Riddle Bank REST API
// -----------------------
app.get('/api/admin/riddle-bank', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const riddles = getRiddleBank();
  return res.json({ success: true, riddles });
});

app.post('/api/admin/riddle-bank', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });

  const { title, text, expectedAnswer, targetRound, status, answerMatchingRule, points, hints } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Riddle title or reference name is required.' });
  }

  const riddleStatus = (status === 'published') ? 'published' : 'draft';
  if (riddleStatus === 'published' && (!expectedAnswer || !String(expectedAnswer).trim())) {
    return res.status(400).json({ error: 'Published riddles must include an expected answer or flag.' });
  }

  const roundNum = parseInt(targetRound, 10) || 1;
  const id = `riddle_r${roundNum}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();

  const newRiddle = {
    id,
    title: title.trim(),
    text: text ? String(text).trim() : '',
    expectedAnswer: expectedAnswer ? String(expectedAnswer).trim() : '',
    targetRound: roundNum,
    status: riddleStatus,
    answerMatchingRule: {
      caseSensitive: !!(answerMatchingRule && answerMatchingRule.caseSensitive),
      trim: (answerMatchingRule && answerMatchingRule.trim !== undefined) ? !!answerMatchingRule.trim : true
    },
    points: parseInt(points, 10) || 100,
    hints: Array.isArray(hints) ? hints : [],
    createdAt: now,
    updatedAt: now
  };

  const riddleBank = getRiddleBank();
  riddleBank[id] = newRiddle;
  saveRiddleBank(riddleBank);

  // If published, automatically bind to first open slot in target round if round is not live
  if (riddleStatus === 'published') {
    const assignments = getTournamentAssignments();
    const roundData = assignments.rounds && assignments.rounds[String(roundNum)];
    const roundState = getRoundState();
    const isLive = roundState[String(roundNum)] && roundState[String(roundNum)].status === 'Live';
    if (roundData && !isLive) {
      if (roundNum === 1 || roundNum === 4) {
        const openSlot = (roundData.slots || []).find(s => !s.riddleId);
        if (openSlot) {
          openSlot.riddleId = id;
          saveTournamentAssignments(assignments);
        }
      } else {
        for (const g of ['A', 'B']) {
          const grp = roundData.groups && roundData.groups[g];
          const openSlot = grp && (grp.slots || []).find(s => !s.riddleId);
          if (openSlot) {
            openSlot.riddleId = id;
            saveTournamentAssignments(assignments);
            break;
          }
        }
      }
    }
  }

  return res.status(201).json({ success: true, riddle: newRiddle });
});

app.put('/api/admin/riddle-bank/:id', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  const riddleBank = getRiddleBank();
  const existing = riddleBank[id];
  if (!existing) {
    return res.status(404).json({ error: 'Riddle not found in bank.' });
  }

  const { title, text, expectedAnswer, targetRound, status, answerMatchingRule, points, hints } = req.body || {};
  if (title !== undefined && (!title || !String(title).trim())) {
    return res.status(400).json({ error: 'Riddle title cannot be empty.' });
  }

  const updatedStatus = (status !== undefined) ? status : existing.status;
  const checkAnswer = (expectedAnswer !== undefined) ? expectedAnswer : existing.expectedAnswer;
  if (updatedStatus === 'published' && (!checkAnswer || !String(checkAnswer).trim())) {
    return res.status(400).json({ error: 'Published riddles must have an expected answer.' });
  }

  if (title !== undefined) existing.title = String(title).trim();
  if (text !== undefined) existing.text = String(text).trim();
  if (expectedAnswer !== undefined) existing.expectedAnswer = String(expectedAnswer).trim();
  if (targetRound !== undefined) existing.targetRound = parseInt(targetRound, 10) || existing.targetRound;
  if (status !== undefined) existing.status = updatedStatus;
  if (points !== undefined) existing.points = parseInt(points, 10) || existing.points;
  if (hints !== undefined && Array.isArray(hints)) existing.hints = hints;
  if (answerMatchingRule !== undefined) {
    existing.answerMatchingRule = {
      caseSensitive: !!answerMatchingRule.caseSensitive,
      trim: answerMatchingRule.trim !== undefined ? !!answerMatchingRule.trim : true
    };
  }
  existing.updatedAt = new Date().toISOString();

  riddleBank[id] = existing;
  saveRiddleBank(riddleBank);

  return res.json({ success: true, riddle: existing });
});

app.delete('/api/admin/riddle-bank/:id', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  const riddleBank = getRiddleBank();
  if (!riddleBank[id]) {
    return res.status(404).json({ error: 'Riddle not found in bank.' });
  }

  // Check if assigned in a Live round
  const assignments = getTournamentAssignments();
  const roundState = getRoundState();

  for (const rKey of ['1', '2', '3', '4']) {
    if (roundState[rKey] && roundState[rKey].status === 'Live') {
      const rData = assignments.rounds && assignments.rounds[rKey];
      if (rData) {
        if (rKey === '1' || rKey === '4') {
          const inSlots = (rData.slots || []).some(s => s.riddleId === id);
          if (inSlots) {
            return res.status(400).json({ error: `Cannot delete riddle assigned to Live Round ${rKey}.` });
          }
        } else {
          for (const g of ['A', 'B']) {
            const grp = rData.groups && rData.groups[g];
            const inGrp = grp && (grp.slots || []).some(s => s.riddleId === id);
            if (inGrp) {
              return res.status(400).json({ error: `Cannot delete riddle assigned to Live Round ${rKey}.` });
            }
          }
        }
      }
    }
  }

  // Unbind from non-live slots
  for (const rKey of ['1', '2', '3', '4']) {
    const rData = assignments.rounds && assignments.rounds[rKey];
    if (rData) {
      if (rKey === '1' || rKey === '4') {
        (rData.slots || []).forEach(s => { if (s.riddleId === id) s.riddleId = null; });
      } else {
        for (const g of ['A', 'B']) {
          const grp = rData.groups && rData.groups[g];
          if (grp) (grp.slots || []).forEach(s => { if (s.riddleId === id) s.riddleId = null; });
        }
      }
    }
  }
  saveTournamentAssignments(assignments);

  delete riddleBank[id];
  saveRiddleBank(riddleBank);

  return res.json({ success: true, message: 'Riddle removed from bank.' });
});

// -----------------------
// Admin Tournament Assignment Matrix, Validation & Override Engine
// -----------------------
function validateRoundConfiguration(roundNum) {
  const rKey = String(roundNum);
  const assignments = getTournamentAssignments();
  const riddleBank = getRiddleBank();
  const roundData = assignments.rounds && assignments.rounds[rKey];
  const errors = [];
  const warnings = [];

  if (!roundData) {
    return { valid: false, errors: [`Round ${roundNum} blueprint is missing.`] };
  }

  if (roundNum === 1) {
    const slots = roundData.slots || [];
    if (slots.length !== 10) {
      errors.push(`Round 1 requires exactly 10 slots (found ${slots.length}).`);
    }
    const assignedTeams = new Set();
    const assignedRiddles = new Set();

    slots.forEach((s, idx) => {
      if (!s.assignedTeamId) {
        errors.push(`Slot ${s.slotId || idx + 1} has no assigned crew.`);
      } else {
        if (assignedTeams.has(s.assignedTeamId)) {
          errors.push(`Duplicate crew assignment: ${s.assignedTeamId} is assigned more than once.`);
        }
        assignedTeams.add(s.assignedTeamId);
      }

      if (!s.riddleId) {
        errors.push(`Slot ${s.slotId || idx + 1} has no riddle assigned.`);
      } else {
        const riddle = riddleBank[s.riddleId];
        if (!riddle) {
          errors.push(`Slot ${s.slotId} references non-existent riddle ID "${s.riddleId}".`);
        } else if (riddle.status !== 'published') {
          errors.push(`Riddle "${riddle.title || s.riddleId}" in slot ${s.slotId} is in Draft state (must be Published).`);
        } else if (!riddle.expectedAnswer || !riddle.expectedAnswer.trim()) {
          errors.push(`Riddle "${riddle.title || s.riddleId}" has no expected answer.`);
        }

        if (assignedRiddles.has(s.riddleId)) {
          errors.push(`Riddle "${s.riddleId}" is assigned to multiple teams. In Round 1, all 10 teams must receive distinct riddles.`);
        }
        assignedRiddles.add(s.riddleId);
      }
    });

    if (assignedTeams.size < 10) {
      errors.push(`All 10 official crews must be assigned (currently ${assignedTeams.size}/10).`);
    }
  } else if (roundNum === 2) {
    const groups = roundData.groups || {};
    for (const g of ['A', 'B']) {
      const grp = groups[g];
      if (!grp) {
        errors.push(`Group ${g} definition is missing in Round 2.`);
        continue;
      }
      const grpTeams = grp.teams || [];
      const r1QualifiersInGroup = teams.filter(t => !isAdminTeam(t) && t.groupRound2 === g && t.roundSolves && t.roundSolves['1']);
      if (grpTeams.length === 0 && r1QualifiersInGroup.length > 0) {
        grp.teams = r1QualifiersInGroup.map(t => t.id).slice(0, 3);
      }

      if (grpTeams.length !== 3) {
        if (grpTeams.length === 0) {
          warnings.push(`Round 2 Group ${g} awaiting Round 1 qualifiers (will auto-populate from top 6 solvers).`);
        } else {
          warnings.push(`Round 2 Group ${g} contains ${grpTeams.length} crews.`);
        }
      }
      const slots = grp.slots || [];
      if (slots.length === 0) {
        errors.push(`Round 2 Group ${g} must have qualifying slots.`);
      }
      slots.forEach((s, idx) => {
        if (!s.riddleId) {
          errors.push(`Group ${g} Slot ${s.slotId || idx + 1} has no riddle assigned.`);
        } else {
          const riddle = riddleBank[s.riddleId];
          if (!riddle || riddle.status !== 'published' || !riddle.expectedAnswer) {
            errors.push(`Group ${g} Slot ${s.slotId} riddle is missing or in Draft state.`);
          }
        }
      });
    }
  } else if (roundNum === 3) {
    const groups = roundData.groups || {};
    for (const g of ['A', 'B']) {
      const grp = groups[g];
      if (!grp) {
        errors.push(`Group ${g} definition is missing in Round 3.`);
        continue;
      }
      let teamsInGrp = grp.teams || [];
      const r2QualifiersInGroup = teams.filter(t => !isAdminTeam(t) && (t.groupRound3 || t.groupRound2) === g && t.roundSolves && t.roundSolves['2']);
      if (teamsInGrp.length === 0 && r2QualifiersInGroup.length > 0) {
        teamsInGrp = r2QualifiersInGroup.map(t => t.id).slice(0, 1);
        grp.teams = teamsInGrp;
      }

      if (teamsInGrp.length === 0) {
        warnings.push(`Round 3 Group ${g} awaiting Round 2 qualifiers (will auto-populate from top 2 solvers).`);
      }
      const slots = grp.slots || [];
      if (slots.length === 0) {
        errors.push(`Round 3 Group ${g} must have qualifying slots.`);
      }
      slots.forEach((s, idx) => {
        if (!s.riddleId) {
          errors.push(`Group ${g} Slot ${s.slotId || idx + 1} has no riddle assigned.`);
        } else {
          const riddle = riddleBank[s.riddleId];
          if (!riddle || riddle.status !== 'published' || !riddle.expectedAnswer) {
            errors.push(`Group ${g} Slot ${s.slotId} riddle is missing or in Draft state.`);
          }
        }
      });
    }
  } else if (roundNum === 4) {
    const slots = roundData.slots || [];
    if (slots.length < 1) {
      errors.push(`Round 4 requires at least 1 championship slot (found ${slots.length}).`);
    }
    slots.forEach((s, idx) => {
      if (!s || !s.riddleId) {
        errors.push(`Round 4 slot ${idx + 1} riddle has not been assigned.`);
      } else {
        const riddle = riddleBank[s.riddleId];
        if (!riddle || riddle.status !== 'published' || !riddle.expectedAnswer) {
          errors.push(`Round 4 slot ${idx + 1} (${s.riddleId}) riddle is missing or in Draft state.`);
        }
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

app.get('/api/admin/assignments', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  return res.json({
    success: true,
    assignments: getTournamentAssignments(),
    roundState: getRoundState(),
    roundDurations: ctfConfig.roundDurations || { "1": 30, "2": 25, "3": 20, "4": 15 },
    auditLog: (function() {
      try { return JSON.parse(fs.readFileSync(auditLogFilePath, 'utf8')); } catch(e) { return []; }
    })()
  });
});

app.post('/api/admin/assignments', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });

  const { round, assignments: incomingAssignments } = req.body || {};
  const roundNum = parseInt(round, 10);
  if (!roundNum || roundNum < 1 || roundNum > 4) {
    return res.status(400).json({ error: 'Invalid round number.' });
  }

  const roundState = getRoundState();
  if (roundState[String(roundNum)] && roundState[String(roundNum)].status === 'Live') {
    return res.status(400).json({
      error: `Round ${roundNum} is currently Live. Direct edits are frozen. Use administrative override with reason.`
    });
  }

  const currentAssignments = getTournamentAssignments();
  if (incomingAssignments) {
    currentAssignments.rounds[String(roundNum)] = incomingAssignments;
    saveTournamentAssignments(currentAssignments);
  }

  return res.json({
    success: true,
    message: `Round ${roundNum} assignments updated successfully.`,
    assignments: currentAssignments.rounds[String(roundNum)]
  });
});

app.post('/api/admin/assignments/assign-slot', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const { round, slotId, riddleId } = req.body || {};
  const roundNum = parseInt(round, 10);
  if (!roundNum || roundNum < 1 || roundNum > 4) {
    return res.status(400).json({ error: 'Invalid round number.' });
  }

  const roundState = getRoundState();
  if (roundState[String(roundNum)] && roundState[String(roundNum)].status === 'Live') {
    return res.status(400).json({
      error: `Round ${roundNum} is currently Live. Direct edits are frozen. Use administrative override with reason.`
    });
  }

  const assignments = getTournamentAssignments();
  const roundData = assignments.rounds && assignments.rounds[String(roundNum)];
  if (!roundData) {
    return res.status(404).json({ error: `Round ${roundNum} blueprint not found.` });
  }

  let slotFound = false;
  if (roundNum === 1 || roundNum === 4) {
    const slot = (roundData.slots || []).find(s => s.slotId === slotId);
    if (slot) {
      slot.riddleId = riddleId ? String(riddleId).trim() : null;
      slotFound = true;
    }
  } else {
    for (const g of ['A', 'B']) {
      const grp = roundData.groups && roundData.groups[g];
      if (grp) {
        const slot = (grp.slots || []).find(s => s.slotId === slotId);
        if (slot) {
          slot.riddleId = riddleId ? String(riddleId).trim() : null;
          slotFound = true;
          break;
        }
      }
    }
  }

  if (!slotFound) {
    return res.status(404).json({ error: `Slot ${slotId} not found in Round ${roundNum}.` });
  }

  saveTournamentAssignments(assignments);
  return res.json({
    success: true,
    message: `Slot ${slotId} updated.`,
    slotId,
    riddleId: riddleId || null
  });
});

app.post('/api/admin/teams/assign-riddle', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const { teamId, round, riddleId } = req.body || {};
  if (!teamId || !round || !riddleId) {
    return res.status(400).json({ error: 'teamId, round, and riddleId are required.' });
  }
  const roundNum = parseInt(round, 10);
  if (!roundNum || roundNum < 1 || roundNum > 4) {
    return res.status(400).json({ error: 'Invalid round number.' });
  }

  const targetTeam = teams.find(t => t.id === teamId || (t.teamName && t.teamName.toUpperCase() === teamId.toUpperCase()));
  if (!targetTeam) {
    return res.status(404).json({ error: `Team ${teamId} not found.` });
  }

  const riddleBank = getRiddleBank();
  if (!riddleBank[riddleId]) {
    return res.status(404).json({ error: `Riddle ${riddleId} not found in riddle bank.` });
  }

  if (!targetTeam.allocatedRiddles) targetTeam.allocatedRiddles = {};
  targetTeam.allocatedRiddles[String(roundNum)] = riddleId;

  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write teams.json' });
  }

  logAuditEvent({
    action: 'ADMIN_ASSIGN_TEAM_RIDDLE',
    admin: req.session.teamName || 'admin',
    reason: `Assigned riddle ${riddleId} to ${targetTeam.teamName} for Round ${roundNum}`,
    details: { teamId: targetTeam.id, round: roundNum, riddleId }
  });

  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');

  return res.json({
    success: true,
    message: `Assigned riddle ${riddleId} to ${targetTeam.teamName} for Round ${roundNum}.`,
    team: targetTeam
  });
});

app.post('/api/admin/rounds/validate', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const roundNum = parseInt(req.body.round, 10) || 1;
  const result = validateRoundConfiguration(roundNum);
  return res.json({
    success: true,
    round: roundNum,
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings
  });
});

app.post('/api/admin/rounds/activate', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const roundNum = parseInt(req.body.round, 10) || 1;
  const rKey = String(roundNum);

  const result = validateRoundConfiguration(roundNum);
  if (!result.valid) {
    return res.status(400).json({
      error: `Pre-launch checklist failed for Round ${roundNum}. Resolve all issues before activation.`,
      errors: result.errors
    });
  }

  const roundState = getRoundState();
  if (!roundState[rKey]) roundState[rKey] = {};
  roundState[rKey].status = 'Live';
  roundState[rKey].startedAt = new Date().toISOString();
  saveRoundState(roundState);

  // Sync unlockedRounds in ctfConfig
  if (!Array.isArray(ctfConfig.unlockedRounds)) ctfConfig.unlockedRounds = [1];
  if (!ctfConfig.unlockedRounds.includes(roundNum)) {
    ctfConfig.unlockedRounds.push(roundNum);
    ctfConfig.unlockedRounds.sort((a, b) => a - b);
    try { fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2)); } catch (e) {}
  }

  // Sync unlockedRounds and start fresh individual timers
  // "the timer of 1st roudn should only start after i start the tournamment and for other rounds after i activate the round"
  const nowTs = Date.now();
  const dur = (ctfConfig.roundDurations && ctfConfig.roundDurations[rKey]) || (rKey === '1' ? 30 : (rKey === '2' ? 25 : (rKey === '3' ? 20 : 15)));
  teams.forEach(t => {
    if (!isAdminTeam(t) && !t.eliminated) {
      if (!Array.isArray(t.unlockedRounds)) t.unlockedRounds = [1];
      if (!t.unlockedRounds.includes(roundNum)) {
        t.unlockedRounds.push(roundNum);
        t.unlockedRounds.sort((a, b) => a - b);
      }
      if (!t.roundTimers) t.roundTimers = {};

      const hasSolved = t.roundSolves && t.roundSolves[rKey] && (t.roundSolves[rKey].completed || typeof t.roundSolves[rKey] === 'string');

      if (!hasSolved) {
        if (roundNum === 1) {
          // Round 1 timer ONLY starts if tournament has been started via "Start Tournament"
          const shouldStartR1 = Boolean(ctfConfig.ctfStartTime);
          t.roundTimers[rKey] = {
            startedAt: shouldStartR1 ? nowTs : null,
            durationMinutes: dur,
            hintPenaltiesMinutes: (t.roundTimers[rKey] && t.roundTimers[rKey].hintPenaltiesMinutes) || 0,
            bonusMinutes: (t.roundTimers[rKey] && t.roundTimers[rKey].bonusMinutes) || 0,
            solved: false,
            solvedAt: null,
            finalSolveSeconds: null
          };
        } else {
          // For other rounds (R2, R3, R4):
          // Timer starts after admin activates this round FOR teams currently in this round
          if ((t.currentRound || 1) >= roundNum) {
            t.roundTimers[rKey] = {
              startedAt: nowTs,
              durationMinutes: dur,
              hintPenaltiesMinutes: (t.roundTimers[rKey] && t.roundTimers[rKey].hintPenaltiesMinutes) || 0,
              bonusMinutes: (t.roundTimers[rKey] && t.roundTimers[rKey].bonusMinutes) || 0,
              solved: false,
              solvedAt: null,
              finalSolveSeconds: null
            };
          } else {
            // Team is still in earlier round: keep timer staged in ready state
            t.roundTimers[rKey] = {
              startedAt: null,
              durationMinutes: dur,
              hintPenaltiesMinutes: (t.roundTimers[rKey] && t.roundTimers[rKey].hintPenaltiesMinutes) || 0,
              bonusMinutes: (t.roundTimers[rKey] && t.roundTimers[rKey].bonusMinutes) || 0,
              solved: false,
              solvedAt: null,
              finalSolveSeconds: null
            };
          }
        }
      }
    }
  });
  try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}

  logAuditEvent({
    action: 'ROUND_ACTIVATION',
    admin: req.session.teamName || 'admin',
    reason: `Round ${roundNum} successfully activated to Live state`,
    details: { round: roundNum }
  });

  io.emit('tournament:round_state', { round: roundNum, status: 'Live', roundState });
  io.emit('roundsUpdate', ctfConfig.unlockedRounds);
  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');

  return res.json({
    success: true,
    message: `Round ${roundNum} is now Live!`,
    roundState: roundState[rKey]
  });
});

// Admin Endpoint: Set Individual Round Duration (Timing System)
app.post('/api/admin/rounds/duration', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const { round, durationMinutes } = req.body || {};
  const roundNum = parseInt(round, 10);
  const dur = parseInt(durationMinutes, 10);
  if (!roundNum || roundNum < 1 || roundNum > 4 || !dur || dur <= 0) {
    return res.status(400).json({ error: 'Valid round (1-4) and positive durationMinutes required.' });
  }
  if (!ctfConfig.roundDurations) ctfConfig.roundDurations = {};
  ctfConfig.roundDurations[String(roundNum)] = dur;
  
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));
  } catch (err) {
    console.error('Error saving round duration:', err);
  }

  // Update ongoing timers for teams in this round that have not solved yet
  teams.forEach(t => {
    if (t.roundTimers && t.roundTimers[String(roundNum)] && !t.roundTimers[String(roundNum)].solved) {
      t.roundTimers[String(roundNum)].durationMinutes = dur;
    }
  });
  try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}

  io.emit('configUpdate', ctfConfig);
  io.emit('tournamentUpdate');
  io.emit('teamsUpdate');

  return res.json({
    success: true,
    message: `Round ${roundNum} duration updated to ${dur} minutes.`,
    roundDurations: ctfConfig.roundDurations
  });
});

app.post('/api/admin/assignments/override', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const { round, slotId, newRiddleId, newTeamId, reason } = req.body || {};

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'A valid reason is required for administrative overrides.' });
  }

  const roundNum = parseInt(round, 10);
  const rKey = String(roundNum);
  const assignments = getTournamentAssignments();
  const roundData = assignments.rounds && assignments.rounds[rKey];

  if (!roundData) {
    return res.status(404).json({ error: `Round ${roundNum} blueprint not found.` });
  }

  let slotFound = false;
  let previousState = null;

  if (roundNum === 1 || roundNum === 4) {
    const slot = (roundData.slots || []).find(s => s.slotId === slotId);
    if (slot) {
      previousState = { ...slot };
      if (newRiddleId !== undefined) slot.riddleId = newRiddleId;
      if (newTeamId !== undefined) slot.assignedTeamId = newTeamId;
      slotFound = true;
    }
  } else {
    for (const g of ['A', 'B']) {
      const grp = roundData.groups && roundData.groups[g];
      if (grp) {
        const slot = (grp.slots || []).find(s => s.slotId === slotId);
        if (slot) {
          previousState = { ...slot };
          if (newRiddleId !== undefined) slot.riddleId = newRiddleId;
          if (newTeamId !== undefined) slot.assignedTeamId = newTeamId;
          slotFound = true;
          break;
        }
      }
    }
  }

  if (!slotFound) {
    return res.status(404).json({ error: `Slot ${slotId} not found in Round ${roundNum}.` });
  }

  saveTournamentAssignments(assignments);

  logAuditEvent({
    action: 'ASSIGNMENT_OVERRIDE',
    admin: req.session.teamName || 'admin',
    reason: reason.trim(),
    details: {
      round: roundNum,
      slotId,
      previousState,
      newRiddleId,
      newTeamId
    }
  });

  return res.json({
    success: true,
    message: `Assignment override applied to ${slotId} and recorded in audit log.`
  });
});






app.get('/api/config', (req, res) => {
  res.json({
    ctfStartTime: ctfConfig.ctfStartTime,
    unlockedRounds: ctfConfig.unlockedRounds || [1],
    fullscreenEnforced: ctfConfig.fullscreenEnforced !== false,
    roundDurations: ctfConfig.roundDurations || { "1": 30, "2": 25, "3": 20, "4": 15 },
    roundState: getRoundState()
  });
});

// shortcut: stored in config.json, migrate to DB if multi-instance
app.post('/api/admin/toggle-proctoring', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const { enabled } = req.body || {};
  ctfConfig.fullscreenEnforced = enabled !== undefined ? !!enabled : !(ctfConfig.fullscreenEnforced !== false);
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));
  } catch (e) {
    console.error('Failed writing config:', e);
  }
  io.emit('configUpdate', ctfConfig);
  res.json({ success: true, fullscreenEnforced: ctfConfig.fullscreenEnforced });
});

app.post('/api/admin/rounds/toggle', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  const { round, unlocked } = req.body;
  const roundNum = parseInt(round, 10);
  if (!roundNum || roundNum < 1 || roundNum > 4) {
    return res.status(400).json({ error: 'Invalid round number (1-4).' });
  }

  ctfConfig.unlockedRounds = Array.isArray(ctfConfig.unlockedRounds) ? ctfConfig.unlockedRounds : [1];

  if (unlocked) {
    if (!ctfConfig.unlockedRounds.includes(roundNum)) {
      ctfConfig.unlockedRounds.push(roundNum);
      ctfConfig.unlockedRounds.sort((a, b) => a - b);
    }
  } else {
    ctfConfig.unlockedRounds = ctfConfig.unlockedRounds.filter(r => r !== roundNum);
  }

  fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));
  io.emit('configUpdate', ctfConfig);
  io.emit('roundsUpdate', ctfConfig.unlockedRounds);
  io.emit('challengesUpdate');

  res.json({
    message: `Round ${roundNum} ${unlocked ? 'unlocked' : 'locked'} successfully!`,
    unlockedRounds: ctfConfig.unlockedRounds
  });
});

app.post('/api/admin/start', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  
  const nowTs = Date.now();
  ctfConfig.ctfStartTime = nowTs;

  // Ensure Round 1 is activated/live
  const roundState = getRoundState();
  roundState['1'].status = 'Live';
  if (!roundState['1'].startedAt) {
    roundState['1'].startedAt = new Date(nowTs).toISOString();
  }
  saveRoundState(roundState);

  // Sync unlockedRounds in ctfConfig
  if (!Array.isArray(ctfConfig.unlockedRounds)) ctfConfig.unlockedRounds = [1];
  if (!ctfConfig.unlockedRounds.includes(1)) {
    ctfConfig.unlockedRounds.push(1);
    ctfConfig.unlockedRounds.sort((a, b) => a - b);
  }
  fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));

  // "the timer of 1st roudn should only start after i start the tournamment"
  // Start fresh Round 1 individual timer for all active crews currently in Round 1
  const r1Dur = (ctfConfig.roundDurations && ctfConfig.roundDurations['1']) || 30;
  teams.forEach(t => {
    if (!isAdminTeam(t) && !t.eliminated) {
      if (!Array.isArray(t.unlockedRounds)) t.unlockedRounds = [1];
      if (!t.unlockedRounds.includes(1)) {
        t.unlockedRounds.push(1);
      }
      if (!t.roundTimers) t.roundTimers = {};
      const hasSolvedR1 = t.roundSolves && t.roundSolves['1'] && (t.roundSolves['1'].completed || typeof t.roundSolves['1'] === 'string');
      if (!hasSolvedR1 && (t.currentRound || 1) === 1) {
        t.roundTimers['1'] = {
          startedAt: nowTs,
          durationMinutes: r1Dur,
          hintPenaltiesMinutes: (t.roundTimers['1'] && t.roundTimers['1'].hintPenaltiesMinutes) || 0,
          bonusMinutes: (t.roundTimers['1'] && t.roundTimers['1'].bonusMinutes) || 0,
          solved: false,
          solvedAt: null,
          finalSolveSeconds: null
        };
      }
    }
  });
  fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));

  io.emit('configUpdate', ctfConfig);
  io.emit('roundsUpdate', ctfConfig.unlockedRounds);
  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');
  io.emit('scoreboardUpdate');

  logAuditEvent({
    action: 'START_TOURNAMENT',
    admin: req.session.teamName || 'admin',
    reason: 'Tournament started by Admiralty. Round 1 individual timers started for active crews.',
    details: { startedAt: nowTs }
  });

  res.json({ message: 'Treasure Hunt Started! Round 1 timers are live.', config: ctfConfig });
});

app.post('/api/admin/stop', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  
  ctfConfig.ctfStartTime = null;
  fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));
  io.emit('configUpdate', ctfConfig);
  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');
  io.emit('scoreboardUpdate');
  
  res.json({ message: 'Treasure Hunt Stopped!', config: ctfConfig });
});

app.post('/api/admin/wipe', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  
  ctfConfig.ctfStartTime = null;
  fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));
  io.emit('configUpdate', ctfConfig);
  
  teams.forEach(team => {
      team.scoreHistory = [];
      team.score = 0;
      team.solvedChallenges = [];
      team.hintsUnlocked = {};
      team.currentRound = 1;
      team.unlockedRounds = [1];
      team.eliminated = false;
      team.eliminatedRound = null;
      team.eliminatedReason = null;
      team.roundSolves = {};
      team.roundTimers = {};
      team.totalHintPenaltyMinutes = 0;
      team.disqualified = false;
      team.violations = 0;
      delete team.disqualifiedAt;
      delete team.disqualifiedReason;
      team.isWinner = false;
      delete team.wonAt;
  });
  users.forEach(user => {
      user.solvedChallenges = [];
  });
  
  // Reset tournament assignments claims
  const assignments = getTournamentAssignments();
  if (assignments && assignments.rounds) {
    Object.keys(assignments.rounds).forEach(r => {
      const rd = assignments.rounds[r];
      if (Array.isArray(rd.slots)) {
        rd.slots.forEach(s => { delete s.claimed; delete s.claimedBy; delete s.claimedAt; });
      }
      if (rd.groups) {
        Object.keys(rd.groups).forEach(g => {
          if (Array.isArray(rd.groups[g].slots)) {
            rd.groups[g].slots.forEach(s => { delete s.claimed; delete s.claimedBy; delete s.claimedAt; });
          }
        });
      }
    });
    saveTournamentAssignments(assignments);
  }

  // Reset round state qualifiers & eliminations
  const roundState = getRoundState();
  Object.keys(roundState).forEach(r => {
    roundState[r].status = r === '1' ? 'Draft' : 'Locked';
    roundState[r].qualifiers = [];
    roundState[r].eliminations = [];
  });
  saveRoundState(roundState);

  fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2));
  fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(users, null, 2));
  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');
  
  res.json({ message: 'All scores, solves, and tournament rounds have been securely reset to Round 1.' });
});

// Clear test submissions / filled answers endpoint for Admiralty testing
app.post('/api/admin/submissions/clear', (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });

  const targetTeamId = req.body && req.body.teamId ? String(req.body.teamId).trim() : 'ALL';
  const targetRound = req.body && req.body.round ? parseInt(req.body.round, 10) : null;

  const targetTeams = (targetTeamId === 'ALL' || !targetTeamId)
    ? teams.filter(t => t.teamName !== 'admin@lostcode')
    : teams.filter(t => t.id === targetTeamId || t.teamName.toLowerCase() === targetTeamId.toLowerCase());

  if (targetTeams.length === 0) {
    return res.status(404).json({ error: 'No matching crew found to reset submissions.' });
  }

  const assignments = getTournamentAssignments();
  const roundState = getRoundState();
  const riddleBank = getRiddleBank();

  targetTeams.forEach(team => {
    if (targetRound && !isNaN(targetRound) && targetRound >= 1 && targetRound <= 4) {
      const strRound = String(targetRound);
      if (team.roundSolves && team.roundSolves[strRound]) {
        const solvedRiddleId = team.roundSolves[strRound].riddleId;
        if (solvedRiddleId) {
          team.solvedChallenges = (team.solvedChallenges || []).filter(c => c !== solvedRiddleId);
        }
        delete team.roundSolves[strRound];
      }
      if (team.roundTimers && team.roundTimers[strRound]) {
        team.roundTimers[strRound].solved = false;
        team.roundTimers[strRound].solvedAt = null;
        team.roundTimers[strRound].finalSolveSeconds = null;
      }
      if (assignments && assignments.rounds && assignments.rounds[strRound]) {
        const rd = assignments.rounds[strRound];
        if (Array.isArray(rd.slots)) {
          rd.slots.forEach(s => {
            if (s.claimedBy === team.id || s.assignedTeamId === team.id) {
              delete s.claimed; delete s.claimedBy; delete s.claimedAt;
            }
          });
        }
        if (rd.groups) {
          Object.keys(rd.groups).forEach(g => {
            if (Array.isArray(rd.groups[g].slots)) {
              rd.groups[g].slots.forEach(s => {
                if (s.claimedBy === team.id) {
                  delete s.claimed; delete s.claimedBy; delete s.claimedAt;
                }
              });
            }
          });
        }
      }
      if (roundState[strRound] && Array.isArray(roundState[strRound].qualifiers)) {
        roundState[strRound].qualifiers = roundState[strRound].qualifiers.filter(id => id !== team.id);
      }
      team.currentRound = Math.min(team.currentRound || 1, targetRound);
      team.unlockedRounds = (team.unlockedRounds || [1]).filter(r => r <= targetRound);
    } else {
      team.solvedChallenges = [];
      team.roundSolves = {};
      team.score = 0;
      team.scoreHistory = [];
      team.hintsUnlocked = {};
      team.totalHintPenaltyMinutes = 0;
      team.currentRound = 1;
      team.unlockedRounds = [1];
      team.eliminated = false;
      team.eliminatedRound = null;
      team.eliminatedReason = null;
      team.disqualified = false;
      team.disqualifiedAt = null;
      team.disqualifiedReason = null;
      team.violations = 0;
      team.isWinner = false;
      delete team.wonAt;

      if (team.roundTimers) {
        Object.keys(team.roundTimers).forEach(r => {
          team.roundTimers[r].solved = false;
          team.roundTimers[r].solvedAt = null;
          team.roundTimers[r].finalSolveSeconds = null;
          team.roundTimers[r].hintPenaltiesMinutes = 0;
        });
      }

      if (assignments && assignments.rounds) {
        Object.keys(assignments.rounds).forEach(r => {
          const rd = assignments.rounds[r];
          if (Array.isArray(rd.slots)) {
            rd.slots.forEach(s => {
              if (s.claimedBy === team.id) {
                delete s.claimed; delete s.claimedBy; delete s.claimedAt;
              }
            });
          }
          if (rd.groups) {
            Object.keys(rd.groups).forEach(g => {
              if (Array.isArray(rd.groups[g].slots)) {
                rd.groups[g].slots.forEach(s => {
                  if (s.claimedBy === team.id) {
                    delete s.claimed; delete s.claimedBy; delete s.claimedAt;
                  }
                });
              }
            });
          }
        });
      }

      Object.keys(roundState).forEach(r => {
        if (Array.isArray(roundState[r].qualifiers)) {
          roundState[r].qualifiers = roundState[r].qualifiers.filter(id => id !== team.id);
        }
        if (Array.isArray(roundState[r].eliminations)) {
          roundState[r].eliminations = roundState[r].eliminations.filter(id => id !== team.id);
        }
      });
    }

    const matchedUser = users.find(u => (u.username || '').toLowerCase() === team.teamName.toLowerCase());
    if (matchedUser) {
      matchedUser.solvedChallenges = team.solvedChallenges || [];
    }
  });

  const allSolvesMap = {};
  teams.forEach(t => {
    (t.solvedChallenges || []).forEach(rId => {
      allSolvesMap[rId] = (allSolvesMap[rId] || 0) + 1;
    });
  });

  Object.keys(riddleBank).forEach(rId => {
    riddleBank[rId].solves = allSolvesMap[rId] || 0;
  });
  saveRiddleBank(riddleBank);

  const flagsFilePath = path.join(__dirname, 'private', 'flags.json');
  if (fs.existsSync(flagsFilePath)) {
    try {
      const flagsData = JSON.parse(fs.readFileSync(flagsFilePath, 'utf8'));
      Object.keys(flagsData).forEach(rId => {
        flagsData[rId].solves = allSolvesMap[rId] || 0;
      });
      atomicWriteJsonSync(flagsFilePath, flagsData);
    } catch(e) {}
  }

  saveTournamentAssignments(assignments);
  saveRoundState(roundState);

  try { fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2)); } catch(e){}
  try { fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(users, null, 2)); } catch(e){}

  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');
  io.emit('scoreboardUpdate');

  logAuditEvent({
    action: 'CLEAR_TEST_SUBMISSIONS',
    admin: req.session.teamName || 'admin',
    reason: `Cleared submitted answers and solves for ${targetTeamId === 'ALL' ? 'ALL teams' : targetTeamId}.`,
    details: { targetTeamId, targetRound }
  });

  const msg = targetTeamId === 'ALL'
    ? 'All test answers, submitted flags, and claimed slots have been cleared across all teams!'
    : `Test submissions and solves for crew ${targetTeams[0].teamName} have been cleared back to Round 1!`;

  return res.json({ success: true, message: msg });
});




// -----------------------
// Validation Utility
// -----------------------
const validateNoTags = (str, fieldName) => {
  if (typeof str === 'string' && /[<>]/.test(str)) {
    return `${fieldName} cannot contain '<' or '>' characters.`;
  }
  return null;
};

// -----------------------
// Tournament Engine Utilities: Riddle Allocations & Group Binding
// -----------------------
function getRiddlesByRound() {
  const bank = getRiddleBank();
  const grouped = { 1: [], 2: [], 3: [], 4: [] };
  Object.keys(bank).forEach(k => {
    const item = bank[k];
    const r = item.targetRound || 1;
    if (grouped[r]) {
      grouped[r].push({
        key: k,
        riddleNumber: item.riddleNumber || (grouped[r].length + 1),
        subtitle: item.title || k,
        points: item.points || 100,
        text: item.text || ''
      });
    }
  });

  if (grouped[1].length === 0) {
    const flagsFilePath = path.join(__dirname, 'private', 'flags.json');
    if (fs.existsSync(flagsFilePath)) {
      try {
        const flagsData = JSON.parse(fs.readFileSync(flagsFilePath, 'utf8'));
        Object.keys(flagsData).forEach(k => {
          const r = flagsData[k].round || 1;
          if (grouped[r]) {
            grouped[r].push({
              key: k,
              riddleNumber: flagsData[k].riddleNumber || 1,
              subtitle: flagsData[k].subtitle || k,
              points: flagsData[k].points || 500,
              text: flagsData[k].text || ''
            });
          }
        });
      } catch (e) {}
    }
  }

  for (const r in grouped) {
    grouped[r].sort((a, b) => a.riddleNumber - b.riddleNumber);
  }
  return grouped;
}

function allocateRiddlesForTeamIndex(teamIndex) {
  const riddles = getRiddlesByRound();

  // Group assignment: 5 teams in Group A, 5 in Group B
  // Alternate: 0, 2, 4, 6, 8 => Group A; 1, 3, 5, 7, 9 => Group B
  const groupRound2 = (teamIndex % 2 === 0) ? 'A' : 'B';

  // Round 1 (10 riddles): exactly 1 unique riddle per team
  const r1List = riddles[1] || [];
  const r1Key = r1List.length > 0 ? r1List[teamIndex % r1List.length].key : null;

  // Round 2 (6 riddles): deterministic distribution across the 10 teams
  const r2List = riddles[2] || [];
  const r2Key = r2List.length > 0 ? r2List[teamIndex % r2List.length].key : null;

  // Round 3 (2 riddles): Group A gets Riddle 1, Group B gets Riddle 2
  const r3List = riddles[3] || [];
  let r3Key = null;
  if (r3List.length > 0) {
    r3Key = (groupRound2 === 'A') ? r3List[0].key : (r3List[1] ? r3List[1].key : r3List[0].key);
  }

  // Round 4 (1 riddle): 1v1 Final Showdown
  const r4List = riddles[4] || [];
  const r4Key = r4List.length > 0 ? r4List[0].key : null;

  return {
    allocatedRiddles: {
      "1": r1Key,
      "2": r2Key,
      "3": r3Key,
      "4": r4Key
    },
    groupRound2: groupRound2,
    groupRound3: groupRound2
  };
}

function ensureTeamTournamentAttributes(team, index) {
  if (isAdminTeam(team)) return false;
  let changed = false;

  if (!team.currentRound) {
    team.currentRound = 1;
    changed = true;
  }
  if (!Array.isArray(team.unlockedRounds) || team.unlockedRounds.length === 0) {
    team.unlockedRounds = [1];
    changed = true;
  }
  if (!team.allocatedRiddles || typeof team.allocatedRiddles !== 'object') {
    const alloc = allocateRiddlesForTeamIndex(index);
    team.allocatedRiddles = alloc.allocatedRiddles;
    team.groupRound2 = alloc.groupRound2;
    team.groupRound3 = alloc.groupRound3;
    changed = true;
  }
  if (!team.groupRound2) {
    team.groupRound2 = (index % 2 === 0) ? 'A' : 'B';
    team.groupRound3 = team.groupRound2;
    changed = true;
  }
  if (!team.roundSolves || typeof team.roundSolves !== 'object') {
    team.roundSolves = {};
    changed = true;
  }
  if (team.eliminated === undefined) {
    team.eliminated = false;
    team.eliminatedRound = null;
    team.eliminatedReason = null;
    changed = true;
  }
  if (team.disqualified === undefined) {
    team.disqualified = false;
    team.disqualifiedAt = null;
    team.disqualifiedReason = null;
    changed = true;
  }

  return changed;
}

// -----------------------
// Load Teams
// -----------------------
const teamsFilePath = path.join(__dirname, 'teams.json');
let teams = [];
try {
  if (fs.existsSync(teamsFilePath)) {
    const teamsData = fs.readFileSync(teamsFilePath, 'utf8');
    teams = JSON.parse(teamsData);
  }
} catch (err) {
  console.error("Error reading teams.json:", err);
}

function getTeams() {
  return teams;
}

// Ensure existing teams have tournament progression attributes
let teamsUpdatedOnBoot = false;
let nonAdminBootIndex = 0;
teams.forEach(team => {
  if (!isAdminTeam(team)) {
    if (ensureTeamTournamentAttributes(team, nonAdminBootIndex)) {
      teamsUpdatedOnBoot = true;
    }
    nonAdminBootIndex++;
  }
});
if (teamsUpdatedOnBoot) {
  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  } catch (e) {
    console.error("Error saving updated teams on boot:", e);
  }
}

// -----------------------
// Load Users (maintained as shadow file for backward compatibility)
// -----------------------
const usersFilePath = path.join(__dirname, 'users.json');
let users = [];
try {
  if (fs.existsSync(usersFilePath)) {
    const usersData = fs.readFileSync(usersFilePath, 'utf8');
    users = JSON.parse(usersData);
  }
} catch (err) {
  console.error("Error reading users.json:", err);
}

function syncTeamsCredentialsOnBoot() {
  const creds = getCredentials();
  let updated = false;

  teams.forEach(t => {
    if (isAdminTeam(t)) {
      if (!t.password || !bcrypt.compareSync(creds.admin.password, t.password)) {
        t.password = bcrypt.hashSync(creds.admin.password, 10);
        updated = true;
      }
    } else {
      const plain = creds.teams[t.teamName.toUpperCase()] || creds.teams[t.teamName];
      if (plain && (!t.password || !bcrypt.compareSync(plain, t.password))) {
        t.password = bcrypt.hashSync(plain, 10);
        updated = true;
      }
    }
  });

  users.forEach(u => {
    if (u.id === 'user_admin_1' || u.username === 'admin@lostcode') {
      if (!u.password || !bcrypt.compareSync(creds.admin.password, u.password)) {
        u.password = bcrypt.hashSync(creds.admin.password, 10);
        updated = true;
      }
    } else {
      const plain = creds.teams[u.username.toUpperCase()] || creds.teams[u.username];
      if (plain && (!u.password || !bcrypt.compareSync(plain, u.password))) {
        u.password = bcrypt.hashSync(plain, 10);
        updated = true;
      }
    }
  });

  if (updated) {
    try {
      fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
      fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
    } catch (e) {
      console.error("Error writing updated credentials hashes on boot:", e);
    }
  }
}
syncTeamsCredentialsOnBoot();

// Helper: Identify admin teams to exclude from public rankings and solve counters
function isAdminTeam(team) {
  if (!team) return false;
  const name = (team.teamName || '').toLowerCase().trim();
  return team.id === 'team_admin_1' || name === 'admin@lostcode' || name === 'lostcode' || name === 'admin' || name.includes('admin');
}

function getCurrentTeam(req) {
  if (!req.session) return null;
  if (req.session.teamId) {
    return teams.find(t => t.id === req.session.teamId) || null;
  }
  if (req.session.userId) {
    const u = users.find(user => user.id === req.session.userId);
    if (u && u.teamId) return teams.find(t => t.id === u.teamId) || null;
    return teams.find(t => t.id === req.session.userId) || null;
  }
  return null;
}

function isAdminSession(req) {
  if (!req.session) return false;
  if (req.session.isAdmin) return true;
  if (req.session.userId === 'user_admin_1') return true;
  const team = getCurrentTeam(req);
  return team ? isAdminTeam(team) : false;
}

// -----------------------
// Crew Registration & Login
// -----------------------

app.post('/api/register', (req, res) => {
  return res.status(403).json({ error: 'Public registration is closed. Contact the Admiralty to receive your official crew credentials.' });
});

app.post('/api/login', (req, res) => {
  const { teamName, identifier, email, username, password } = req.body;
  const loginKey = (teamName || identifier || email || username || '').trim();
  if (!loginKey || !password) {
    return res.status(400).json({ error: 'Crew / Team name and password required.' });
  }

  const normalizedKey = loginKey.includes('@') ? loginKey.split('@')[0].trim().toLowerCase() : loginKey.toLowerCase();
  let matchedTeam = teams.find(t => {
    const tName = (t.teamName || '').trim().toLowerCase();
    const tEmail = (t.email || '').trim().toLowerCase();
    return tName === loginKey.toLowerCase() || tEmail === loginKey.toLowerCase() || tName === normalizedKey;
  });

  if (!matchedTeam && (
    loginKey.toLowerCase() === 'lostcode' ||
    loginKey.toLowerCase() === 'admin@lostcode' ||
    loginKey.toLowerCase() === 'admin' ||
    loginKey.toLowerCase() === 'admin@ctf.com'
  )) {
    matchedTeam = teams.find(t => t.id === 'team_admin_1' || isAdminTeam(t));
  }

  if (matchedTeam) {
    const teamPwMatches = matchedTeam.password && bcrypt.compareSync(password, matchedTeam.password);
    if (teamPwMatches) {
      req.session.teamId = matchedTeam.id;
      req.session.teamName = matchedTeam.teamName;
      req.session.isAdmin = (matchedTeam.id === 'team_admin_1' || isAdminTeam(matchedTeam));
      req.session.userId = matchedTeam.id;
      return res.json({ message: 'Login successful!', teamName: matchedTeam.teamName });
    }
  }

  return res.status(400).json({ error: 'Invalid crew name or password.' });
});

app.get('/api/challenges', (req, res) => {
  const userTeam = getCurrentTeam(req);
  const isAdminUser = isAdminSession(req);
  const globalUnlockedRounds = Array.isArray(ctfConfig.unlockedRounds) ? ctfConfig.unlockedRounds : [1];
  const teamUnlockedRounds = (userTeam && Array.isArray(userTeam.unlockedRounds)) ? userTeam.unlockedRounds : globalUnlockedRounds;

  const hintsUnlockedCount = (userTeam && userTeam.hintsUnlocked) ? Object.keys(userTeam.hintsUnlocked).length : 0;
  const nextHintCost = (hintsUnlockedCount + 1) * 5;

  const bank = getRiddleBank();
  const safeData = {};

  if (bank && Object.keys(bank).length > 0) {
    const roundNames = {
      1: 'Round 1: Setting Sail',
      2: 'Round 2: High Seas',
      3: "Round 3: Dead Man's Creek",
      4: 'Round 4: Treasure Island'
    };

    const roundCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const assignments = getTournamentAssignments();
    const roundState = getRoundState();
    Object.keys(bank).forEach(key => {
      const item = bank[key];
      const r = item.targetRound || item.round || 1;
      roundCounts[r] = (roundCounts[r] || 0) + 1;
      const riddleNum = item.riddleNumber || roundCounts[r];

      let solvesCount = 0;
      teams.forEach(team => {
        if (isAdminTeam(team)) return;
        const solvedList = Array.isArray(team.solvedChallenges) ? team.solvedChallenges : Object.keys(team.solvedChallenges || {});
        if (solvedList.includes(key) || solvedList.includes(item.id)) solvesCount++;
      });

      const isRoundLive = Boolean(roundState[String(r)] && roundState[String(r)].status === 'Live');
      const isRoundUnlocked = isAdminUser || isRoundLive || teamUnlockedRounds.includes(r);
      const slot = userTeam ? findTeamSlotInRound(assignments, r, userTeam.id) : null;
      const teamAllocatedRiddleId = (slot && slot.riddleId) ? slot.riddleId : (userTeam && userTeam.allocatedRiddles && userTeam.allocatedRiddles[r]);
      const isAllocatedToTeam = Boolean(
        isAdminUser || (
          userTeam && teamAllocatedRiddleId && (teamAllocatedRiddleId === key || teamAllocatedRiddleId === item.id)
        )
      );

      // Non-admin participants only see the riddles allocated specifically to their team
      if (!isAdminUser && !isAllocatedToTeam) {
        return;
      }

      const isHintUnlocked = Boolean(userTeam && userTeam.hintsUnlocked && (userTeam.hintsUnlocked[key] || userTeam.hintsUnlocked[item.id]));
      const rawHintText = (Array.isArray(item.hints) && item.hints[0] && item.hints[0].text) ? item.hints[0].text : (item.hint || '');
      const hasHint = Boolean(rawHintText && rawHintText.trim());

      safeData[key] = {
        id: item.id || key,
        title: item.title || key,
        subtitle: item.title || key,
        text: isRoundUnlocked ? (item.text || '') : "These waters remain sealed by the Admiralty. Advance your crew to unlock this riddle.",
        points: item.points || 100,
        difficulty: item.difficulty || (r === 1 ? 'EASY' : (r === 2 ? 'MEDIUM' : (r === 3 ? 'HARD' : 'EXPERT'))),
        round: r,
        roundName: item.roundName || roundNames[r] || `Round ${r}`,
        riddleNumber: riddleNum,
        category: item.category || key,
        hint: isRoundUnlocked ? (isHintUnlocked ? rawHintText : null) : null,
        adminHint: isAdminUser ? rawHintText : null,
        hasHint: isRoundUnlocked ? hasHint : false,
        hintUnlocked: isRoundUnlocked ? isHintUnlocked : false,
        solves: solvesCount,
        nextHintCost: nextHintCost,
        unlocked: isRoundUnlocked,
        allocatedToTeam: isAllocatedToTeam
      };
    });
    return res.json(safeData);
  }

  const flagsFilePath = path.join(__dirname, 'private', 'flags.json');
  if (!fs.existsSync(flagsFilePath)) return res.json({});
  const flagsData = JSON.parse(fs.readFileSync(flagsFilePath, 'utf8'));

  for (const key in flagsData) {
    let solvesCount = 0;
    teams.forEach(team => {
      if (isAdminTeam(team)) return;
      const solvedList = Array.isArray(team.solvedChallenges)
        ? team.solvedChallenges
        : (team.solvedChallenges ? Object.keys(team.solvedChallenges) : []);
      if (solvedList.includes(key)) solvesCount++;
    });

    const roundNum = flagsData[key].round || 1;
    const isRoundUnlocked = isAdminUser || teamUnlockedRounds.includes(roundNum);
    const slot = userTeam ? findTeamSlotInRound(assignments, roundNum, userTeam.id) : null;
    const teamAllocatedRiddleId = (slot && slot.riddleId) ? slot.riddleId : (userTeam && userTeam.allocatedRiddles && userTeam.allocatedRiddles[roundNum]);
    const isAllocatedToTeam = Boolean(
      isAdminUser || (
        userTeam && teamAllocatedRiddleId && teamAllocatedRiddleId === key
      )
    );

    if (!isAdminUser && !isAllocatedToTeam) {
      continue;
    }

    const hasHint = Boolean(flagsData[key].hint && flagsData[key].hint.trim());
    const isHintUnlocked = Boolean(userTeam && userTeam.hintsUnlocked && userTeam.hintsUnlocked[key]);

    safeData[key] = { 
      text: isRoundUnlocked ? flagsData[key].text : "These waters remain sealed by the Admiralty. Advance your crew to unlock this riddle.", 
      subtitle: flagsData[key].subtitle || "",
      points: flagsData[key].points || 500,
      difficulty: flagsData[key].difficulty || "EASY",
      round: roundNum,
      roundName: flagsData[key].roundName || "Round 1: Setting Sail",
      riddleNumber: flagsData[key].riddleNumber || 1,
      category: flagsData[key].category || "Miscellaneous",
      hint: isRoundUnlocked ? (isHintUnlocked ? (flagsData[key].hint || "") : null) : null,
      adminHint: isAdminUser ? (flagsData[key].hint || "") : null,
      hasHint: isRoundUnlocked ? hasHint : false,
      hintUnlocked: isRoundUnlocked ? isHintUnlocked : false,
      resource: isRoundUnlocked ? flagsData[key].resource : null,
      originalResourceName: isRoundUnlocked ? flagsData[key].originalResourceName : null,
      solves: solvesCount,
      nextHintCost: nextHintCost,
      unlocked: isRoundUnlocked,
      allocatedToTeam: isAllocatedToTeam
    };
  }
  res.json(safeData);
});

const isAdmin = (req, res, next) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

app.post('/api/admin/challenges', isAdmin, upload.single('resource'), (req, res) => {
  
  const { category, text, flag, points, removeResource, difficulty, hint, subtitle, round } = req.body;
  
  const flagsFilePath = path.join(__dirname, 'private', 'flags.json');
  let flagsData = {};
  if (fs.existsSync(flagsFilePath)) {
    flagsData = JSON.parse(fs.readFileSync(flagsFilePath, 'utf8'));
  }
  
  const roundNum = parseInt(round, 10) || (flagsData[category] && flagsData[category].round) || 1;
  if (!category || !flag || !points) {
    return res.status(400).json({ error: 'All required fields (Category, Flag, Points) must be provided.' });
  }
  
  let oldPoints = null;
  if (!flagsData[category]) {
    flagsData[category] = {};
  } else {
    oldPoints = flagsData[category].points !== undefined ? Number(flagsData[category].points) : 500;
  }
  
  const newPoints = parseInt(points) || 500;
  flagsData[category].text = text || "";
  flagsData[category].subtitle = subtitle || flagsData[category].subtitle || "";
  flagsData[category].points = newPoints;
  flagsData[category].difficulty = difficulty || "EASY";
  flagsData[category].hint = hint || "";
  flagsData[category].round = roundNum;
  const roundNames = {
    1: 'Round 1: Setting Sail',
    2: 'Round 2: High Seas',
    3: "Round 3: Dead Man's Creek",
    4: 'Round 4: Treasure Island'
  };
  flagsData[category].roundName = roundNames[roundNum] || `Round ${roundNum}`;
  if (!flagsData[category].riddleNumber) {
    const roundCount = Object.values(flagsData).filter(c => c.round === roundNum && c !== flagsData[category]).length;
    flagsData[category].riddleNumber = roundCount + 1;
  }
  if (!flagsData[category].category) {
    flagsData[category].category = category;
  }
  
  if (req.file) {
    flagsData[category].resource = req.file.filename;
    flagsData[category].originalResourceName = req.file.originalname;
  }
  if (removeResource === 'true') {
    delete flagsData[category].resource;
    delete flagsData[category].originalResourceName;
  }
  
  if (flag && flag !== '********') {
    flagsData[category].hash = bcrypt.hashSync(flag, 10);
  } else if (!flagsData[category].hash) {
    return res.status(400).json({ error: 'Valid flag required for new challenges.' });
  }
  
  fs.writeFileSync(flagsFilePath, JSON.stringify(flagsData, null, 2));
  
  // Retroactively adjust scores if points changed
  if (oldPoints !== null && oldPoints !== newPoints) {
    const pointDiff = newPoints - oldPoints;
    let teamsChanged = false;
    
    teams.forEach(team => {
      const solvedList = Array.isArray(team.solvedChallenges) ? team.solvedChallenges : Object.keys(team.solvedChallenges || {});
      const teamSolvedIt = solvedList.includes(category);
      
      if (teamSolvedIt) {
        team.score += pointDiff;
        if (!team.scoreHistory) {
          team.scoreHistory = [{ timestamp: Date.now() - 1000, score: team.score - pointDiff }];
        }
        team.scoreHistory.push({ timestamp: Date.now(), score: team.score });
        teamsChanged = true;
      }
    });
    
    if (teamsChanged) {
      fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2));
      io.emit('teamsUpdate');
    }
  }

  io.emit('challengesUpdate');
  res.json({ message: 'Challenge updated successfully.' });
});

app.post('/api/admin/challenges/delete', isAdmin, (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: 'Category required.' });
  
  const flagsFilePath = path.join(__dirname, 'private', 'flags.json');
  if (fs.existsSync(flagsFilePath)) {
    let flagsData = JSON.parse(fs.readFileSync(flagsFilePath, 'utf8'));
    const challengeObj = flagsData[category];
    
    if (challengeObj) {
      const pointsToDeduct = challengeObj.points !== undefined ? Number(challengeObj.points) : 500;
      
      // Remove points from teams that solved it
      let teamsChanged = false;
      teams.forEach(team => {
        let teamSolvedIt = false;
        if (Array.isArray(team.solvedChallenges) && team.solvedChallenges.includes(category)) {
          team.solvedChallenges = team.solvedChallenges.filter(c => c !== category);
          teamSolvedIt = true;
        } else if (team.solvedChallenges && team.solvedChallenges[category]) {
          delete team.solvedChallenges[category];
          teamSolvedIt = true;
        }
        
        if (teamSolvedIt) {
          team.score -= pointsToDeduct;
          if (!team.scoreHistory) {
            team.scoreHistory = [{ timestamp: Date.now() - 1000, score: team.score + pointsToDeduct }];
          }
          team.scoreHistory.push({ timestamp: Date.now(), score: team.score });
          teamsChanged = true;
        }
      });
      
      // Remove challenge from all users' solved lists
      let usersChanged = false;
      users.forEach(user => {
        if (Array.isArray(user.solvedChallenges) && user.solvedChallenges.includes(category)) {
          user.solvedChallenges = user.solvedChallenges.filter(c => c !== category);
          usersChanged = true;
        }
      });
      
      // Save data
      delete flagsData[category];
      fs.writeFileSync(flagsFilePath, JSON.stringify(flagsData, null, 2));
      
      if (usersChanged || teamsChanged) {
        fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(users, null, 2));
        fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2));
        io.emit('teamsUpdate');
      }
    }
  }
  io.emit('challengesUpdate');
  res.json({ message: 'Challenge deleted successfully.' });
});

// -----------------------
// Team Endpoints
// -----------------------

app.get('/api/teams', (req, res) => {
  const safeTeams = teams.filter(t => !isAdminTeam(t)).map(team => {
    const solvedChallenges = Array.isArray(team.solvedChallenges) 
      ? team.solvedChallenges 
      : (team.solvedChallenges ? Object.keys(team.solvedChallenges) : []);
    return {
      id: team.id,
      teamName: team.teamName,
      tagline: team.tagline || '',
      score: typeof team.score === 'number' ? team.score : 0,
      solvedChallenges,
      scoreHistory: team.scoreHistory || [],
      disqualified: Boolean(team.disqualified),
      violations: team.violations || 0,
      currentRound: team.currentRound || 1,
      unlockedRounds: team.unlockedRounds || [1],
      groupRound2: team.groupRound2 || 'A',
      groupRound3: team.groupRound3 || 'A',
      eliminated: Boolean(team.eliminated),
      eliminatedRound: team.eliminatedRound || null,
      eliminatedReason: team.eliminatedReason || null,
      isWinner: Boolean(team.isWinner),
      roundSolves: team.roundSolves || {},
      timer: getTeamRoundTimer(team, String(team.currentRound || 1)),
      roundTimers: team.roundTimers || {}
    };
  });
  res.json(safeTeams);
});

app.get('/api/myteam', (req, res) => {
  const myTeam = getCurrentTeam(req);
  if (!myTeam) return res.status(403).json({ error: 'Not logged in' });

  const solvedChallenges = Array.isArray(myTeam.solvedChallenges) 
    ? myTeam.solvedChallenges 
    : (myTeam.solvedChallenges ? Object.keys(myTeam.solvedChallenges) : []);

  if (typeof myTeam.score !== 'number') myTeam.score = 0;
  if (!myTeam.hintsUnlocked || typeof myTeam.hintsUnlocked !== 'object') {
    myTeam.hintsUnlocked = {};
  }
  const hintsUnlockedCount = Object.keys(myTeam.hintsUnlocked).length;
  const nextHintPenaltyMinutes = (hintsUnlockedCount + 1) * 5;
  const curRound = myTeam.currentRound || 1;
  const timer = getTeamRoundTimer(myTeam, String(curRound));

  res.json({
    team: {
      id: myTeam.id,
      teamName: myTeam.teamName,
      tagline: myTeam.tagline || '',
      score: myTeam.score,
      solvedChallenges,
      hintsUnlocked: myTeam.hintsUnlocked,
      hintsUnlockedCount,
      nextHintPenaltyMinutes,
      disqualified: Boolean(myTeam.disqualified),
      violations: myTeam.violations || 0,
      currentRound: curRound,
      unlockedRounds: myTeam.unlockedRounds || [1],
      allocatedRiddles: myTeam.allocatedRiddles || {},
      groupRound2: myTeam.groupRound2 || 'A',
      groupRound3: myTeam.groupRound3 || 'A',
      eliminated: Boolean(myTeam.eliminated),
      eliminatedRound: myTeam.eliminatedRound || null,
      eliminatedReason: myTeam.eliminatedReason || null,
      roundSolves: myTeam.roundSolves || {},
      roundTimers: myTeam.roundTimers || {},
      timer,
      totalHintPenaltyMinutes: myTeam.totalHintPenaltyMinutes || 0,
      isWinner: Boolean(myTeam.isWinner)
    }
  });
});

app.get('/api/profile', (req, res) => {
  const myTeam = getCurrentTeam(req);
  if (!myTeam) return res.status(403).json({ error: 'Not logged in' });
  res.json({
    teamName: myTeam.teamName,
    isAdmin: isAdminSession(req),
    disqualified: Boolean(myTeam.disqualified),
    violations: myTeam.violations || 0,
    eliminated: Boolean(myTeam.eliminated),
    currentRound: myTeam.currentRound || 1
  });
});

// Tournament Status API
app.get('/api/tournament/status', (req, res) => {
  const roundState = getRoundState();
  const activeTeams = teams.filter(t => !isAdminTeam(t)).map(t => {
    const curR = t.currentRound || 1;
    const timer = getTeamRoundTimer(t, String(curR));
    return {
      id: t.id,
      teamName: t.teamName,
      score: t.score || 0,
      currentRound: curR,
      unlockedRounds: t.unlockedRounds || [1],
      allocatedRiddles: t.allocatedRiddles || {},
      groupRound2: t.groupRound2 || 'A',
      groupRound3: t.groupRound3 || 'A',
      eliminated: Boolean(t.eliminated),
      eliminatedRound: t.eliminatedRound || null,
      eliminatedReason: t.eliminatedReason || null,
      disqualified: Boolean(t.disqualified),
      violations: t.violations || 0,
      roundSolves: t.roundSolves || {},
      roundTimers: t.roundTimers || {},
      timer,
      isWinner: Boolean(t.isWinner)
    };
  });

  res.json({
    teams: activeTeams,
    roundState,
    roundDurations: ctfConfig.roundDurations || { "1": 30, "2": 25, "3": 20, "4": 15 },
    winner: activeTeams.find(t => t.isWinner) || null
  });
});

// Admin Endpoint: Provision / Seed 10 Tournament Pirate Crews
app.post('/api/admin/tournament/seed-teams', isAdmin, (req, res) => {
  const crewNames = [
    "BUCCANEERS",
    "CUTTHROATS",
    "CORSAIRS",
    "KRAKENS",
    "SCALLYWAGS",
    "PRIVATEERS",
    "BLACKFLAGS",
    "PLUNDERERS",
    "DREADSAILS",
    "SEARAVENS"
  ];

  const crewTaglines = {
    "BUCCANEERS": "Ruthless pirate adventurers",
    "CUTTHROATS": "Fearless and dangerous",
    "CORSAIRS": "Elite sea raiders",
    "KRAKENS": "Mythical forces of the deep",
    "SCALLYWAGS": "Mischievous pirates",
    "PRIVATEERS": "Strategic naval raiders",
    "BLACKFLAGS": "Rogue pirates of the seas",
    "PLUNDERERS": "Seekers of hidden treasure",
    "DREADSAILS": "Ghostly ships of the ocean",
    "SEARAVENS": "Dark and cunning voyagers"
  };

  // Generate or retrieve tournament credentials
  const creds = generateTournamentCredentials(req.body?.regenerateAdmin ? null : getCredentials());
  const adminPlainPw = creds.admin.password;
  const adminPwHash = bcrypt.hashSync(adminPlainPw, 10);

  // Preserve admin team
  const adminTeam = teams.find(t => isAdminTeam(t)) || {
    id: "team_admin_1",
    teamName: "admin@lostcode",
    password: adminPwHash,
    score: 0,
    solvedChallenges: [],
    hintsUnlocked: {},
    scoreHistory: []
  };
  if (req.body?.regenerateAdmin || !adminTeam.password) {
    adminTeam.password = adminPwHash;
  }

  const adminUser = users.find(u => u.id === 'user_admin_1') || {
    id: "user_admin_1",
    username: "admin@lostcode",
    email: "admin@lostcode",
    password: adminTeam.password,
    teamId: "team_admin_1",
    solvedChallenges: []
  };
  if (req.body?.regenerateAdmin || !adminUser.password) {
    adminUser.password = adminTeam.password;
  }

  const newTeams = [adminTeam];
  const newUsers = [adminUser];

  crewNames.forEach((name, i) => {
    const teamId = `crew_${i + 1}_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const alloc = allocateRiddlesForTeamIndex(i);
    const plainPw = creds.teams[name] || generateRandomPassword(6, `${name.toLowerCase()}_`);
    creds.teams[name] = plainPw;
    const defaultPw = bcrypt.hashSync(plainPw, 10);

    const team = {
      id: teamId,
      teamName: name,
      tagline: crewTaglines[name] || "Pirate Crew",
      password: defaultPw,
      score: 0,
      solvedChallenges: [],
      hintsUnlocked: {},
      scoreHistory: [{ timestamp: Date.now(), score: 0 }],
      currentRound: 1,
      unlockedRounds: [1],
      allocatedRiddles: alloc.allocatedRiddles,
      groupRound2: alloc.groupRound2,
      groupRound3: alloc.groupRound3,
      eliminated: false,
      eliminatedRound: null,
      eliminatedReason: null,
      disqualified: false,
      disqualifiedAt: null,
      disqualifiedReason: null,
      roundSolves: {}
    };

    const user = {
      id: teamId,
      username: name,
      email: `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@lostcode`,
      password: defaultPw,
      teamId: teamId,
      solvedChallenges: []
    };

    newTeams.push(team);
    newUsers.push(user);
  });

  teams.length = 0;
  newTeams.forEach(t => teams.push(t));
  users = newUsers;

  // Reset slot claims & round state qualifiers so fresh teams start clean
  const assignments = getTournamentAssignments();
  if (assignments && assignments.rounds) {
    Object.keys(assignments.rounds).forEach(r => {
      const rd = assignments.rounds[r];
      if (Array.isArray(rd.slots)) {
        rd.slots.forEach(s => { delete s.claimed; delete s.claimedBy; delete s.claimedAt; });
      }
      if (rd.groups) {
        Object.keys(rd.groups).forEach(g => {
          if (Array.isArray(rd.groups[g].slots)) {
            rd.groups[g].slots.forEach(s => { delete s.claimed; delete s.claimedBy; delete s.claimedAt; });
          }
        });
      }
    });
    saveTournamentAssignments(assignments);
  }

  const roundState = getRoundState();
  Object.keys(roundState).forEach(r => {
    roundState[r].status = r === '1' ? 'Draft' : 'Locked';
    roundState[r].qualifiers = [];
    roundState[r].eliminations = [];
    delete roundState[r].winner;
  });
  saveRoundState(roundState);

  ctfConfig.ctfStartTime = null;
  fs.writeFileSync(configFilePath, JSON.stringify(ctfConfig, null, 2));
  io.emit('configUpdate', ctfConfig);

  fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));

  saveCredentials(creds);

  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');

  res.json({
    success: true,
    message: 'Successfully seeded 10 pirate crews with randomized tournament credentials!',
    credentials: creds,
    crews: teams.filter(t => !isAdminTeam(t)).map(t => ({
      name: t.teamName,
      group: t.groupRound2,
      round1Riddle: t.allocatedRiddles["1"]
    }))
  });
});

// Single-Submitter Flag Submission (Team-level)
app.post('/api/challenge/flag', (req, res) => {
  const isAdminUser = isAdminSession(req);
  if (!ctfConfig.ctfStartTime && !isAdminUser) return res.status(403).json({ error: 'The Treasure Hunt has not started yet!' });
  const team = getCurrentTeam(req);
  if (!team) return res.status(403).json({ error: 'Not logged in' });
  if (team.disqualified) {
    return res.status(403).json({
      error: team.disqualifiedReason || 'Your crew has been disqualified from the tournament for proctoring violations.',
      reason: team.disqualifiedReason || 'Your crew has been disqualified from the tournament for proctoring violations.'
    });
  }

  // Elimination check
  if (!isAdminUser && team.eliminated) {
    return res.status(403).json({
      error: team.eliminatedReason || "Arr! Your crew has Walked the Plank and cannot submit further flags."
    });
  }
  
  const { category, flag } = req.body;
  if (!category || !flag) return res.status(400).json({ error: 'Category and flag required.' });
  const flagsFilePath = path.join(__dirname, 'private', 'flags.json');
  if (!fs.existsSync(flagsFilePath)) return res.status(500).json({ error: 'Flags file not found.' });
  const flagsData = JSON.parse(fs.readFileSync(flagsFilePath, 'utf8'));
  const challengeObj = flagsData[category];
  if (!challengeObj) return res.status(404).json({ error: 'Challenge not found for this category.' });

  const challengeRound = challengeObj.round || 1;
  const unlockedRounds = (team.unlockedRounds && Array.isArray(team.unlockedRounds)) ? team.unlockedRounds : (ctfConfig.unlockedRounds || [1]);
  if (!isAdminUser && !unlockedRounds.includes(challengeRound)) {
    return res.status(403).json({ error: "These waters remain locked by the Admiralty! Solve your active round to chart this course." });
  }

  if (!Array.isArray(team.solvedChallenges)) {
    team.solvedChallenges = team.solvedChallenges ? Object.keys(team.solvedChallenges) : [];
  }
  
  if (team.solvedChallenges.includes(category)) {
    return res.status(400).json({ error: 'This challenge has already been solved by your team.' });
  }

  // For non-admin teams, enforce active allocated riddle
  if (!isAdminUser && team.allocatedRiddles) {
    const curRound = team.currentRound || 1;
    const assignedCat = team.allocatedRiddles[curRound];
    if (assignedCat && category !== assignedCat) {
      return res.status(403).json({
        error: `Arr! Your crew is currently charted for Round ${curRound}. You must submit the flag for your allocated riddle: "${assignedCat}".`
      });
    }
  }

  const storedHash = challengeObj.hash;
  if (!storedHash) return res.status(404).json({ error: 'Challenge not found for this category.' });
  
  if (!bcrypt.compareSync(flag, storedHash)) {
    return res.status(400).json({ error: 'Incorrect flag.' });
  }
  
  team.solvedChallenges.push(category);
  const pointsEarned = challengeObj.points !== undefined ? Number(challengeObj.points) : 500;
  team.score = (team.score || 0) + pointsEarned;
  const solveTs = Date.now();
  if (!team.scoreHistory) {
    team.scoreHistory = [{ timestamp: solveTs - 1000, time: new Date(solveTs - 1000).toLocaleTimeString(), score: team.score - pointsEarned }];
  }
  team.scoreHistory.push({ timestamp: solveTs, time: new Date(solveTs).toLocaleTimeString(), score: team.score });

  if (!team.roundSolves) team.roundSolves = {};
  const currentRoundNum = challengeRound;
  team.roundSolves[currentRoundNum] = Date.now();

  let advanceMessage = 'Correct flag! Challenge solved.';

  // Advance tournament rounds and apply group elimination engine
  if (!isAdminUser) {
    if (currentRoundNum === 1) {
      // Round 1 -> Advance to Round 2 (All 10 teams advance)
      team.currentRound = 2;
      if (!Array.isArray(team.unlockedRounds)) team.unlockedRounds = [1];
      if (!team.unlockedRounds.includes(2)) {
        team.unlockedRounds.push(2);
        team.unlockedRounds.sort((a, b) => a - b);
      }
      advanceMessage = `Bounty Claimed! Round 1 completed. High Seas (Round 2) unlocked! Chart your course to Island 2.`;
    } else if (currentRoundNum === 2) {
      // Round 2 -> Top 3 from team's group advance to Round 3
      const group = team.groupRound2 || 'A';
      // Find all teams in this group that have solved Round 2
      const solvedInGroup = teams.filter(t => !isAdminTeam(t) && t.groupRound2 === group && t.roundSolves && t.roundSolves[2]);
      const groupRank = solvedInGroup.length;

      if (groupRank <= 3) {
        team.currentRound = 3;
        if (!team.unlockedRounds.includes(3)) {
          team.unlockedRounds.push(3);
          team.unlockedRounds.sort((a, b) => a - b);
        }
        team.groupRound3 = group;
        advanceMessage = `Bounty Claimed! Crew finished #${groupRank} in Group ${group}! Dead Man's Creek (Round 3) unlocked!`;

        // Dynamically sync qualifier into Round 3 assignments
        try {
          const currentAssigns = getTournamentAssignments();
          if (currentAssigns.rounds && currentAssigns.rounds['3'] && currentAssigns.rounds['3'].groups && currentAssigns.rounds['3'].groups[group]) {
            const r3Grp = currentAssigns.rounds['3'].groups[group];
            if (groupRank === 1) {
              r3Grp.teams = [team.id];
            } else if (!r3Grp.teams.includes(team.id)) {
              r3Grp.teams.push(team.id);
            }
            if (r3Grp.slots && r3Grp.slots[0]) {
              if (!Array.isArray(r3Grp.slots[0].eligibleTeams)) r3Grp.slots[0].eligibleTeams = [];
              if (!r3Grp.slots[0].eligibleTeams.includes(team.id)) {
                r3Grp.slots[0].eligibleTeams.push(team.id);
              }
            }
            saveTournamentAssignments(currentAssigns);
          }
        } catch (e) {
          console.error("Error syncing Round 3 assignments:", e);
        }

        // If this was the 3rd team in the group to solve Round 2:
        // Automatically eliminate the remaining 2 teams in this group who haven't solved Round 2!
        if (groupRank === 3) {
          teams.forEach(t => {
            if (!isAdminTeam(t) && t.groupRound2 === group && (!t.roundSolves || !t.roundSolves[2]) && !t.eliminated) {
              t.eliminated = true;
              t.eliminatedRound = 2;
              t.eliminatedAt = Date.now();
              t.eliminatedReason = `Walked the Plank in Round 2: Top 3 spots in Group ${group} have been claimed! Your crew was outpaced.`;
            }
          });
        }
      } else {
        // Outpaced
        team.eliminated = true;
        team.eliminatedRound = 2;
        team.eliminatedAt = Date.now();
        team.eliminatedReason = `Walked the Plank in Round 2: Top 3 spots in Group ${group} were already claimed!`;
        advanceMessage = `Flag correct, but the top 3 spots in Group ${group} have already been claimed! Your crew has Walked the Plank.`;
      }
    } else if (currentRoundNum === 3) {
      // Round 3 -> Top 1 from team's group advances to Round 4 (1v1 Final Showdown)
      const group = team.groupRound3 || team.groupRound2 || 'A';
      const solvedInGroup = teams.filter(t => !isAdminTeam(t) && t.groupRound3 === group && t.roundSolves && t.roundSolves[3]);
      const groupRank = solvedInGroup.length;

      if (groupRank === 1) {
        team.currentRound = 4;
        if (!team.unlockedRounds.includes(4)) {
          team.unlockedRounds.push(4);
          team.unlockedRounds.sort((a, b) => a - b);
        }
        advanceMessage = `Bounty Claimed! Finalist berth secured for Group ${group}! Treasure Island (Round 4) unlocked for the 1v1 Final Showdown!`;

        // Dynamically sync finalist into Round 4 assignments
        try {
          const currentAssigns = getTournamentAssignments();
          if (currentAssigns.rounds && currentAssigns.rounds['4']) {
            if (!Array.isArray(currentAssigns.rounds['4'].teams)) currentAssigns.rounds['4'].teams = [];
            if (!currentAssigns.rounds['4'].teams.includes(team.id)) currentAssigns.rounds['4'].teams.push(team.id);
            const targetSlotIdx = group === 'B' ? 1 : 0;
            const targetSlot = currentAssigns.rounds['4'].slots && (currentAssigns.rounds['4'].slots[targetSlotIdx] || currentAssigns.rounds['4'].slots[0]);
            if (targetSlot) {
              if (!Array.isArray(targetSlot.eligibleTeams)) targetSlot.eligibleTeams = [];
              if (!targetSlot.eligibleTeams.includes(team.id)) {
                targetSlot.eligibleTeams.push(team.id);
              }
            }
            saveTournamentAssignments(currentAssigns);
          }
        } catch (e) {
          console.error("Error syncing Round 4 assignments:", e);
        }

        // Automatically eliminate the other 2 teams in this group
        teams.forEach(t => {
          if (!isAdminTeam(t) && t.groupRound3 === group && t.id !== team.id && !t.eliminated) {
            t.eliminated = true;
            t.eliminatedRound = 3;
            t.eliminatedAt = Date.now();
            t.eliminatedReason = `Walked the Plank in Round 3: ${team.teamName} claimed the sole finalist spot for Group ${group}!`;
          }
        });
      } else {
        team.eliminated = true;
        team.eliminatedRound = 3;
        team.eliminatedAt = Date.now();
        team.eliminatedReason = `Walked the Plank in Round 3: Finalist berth for Group ${group} was already claimed!`;
        advanceMessage = `Flag correct, but the finalist berth for Group ${group} was already claimed! Your crew has Walked the Plank.`;
      }
    } else if (currentRoundNum === 4) {
      // Round 4 -> Grand Champion!
      team.isWinner = true;
      team.wonAt = Date.now();
      advanceMessage = `VICTORY! ${team.teamName} has uncovered the Final Treasure and won the CoreDump 2.0 Lost Code Championship!`;
      io.emit('tournamentWinner', { winner: team.teamName, score: team.score });
    }
  }
  
  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  } catch (err) {
    console.error("Error writing files:", err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
  
  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');
  return res.json({
    message: advanceMessage,
    currentRound: team.currentRound,
    unlockedRounds: team.unlockedRounds,
    eliminated: team.eliminated,
    eliminatedReason: team.eliminatedReason,
    isWinner: Boolean(team.isWinner),
    pointsEarned: pointsEarned
  });
});

// Unlock Hint with Escalating Deduction (-5, -10, -15...)
app.post('/api/challenge/hint/unlock', (req, res) => {
  const isAdminUser = isAdminSession(req);
  if (!ctfConfig.ctfStartTime && !isAdminUser) return res.status(403).json({ error: 'The Treasure Hunt has not started yet!' });
  const team = getCurrentTeam(req);
  if (!team) return res.status(403).json({ error: 'Not logged in' });
  if (team.disqualified) {
    return res.status(403).json({
      error: team.disqualifiedReason || 'Your crew has been disqualified from the tournament for proctoring violations.',
      reason: team.disqualifiedReason || 'Your crew has been disqualified from the tournament for proctoring violations.'
    });
  }
  const { category, riddleId } = req.body || {};
  const queryKey = riddleId || category;
  if (!queryKey) return res.status(400).json({ error: 'Riddle ID or category required.' });

  const flagsFilePath = path.join(__dirname, 'private', 'flags.json');
  let flagsData = {};
  try { if (fs.existsSync(flagsFilePath)) flagsData = JSON.parse(fs.readFileSync(flagsFilePath, 'utf8')); } catch(e) {}
  const riddleBank = getRiddleBank();

  let hintText = null;
  let challengeRound = 1;
  const challengeObj = flagsData[queryKey];
  const riddleObj = riddleBank[queryKey] || Object.values(riddleBank).find(r => r.id === queryKey || r.category === queryKey);

  if (challengeObj && challengeObj.hint) {
    hintText = challengeObj.hint;
    challengeRound = challengeObj.round || 1;
  } else if (riddleObj && Array.isArray(riddleObj.hints) && riddleObj.hints.length > 0) {
    hintText = riddleObj.hints[0].text;
    challengeRound = riddleObj.targetRound || 1;
  } else if (riddleObj && riddleObj.text) {
    hintText = `Intel Clue: Search carefully near ${riddleObj.title}.`;
    challengeRound = riddleObj.targetRound || 1;
  } else {
    return res.status(404).json({ error: 'Challenge or riddle not found.' });
  }

  const unlockedRounds = Array.isArray(ctfConfig.unlockedRounds) ? ctfConfig.unlockedRounds : [1];
  if (!isAdminUser && !unlockedRounds.includes(challengeRound)) {
    return res.status(403).json({ error: "These waters remain locked by the Admiralty! Await captain's orders before seeking clues here." });
  }

  if (!team.hintsUnlocked || typeof team.hintsUnlocked !== 'object') {
    team.hintsUnlocked = {};
  }

  // If already unlocked for this team, return it without deducting again
  if (team.hintsUnlocked[queryKey]) {
    return res.json({
      success: true,
      message: 'Hint already unlocked.',
      hint: hintText,
      cost: 0,
      penaltyMinutes: 0,
      timeDeductedMinutes: 0,
      alreadyUnlocked: true,
      hintsUnlockedCount: Object.keys(team.hintsUnlocked).length,
      nextHintPenaltyMinutes: (Object.keys(team.hintsUnlocked).length + 1) * 5
    });
  }

  // Calculate escalating time deduction: 1st hint = -5m, 2nd hint = -10m, 3rd = -15m...
  const currentCount = Object.keys(team.hintsUnlocked).length;
  const penaltyMinutes = (currentCount + 1) * 5;

  const rKey = String(challengeRound);
  if (!team.roundTimers) team.roundTimers = {};
  if (!team.roundTimers[rKey]) {
    getTeamRoundTimer(team, rKey);
  }
  if (team.roundTimers[rKey]) {
    team.roundTimers[rKey].hintPenaltiesMinutes = (team.roundTimers[rKey].hintPenaltiesMinutes || 0) + penaltyMinutes;
  }
  team.totalHintPenaltyMinutes = (team.totalHintPenaltyMinutes || 0) + penaltyMinutes;

  team.hintsUnlocked[queryKey] = {
    penaltyMinutes,
    unlockedAt: Date.now()
  };

  // If hint penalty causes active round timer to expire, automatically disqualify crew
  if (checkTeamExpiryAndDisqualify(team, rKey)) {
    io.emit('team:disqualified', {
      teamId: team.id,
      teamName: team.teamName,
      reason: team.disqualifiedReason
    });
  }

  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  } catch (err) {
    console.error("Error writing teams.json:", err);
    return res.status(500).json({ error: 'Internal server error.' });
  }

  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');

  return res.json({
    success: true,
    message: `Quartermaster's secret revealed! ${penaltyMinutes} minutes deducted from your crew's timer.`,
    hint: hintText,
    penaltyMinutes,
    timeDeductedMinutes: penaltyMinutes,
    hintsUnlockedCount: currentCount + 1,
    nextHintPenaltyMinutes: (currentCount + 2) * 5
  });
});

// Proctoring: Screen Departure Violation & Disqualification Endpoint
app.post('/api/proctor/violation', (req, res) => {
  const team = getCurrentTeam(req);
  if (!team) return res.status(403).json({ error: 'Not logged in' });
  if (isAdminTeam(team) || isAdminSession(req)) {
    return res.json({ ignored: true, message: 'Admin session exempt from proctoring.' });
  }
  if (ctfConfig.fullscreenEnforced === false) {
    return res.json({ ignored: true, message: 'Fullscreen proctoring disabled by administrator.' });
  }

  if (team.disqualified) {
    return res.json({ disqualified: true, violations: team.violations || 2, message: 'Crew is already disqualified.' });
  }

  team.violations = (team.violations || 0) + 1;
  const isSecondViolation = team.violations >= 2;

  if (isSecondViolation) {
    team.disqualified = true;
    team.disqualifiedAt = Date.now();
    team.disqualifiedReason = 'Screen departure violation limit exceeded (2/2).';
    io.emit('team:disqualified', { teamId: team.id, teamName: team.teamName, reason: team.disqualifiedReason });
  }

  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  } catch (err) {
    console.error("Error writing teams.json during proctor violation:", err);
  }

  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');

  if (isSecondViolation) {
    return res.json({
      disqualified: true,
      violations: team.violations,
      message: 'Crew has been disqualified for leaving the screen after receiving a warning.'
    });
  } else {
    return res.json({
      warning: true,
      violations: team.violations,
      message: 'Warning 1 of 1: Screen departure detected. The next departure will disqualify your crew.'
    });
  }
});

// Admin Route: Reinstate Disqualified Crew
app.post(['/api/admin/teams/reinstate', '/api/admin/teams/reinitiate'], isAdmin, (req, res) => {
  const teamId = req.body?.teamId || req.body?.teamName;
  if (!teamId) return res.status(400).json({ error: 'teamId or teamName required.' });

  const targetTeam = teams.find(t => t.id === teamId || t.teamName.toLowerCase() === teamId.toLowerCase());
  if (!targetTeam) return res.status(404).json({ error: 'Team not found.' });

  targetTeam.disqualified = false;
  targetTeam.violations = 0;
  targetTeam.disqualifiedAt = null;
  targetTeam.disqualifiedReason = null;

  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  } catch (err) {
    console.error("Error writing teams.json during reinstate:", err);
    return res.status(500).json({ error: 'Failed to update teams.' });
  }

  io.emit('team:reinstated', { teamId: targetTeam.id, teamName: targetTeam.teamName });
  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');
  return res.json({ success: true, message: `Crew ${targetTeam.teamName} reinstated successfully!` });
});

// Admin Route: Reverse or Adjust Time for Individual Crew
app.post(['/api/admin/teams/reverse-time', '/api/admin/teams/forward-time'], (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: 'Admiralty authority required.' });
  const { round, minutes } = req.body || {};
  let action = req.body?.action;
  if (!action) {
    if (req.path.includes('forward-time')) action = 'add_time';
    else action = 'deduct_time';
  }
  const teamId = req.body?.teamId || req.body?.teamName;
  if (!teamId) return res.status(400).json({ error: 'teamId or teamName required.' });

  const targetTeam = teams.find(t => t.id === teamId || t.teamName.toLowerCase() === teamId.toLowerCase());
  if (!targetTeam) return res.status(404).json({ error: 'Team not found.' });

  const rKey = String(round || targetTeam.currentRound || 1);
  if (!targetTeam.roundTimers) targetTeam.roundTimers = {};
  if (!targetTeam.roundTimers[rKey]) {
    getTeamRoundTimer(targetTeam, rKey);
  }

  const tState = targetTeam.roundTimers[rKey];
  let logMessage = '';

  if (action === 'refund_hints') {
    const prevPen = tState.hintPenaltiesMinutes || 0;
    tState.hintPenaltiesMinutes = 0;
    targetTeam.totalHintPenaltyMinutes = Math.max(0, (targetTeam.totalHintPenaltyMinutes || 0) - prevPen);
    logMessage = `Reversed hint deductions for ${targetTeam.teamName} in Round ${rKey}: refunded ${prevPen} minutes.`;
  } else if (action === 'add_time' || action === 'reverse_time') {
    const minsToAdd = parseInt(minutes, 10) || 5;
    tState.bonusMinutes = (tState.bonusMinutes || 0) + minsToAdd;
    logMessage = `Reversed elapsed time for ${targetTeam.teamName} in Round ${rKey}: added +${minsToAdd} minutes.`;
  } else if (action === 'deduct_time') {
    const minsToDeduct = parseInt(minutes, 10) || 5;
    tState.hintPenaltiesMinutes = (tState.hintPenaltiesMinutes || 0) + minsToDeduct;
    targetTeam.totalHintPenaltyMinutes = (targetTeam.totalHintPenaltyMinutes || 0) + minsToDeduct;
    logMessage = `Deducted ${minsToDeduct} minutes for ${targetTeam.teamName} in Round ${rKey}.`;
  } else if (action === 'reset_clock') {
    const dur = tState.durationMinutes || (ctfConfig.roundDurations && ctfConfig.roundDurations[rKey]) || 30;
    tState.startedAt = Date.now();
    tState.hintPenaltiesMinutes = 0;
    tState.bonusMinutes = 0;
    tState.solved = false;
    tState.solvedAt = null;
    tState.finalSolveSeconds = null;
    logMessage = `Reset Round ${rKey} clock for ${targetTeam.teamName} to fresh ${dur} minutes.`;
  } else {
    const deltaMins = parseInt(minutes, 10);
    if (isNaN(deltaMins)) return res.status(400).json({ error: 'Invalid adjustment minutes.' });
    if (deltaMins >= 0) {
      tState.bonusMinutes = (tState.bonusMinutes || 0) + deltaMins;
      logMessage = `Adjusted clock for ${targetTeam.teamName} in Round ${rKey}: added +${deltaMins} minutes.`;
    } else {
      const pen = Math.abs(deltaMins);
      tState.hintPenaltiesMinutes = (tState.hintPenaltiesMinutes || 0) + pen;
      targetTeam.totalHintPenaltyMinutes = (targetTeam.totalHintPenaltyMinutes || 0) + pen;
      logMessage = `Adjusted clock for ${targetTeam.teamName} in Round ${rKey}: deducted -${pen} minutes.`;
    }
  }

  // If time deduction caused active round timer to expire, automatically disqualify crew
  if (checkTeamExpiryAndDisqualify(targetTeam, rKey)) {
    logMessage += ` Time deduction caused clock to expire (00:00). Crew automatically disqualified.`;
    io.emit('team:disqualified', {
      teamId: targetTeam.id,
      teamName: targetTeam.teamName,
      reason: targetTeam.disqualifiedReason
    });
  }

  try {
    fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
  } catch (err) {
    console.error("Error writing teams.json during time adjustment:", err);
    return res.status(500).json({ error: 'Failed to update teams.' });
  }

  const updatedTimer = getTeamRoundTimer(targetTeam, rKey);
  io.emit('teamsUpdate');
  io.emit('tournamentUpdate');

  return res.json({
    success: true,
    message: logMessage,
    teamId: targetTeam.id,
    teamName: targetTeam.teamName,
    round: rKey,
    timer: updatedTimer,
    disqualified: Boolean(targetTeam.disqualified),
    disqualifiedReason: targetTeam.disqualifiedReason || null
  });
});

// Admin Route: Get All Tournament Credentials
app.get('/api/admin/credentials', isAdmin, (req, res) => {
  const creds = getCredentials();
  const teamList = Object.keys(creds.teams || {}).map(teamName => {
    const t = teams.find(x => (x.teamName || '').toUpperCase() === teamName.toUpperCase());
    return {
      teamName,
      displayName: (t && t.displayName) || (t && t.teamName) || teamName,
      email: `${teamName.toLowerCase()}@lostcode`,
      password: creds.teams[teamName]
    };
  });
  res.json({
    success: true,
    credentials: creds,
    admin: creds.admin,
    teams: teamList,
    generatedAt: creds.generatedAt
  });
});

// Admin Route: Reset or Rotate Tournament Credentials
app.post('/api/admin/credentials/reset', isAdmin, (req, res) => {
  const { teamName, includeAdmin, all } = req.body || {};
  const creds = getCredentials();

  if (teamName) {
    const upperName = teamName.toUpperCase();
    if (upperName === 'ADMIN' || upperName === 'ADMIN@LOSTCODE') {
      const newPw = generateRandomPassword(8, 'adm_');
      creds.admin.password = newPw;
      saveCredentials(creds);

      const adminTeam = teams.find(t => isAdminTeam(t));
      if (adminTeam) {
        adminTeam.password = bcrypt.hashSync(newPw, 10);
        try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}
      }
      const adminUser = users.find(u => u.id === 'user_admin_1' || (u.username && u.username.toLowerCase() === 'admin@lostcode'));
      if (adminUser) {
        adminUser.password = bcrypt.hashSync(newPw, 10);
        try { fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2)); } catch (e) {}
      }

      logAuditEvent({
        action: 'RESET_ADMIN_PASSWORD',
        admin: req.session.teamName || 'admin',
        reason: 'Admin password rotated',
        details: { admin: 'admin@lostcode' }
      });

      return res.json({ success: true, teamName: 'admin', newPassword: newPw, credentials: creds });
    }

    const newPw = generateRandomPassword(6, `${upperName.toLowerCase()}_`);
    creds.teams[upperName] = newPw;
    saveCredentials(creds);

    const targetTeam = teams.find(t => (t.teamName || '').toUpperCase() === upperName);
    if (targetTeam) {
      targetTeam.password = bcrypt.hashSync(newPw, 10);
      try { fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2)); } catch (e) {}
    }
    const targetUser = users.find(u => (u.username || '').toUpperCase() === upperName);
    if (targetUser) {
      targetUser.password = bcrypt.hashSync(newPw, 10);
      try { fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2)); } catch (e) {}
    }

    logAuditEvent({
      action: 'RESET_TEAM_PASSWORD',
      admin: req.session.teamName || 'admin',
      reason: `Password rotated for crew ${upperName}`,
      details: { teamName: upperName }
    });

    return res.json({ success: true, teamName: upperName, newPassword: newPw, credentials: creds });
  } else {
    const shouldIncludeAdmin = Boolean(all || includeAdmin);
    const freshCreds = generateTournamentCredentials(shouldIncludeAdmin ? null : creds);
    saveCredentials(freshCreds);

    teams.forEach(t => {
      if (isAdminTeam(t)) {
        if (shouldIncludeAdmin) t.password = bcrypt.hashSync(freshCreds.admin.password, 10);
      } else {
        const pw = freshCreds.teams[(t.teamName || '').toUpperCase()];
        if (pw) t.password = bcrypt.hashSync(pw, 10);
      }
    });
    users.forEach(u => {
      if (u.id === 'user_admin_1' || (u.username && u.username.toLowerCase() === 'admin@lostcode')) {
        if (shouldIncludeAdmin) u.password = bcrypt.hashSync(freshCreds.admin.password, 10);
      } else {
        const pw = freshCreds.teams[(u.username || '').toUpperCase()];
        if (pw) u.password = bcrypt.hashSync(pw, 10);
      }
    });

    try {
      fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2));
      fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
    } catch (e) {}

    logAuditEvent({
      action: 'RESET_ALL_CREDENTIALS',
      admin: req.session.teamName || 'admin',
      reason: `All tournament passwords rotated (includeAdmin: ${shouldIncludeAdmin})`,
      details: { includeAdmin: shouldIncludeAdmin }
    });

    return res.json({
      success: true,
      credentials: freshCreds,
      admin: freshCreds.admin,
      generatedAt: freshCreds.generatedAt
    });
  }
});

// Admin Route: Restore Canonical Default Tournament Credentials
app.post('/api/admin/credentials/restore-default', isAdmin, (req, res) => {
  const restoredCreds = restoreDefaultTournamentCredentials();
  logAuditEvent({
    action: 'RESTORE_DEFAULT_CREDENTIALS',
    admin: req.session.teamName || 'admin',
    reason: 'Restored canonical tournament credentials for all teams and administrator',
    details: { admin: restoredCreds.admin.username }
  });
  return res.json({
    success: true,
    message: 'Default tournament credentials restored successfully!',
    credentials: restoredCreds,
    admin: restoredCreds.admin,
    generatedAt: restoredCreds.generatedAt
  });
});

app.get('/dashboard', (req, res) => {
  const team = getCurrentTeam(req);
  if (!team) return res.redirect('/');
  let html = fs.readFileSync(path.join(__dirname, 'private', 'dashboard.html'), 'utf8');
  if (isAdminSession(req)) {
    html = html.replace('id="adminNavLi" style="display:none;"', 'id="adminNavLi"');
    html = html.replace('<head>', '<head><script>window.isAdminUser = true;</script>');
  }
  res.send(html);
});

app.get('/dashboard-styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'styles.css'));
});

// Explicit root route for index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin shortcut redirect
app.get('/admin', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => { res.redirect('/'); });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\x1b[31m[ERROR]\x1b[0m Port ${PORT} is already in use by another process.`);
    console.error(`To free port ${PORT}, run: fuser -k ${PORT}/tcp or lsof -ti :${PORT} | xargs kill -9`);
    process.exit(1);
  } else {
    throw err;
  }
});

if (require.main === module) {
  startTournamentHeartbeatService();
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  io,
  teams,
  getTeams,
  atomicWriteJsonSync,
  getRiddleBank,
  saveRiddleBank,
  getTournamentAssignments,
  saveTournamentAssignments,
  getRoundState,
  saveRoundState,
  getConfig,
  saveConfig,
  getCredentials,
  saveCredentials,
  generateRandomPassword,
  generateTournamentCredentials,
  DEFAULT_TOURNAMENT_CREDENTIALS,
  restoreDefaultTournamentCredentials,
  logAuditEvent,
  findTeamSlotInRound,
  validateRoundConfiguration,
  checkTeamExpiryAndDisqualify,
  startTournamentHeartbeatService,
  stopTournamentHeartbeatService
};

