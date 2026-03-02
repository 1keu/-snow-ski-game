'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { Resend } = require('resend');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT           = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'snowadmin2024';
const MAX_FINISHERS  = 3;
const CANVAS_W       = 800;

// ── Penalty constants ─────────────────────────────────────────
const MIN_SPEED_VAL  = 0.3;
const MAX_SPEED_VAL  = 12.0;
const MIN_PENALTY_MS = 5000;    // 5 seconds at lowest speed
const MAX_PENALTY_MS = 60000;   // 60 seconds at top speed
const SQUARE_MULT    = 1.2;     // drift (square) penalty multiplier

function calcPenaltyMs(speed, typeMultiplier = 1.0) {
  const t   = Math.max(0, Math.min(1, (speed - MIN_SPEED_VAL) / (MAX_SPEED_VAL - MIN_SPEED_VAL)));
  const ms  = MIN_PENALTY_MS + (MAX_PENALTY_MS - MIN_PENALTY_MS) * Math.sqrt(t);
  return Math.round(ms * typeMultiplier);
}

// ── Course constants ──────────────────────────────────────────
const TOTAL_COURSE      = 1800;  // 30 min at 1× speed
const GAME_DURATION_MS  = 30 * 60 * 1000; // 30 minutes

const SHELTER_INTERVAL  = 180;
const SHELTER_SEED_XOR  = 0xBEEF4567;
const GAME_SEED_S       = 0xBEEFDEAD;

// ── Schedule state ────────────────────────────────────────────
// schedule: { startTime: Date | null, notifyEmails: Set }
let schedule = {
  startTime:    null,   // null = not scheduled
  notifyEmails: new Set(),
  notifyTimerId: null,
};

function getGamePhase() {
  if (!schedule.startTime) return 'waiting';
  const now     = Date.now();
  const start   = schedule.startTime.getTime();
  const end     = start + GAME_DURATION_MS;
  if (now < start)  return 'waiting';
  if (now <= end)   return 'active';
  return 'ended';
}

function scheduleNotification() {
  if (schedule.notifyTimerId) {
    clearTimeout(schedule.notifyTimerId);
    schedule.notifyTimerId = null;
  }
  if (!schedule.startTime) return;
  const notifyAt = schedule.startTime.getTime() - 30 * 60 * 1000;
  const delay    = notifyAt - Date.now();
  if (delay <= 0) return; // already past notification time
  schedule.notifyTimerId = setTimeout(() => {
    sendNotificationEmails();
  }, delay);
  console.log(`[schedule] 通知タイマー設定: ${Math.round(delay/1000)}秒後`);
}

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

function fromAddress() {
  return process.env.RESEND_FROM || 'onboarding@resend.dev';
}

async function sendNotificationEmails() {
  if (schedule.notifyEmails.size === 0) return;
  const resend = getResend();
  if (!resend) {
    console.log('[email] RESEND_API_KEY未設定のため通知スキップ');
    return;
  }
  const startStr = schedule.startTime
    ? schedule.startTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '';
  const gameUrl = process.env.GAME_URL || 'http://localhost:' + PORT;
  for (const email of schedule.notifyEmails) {
    try {
      await resend.emails.send({
        from:    fromAddress(),
        to:      email,
        subject: '⛷️ スキーゲーム開催30分前のお知らせ',
        text:    `スキーゲームが30分後（${startStr}）に開催されます！\n\nゲームURL: ${gameUrl}`,
        html:    `<p>⛷️ スキーゲームが<strong>30分後（${startStr}）</strong>に開催されます！</p><p><a href="${gameUrl}">ゲームを開く</a></p>`,
      });
      console.log(`[email] 通知送信: ${email}`);
    } catch (e) {
      console.error(`[email] 送信失敗 ${email}: ${e.message}`);
    }
  }
}

// ── Game state (in-memory) ────────────────────────────────────
let players      = {};
let finishers    = [];
let gameOver     = false;
let socketToUUID = {};
let usedBoxes    = new Set();
const pendingDisasters = new Map();

// ── Bots ─────────────────────────────────────────────────────
const BOT_DT   = 0.2;

const BOT_DEFS = [
  { name: 'たろう',  speed: 1.2,  amp: 95,  freq: 0.0018 * 48, phase: 0.0 },
  { name: 'はなこ',  speed: 0.9,  amp: 120, freq: 0.0025 * 48, phase: 1.1 },
  { name: 'ゆうき',  speed: 1.8,  amp: 70,  freq: 0.0030 * 48, phase: 2.3 },
  { name: 'さくら',  speed: 1.4,  amp: 105, freq: 0.0022 * 48, phase: 0.7 },
  { name: 'けんじ',  speed: 2.1,  amp: 60,  freq: 0.0040 * 48, phase: 3.5 },
  { name: 'みく',    speed: 0.7,  amp: 140, freq: 0.0015 * 48, phase: 4.2 },
  { name: 'りょう',  speed: 1.6,  amp: 85,  freq: 0.0028 * 48, phase: 1.8 },
  { name: 'あかね',  speed: 1.1,  amp: 110, freq: 0.0020 * 48, phase: 5.0 },
];

let bots = [];

function initBots() {
  bots = BOT_DEFS.map((def, i) => ({
    uuid:     `bot-${i}`,
    name:     def.name,
    progress: (TOTAL_COURSE / BOT_DEFS.length) * i * 0.15 + Math.random() * 40,
    x:        400,
    speed:    def.speed,
    amp:      def.amp,
    freq:     def.freq,
    phase:    def.phase,
    status:   'playing',
    isBot:    true,
  }));
}
initBots();

function tickBots() {
  if (gameOver) return;
  bots.forEach(bot => {
    bot.progress += bot.speed * BOT_DT;
    if (bot.progress >= TOTAL_COURSE) bot.progress = 0;
    bot.x = 400 + bot.amp * Math.sin(bot.freq * bot.progress + bot.phase);
  });
}

function createPlayer(uuid, name, joinedAt) {
  return {
    uuid,
    name,
    progress:          0,
    x:                 CANVAS_W / 2,
    speed:             1.0,
    status:            'playing',
    penaltyEnd:        null,
    joinedAt:          joinedAt || Date.now(),
    socketId:          null,
    items:             [],
    hotWaterProtection: false,
    speedBoostMult:    1,
    speedBoostEnd:     0,
  };
}

// ── Seeded RNG ────────────────────────────────────────────────
function serverMkRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= (s << 13) >>> 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

// ── Rock shelters ─────────────────────────────────────────────
function getShelterAt(ci) {
  const rng = serverMkRNG((((GAME_SEED_S ^ SHELTER_SEED_XOR) + ci * 0x846CA68B) >>> 0));
  if (rng() >= 0.65) return null;
  const base = ci * SHELTER_INTERVAL;
  return {
    prog: base + rng() * SHELTER_INTERVAL,
    cx:   180 + rng() * 440,
    w:    80  + rng() * 60,
    shadowDepth: 12,
  };
}

function isPlayerSheltered(p) {
  if (p.speed > 0.5) return false;
  const ci = Math.floor(p.progress / SHELTER_INTERVAL);
  for (let i = ci - 1; i <= ci + 1; i++) {
    if (i < 0) continue;
    const sh = getShelterAt(i);
    if (!sh) continue;
    if (p.progress >= sh.prog && p.progress <= sh.prog + sh.shadowDepth) {
      if (p.x >= sh.cx - sh.w / 2 && p.x <= sh.cx + sh.w / 2) return true;
    }
  }
  return false;
}

// ── Item helpers ──────────────────────────────────────────────
const BASE_ITEM_PENALTY_MS = 60 * 1000; // 1 minute for item effects

function applyPenaltyToPlayer(targetUuid, ms, msg) {
  const tp = players[targetUuid];
  if (!tp || tp.status === 'finished' || tp.status === 'disconnected' || tp.status === 'game_over') return;
  const now  = Date.now();
  const base = (tp.penaltyEnd && tp.penaltyEnd > now) ? tp.penaltyEnd : now;
  tp.penaltyEnd = base + ms;
  tp.status     = 'penalty';
  const ts = io.sockets.sockets.get(tp.socketId);
  if (ts) ts.emit('item_effect', { penaltyEnd: tp.penaltyEnd, msg });
  console.log(`[item_effect] ${tp.name} +${(ms / 60000).toFixed(1)}min → ${msg}`);
}

function applyToRandom(fromUuid, n, ms, msg) {
  const candidates = Object.keys(players).filter(uid =>
    uid !== fromUuid &&
    players[uid].status !== 'finished' &&
    players[uid].status !== 'disconnected' &&
    players[uid].status !== 'game_over'
  );
  candidates.sort(() => Math.random() - 0.5).slice(0, n)
    .forEach(uid => applyPenaltyToPlayer(uid, ms, msg));
}

function applyToRankN(rank, fromUuid, ms, msg) {
  const sorted = Object.values(players)
    .filter(p =>
      p.uuid !== fromUuid &&
      p.status !== 'finished' &&
      p.status !== 'disconnected' &&
      p.status !== 'game_over'
    )
    .sort((a, b) => b.progress - a.progress);
  if (sorted.length >= rank) applyPenaltyToPlayer(sorted[rank - 1].uuid, ms, msg);
}

// ── Disaster ──────────────────────────────────────────────────
function triggerDisaster(fromUuid, type, warnSec, penaltyMs, msg, targets) {
  const disasterId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  io.emit('disaster_warning', { type, disasterId, countdown: warnSec, msg });
  const timer = setTimeout(() => {
    pendingDisasters.delete(disasterId);
    targets.forEach(uid => {
      const tp = players[uid];
      if (!tp) return;
      if (tp.hotWaterProtection) {
        tp.hotWaterProtection = false;
        const ts = io.sockets.sockets.get(tp.socketId);
        if (ts) ts.emit('disaster_hit', { sheltered: true, protected: true });
        return;
      }
      if (isPlayerSheltered(tp)) {
        const ts = io.sockets.sockets.get(tp.socketId);
        if (ts) ts.emit('disaster_hit', { sheltered: true });
        return;
      }
      applyPenaltyToPlayer(uid, penaltyMs, msg);
      const ts = io.sockets.sockets.get(tp.socketId);
      if (ts) ts.emit('disaster_hit', { sheltered: false });
    });
  }, warnSec * 1000);
  pendingDisasters.set(disasterId, timer);
}

// ── Apply item effect ──────────────────────────────────────────
function applyItemEffect(uuid, p, itemId, socket) {
  io.emit('item_visual', { itemId, fromUuid: uuid, fromX: p.x, fromProgress: p.progress });
  const H = BASE_ITEM_PENALTY_MS;
  switch (itemId) {
    case 1:  applyToRandom(uuid, 1, 2 * H, '雪玉を食らった！+2分'); break;
    case 2:  applyToRankN(1, uuid, 3 * H, '大雪玉を食らった！+3分'); break;
    case 3:  applyToRandom(uuid, 3, H, '吹雪を食らった！+1分'); break;
    case 4: {
      const targets = Object.keys(players).filter(uid =>
        players[uid].status !== 'finished' &&
        players[uid].status !== 'disconnected' &&
        players[uid].status !== 'game_over'
      );
      triggerDisaster(uuid, 'avalanche', 15, 3 * H, '雪崩発生！+3分', targets);
      break;
    }
    case 5: {
      const targets = Object.keys(players)
        .filter(uid =>
          players[uid].status !== 'finished' &&
          players[uid].status !== 'disconnected' &&
          players[uid].status !== 'game_over' &&
          players[uid].progress > p.progress
        )
        .sort((a, b) => players[a].progress - players[b].progress)
        .slice(0, 3);
      triggerDisaster(uuid, 'snowman', 15, 2 * H, '雪だるまが迫る！+2分', targets);
      break;
    }
    case 6:
      p.progress = Math.min(TOTAL_COURSE - 1, p.progress + TOTAL_COURSE * 0.5);
      socket.emit('item_self_effect', { effect: 'teleport', progress: p.progress });
      break;
    case 7:
      p.hotWaterProtection = true;
      socket.emit('item_self_effect', { effect: 'hot_water' });
      break;
    case 8:
      p.speedBoostMult = 1.5;
      p.speedBoostEnd  = Date.now() + 3 * 60 * 1000; // 3 minutes
      socket.emit('item_self_effect', { effect: 'wax', speedBoostMult: 1.5, speedBoostEnd: p.speedBoostEnd });
      break;
    case 9:
      if (p.penaltyEnd) {
        p.penaltyEnd = Math.max(Date.now(), p.penaltyEnd - 3 * H);
        socket.emit('item_self_effect', { effect: 'coffee', penaltyEnd: p.penaltyEnd });
      }
      break;
    case 10: applyToRankN(1, uuid, 4 * H, '落とし穴にはまった！+4分'); break;
    case 11:
      p.progress = Math.min(TOTAL_COURSE - 1, p.progress + TOTAL_COURSE * 0.1);
      socket.emit('item_self_effect', { effect: 'rocket', progress: p.progress });
      break;
    case 12:
      p.speedBoostMult = 2.0;
      p.speedBoostEnd  = Date.now() + 2 * 60 * 1000; // 2 minutes
      socket.emit('item_self_effect', { effect: 'boost', speedBoostMult: 2.0, speedBoostEnd: p.speedBoostEnd });
      break;
    case 13: applyToRandom(uuid, 5, H, 'アイスバーン！+1分'); break;
    case 14: {
      const targets = Object.keys(players)
        .filter(uid =>
          players[uid].status !== 'finished' &&
          players[uid].status !== 'disconnected' &&
          players[uid].status !== 'game_over' &&
          players[uid].progress > p.progress
        )
        .sort((a, b) => players[a].progress - players[b].progress)
        .slice(0, 5);
      triggerDisaster(uuid, 'super_snowman', 15, 3 * H, 'スーパー雪だるま！+3分', targets);
      break;
    }
    case 15:
      p.penaltyEnd = null;
      if (p.status === 'penalty') p.status = 'playing';
      socket.emit('item_self_effect', { effect: 'onsen' });
      break;
    default: break;
  }
}

function getPublicState() {
  const visible = Object.values(players)
    .filter(p => p.status !== 'disconnected')
    .map(p => ({
      uuid:       p.uuid,
      name:       p.name,
      progress:   p.progress,
      x:          p.x,
      speed:      p.speed,
      status:     p.status,
      penaltyEnd: p.penaltyEnd,
      isBot:      false,
    }));

  const botVisible = bots.map(b => ({
    uuid:       b.uuid,
    name:       b.name,
    progress:   b.progress,
    x:          b.x,
    speed:      b.speed,
    status:     b.status,
    penaltyEnd: null,
    isBot:      true,
  }));

  return {
    players:     [...visible, ...botVisible],
    finishers,
    gameOver,
    playerCount: visible.filter(p => p.status !== 'game_over').length,
    phase:       getGamePhase(),
    startTime:   schedule.startTime ? schedule.startTime.getTime() : null,
  };
}

// Broadcast + tick bots every 200ms
setInterval(() => {
  if (getGamePhase() === 'active') tickBots();
  io.emit('state', getPublicState());
}, 200);

// ── Socket handlers ──────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Send current schedule phase immediately
  socket.emit('schedule_info', {
    phase:     getGamePhase(),
    startTime: schedule.startTime ? schedule.startTime.getTime() : null,
  });

  socket.on('join', ({ uuid, name }) => {
    if (!uuid || !name || typeof name !== 'string') return;
    const cleanName = name.trim().substring(0, 20);
    if (!cleanName) return;

    if (getGamePhase() !== 'active') {
      socket.emit('schedule_info', {
        phase:     getGamePhase(),
        startTime: schedule.startTime ? schedule.startTime.getTime() : null,
      });
      return;
    }

    socketToUUID[socket.id] = uuid;

    if (players[uuid]) {
      players[uuid].socketId = socket.id;
      if (players[uuid].status === 'disconnected') {
        if (players[uuid].penaltyEnd && players[uuid].penaltyEnd > Date.now()) {
          players[uuid].status = 'penalty';
        } else {
          players[uuid].status    = 'playing';
          players[uuid].penaltyEnd = null;
        }
      }
      console.log(`[rejoin] ${cleanName}`);
    } else {
      if (gameOver) { socket.emit('game_over', { finishers }); return; }
      players[uuid] = createPlayer(uuid, cleanName);
      players[uuid].socketId = socket.id;
      console.log(`[join] ${cleanName}`);
    }

    socket.emit('joined', { player: players[uuid], state: getPublicState() });
  });

  socket.on('register_email', ({ email }) => {
    if (!email || typeof email !== 'string') return;
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return;
    schedule.notifyEmails.add(clean);
    console.log(`[email] 登録: ${clean} (合計: ${schedule.notifyEmails.size}件)`);
    socket.emit('email_registered', { email: clean });
  });

  socket.on('update', ({ progress, x, speed }) => {
    const uuid = socketToUUID[socket.id];
    const p    = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (typeof progress !== 'number') return;
    p.progress = Math.max(0, progress);
    p.x        = Math.max(0, Math.min(CANVAS_W, x || CANVAS_W / 2));
    const maxSpd = (p.speedBoostEnd > Date.now()) ? 12 * p.speedBoostMult : 12;
    p.speed    = Math.max(0.3, Math.min(maxSpd, speed || 1));
  });

  socket.on('hit_tree', ({ speed, obsType }) => {
    const uuid = socketToUUID[socket.id];
    const p    = players[uuid];
    if (!p || p.status !== 'playing') return;
    const s          = Math.max(0.3, Math.min(12.0, speed || 1));
    const typeMult   = obsType === 'drift' ? SQUARE_MULT : 1.0;
    const penaltyMs  = calcPenaltyMs(s, typeMult);
    p.penaltyEnd     = Date.now() + penaltyMs;
    p.status         = 'penalty';
    socket.emit('penalty', { penaltyEnd: p.penaltyEnd, penaltyMs, speed: s });
    console.log(`[hit_tree] ${p.name} type=${obsType} speed=${s.toFixed(1)}× → ban ${(penaltyMs/1000).toFixed(0)}s`);
  });


  socket.on('penalty_done', () => {
    const uuid = socketToUUID[socket.id];
    const p    = players[uuid];
    if (!p || p.status !== 'penalty') return;
    if (p.penaltyEnd && Date.now() >= p.penaltyEnd) {
      p.status    = 'playing';
      p.penaltyEnd = null;
    }
  });

  socket.on('finish', () => {
    const uuid = socketToUUID[socket.id];
    const p    = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (finishers.length >= MAX_FINISHERS) return;
    if (finishers.find(f => f.uuid === uuid)) return;

    const totalTime = Date.now() - p.joinedAt;
    p.status = 'finished';
    const rank = finishers.length + 1;
    finishers.push({ uuid, name: p.name, rank, time: totalTime, finishedAt: Date.now() });
    socket.emit('you_finished', { rank, name: p.name, time: totalTime });
    io.emit('player_finished', { rank, name: p.name });
    console.log(`[finish] ${p.name} rank=${rank}`);

    if (finishers.length >= MAX_FINISHERS) {
      gameOver = true;
      Object.values(players).forEach(pl => {
        if (pl.status === 'playing' || pl.status === 'penalty') pl.status = 'game_over';
      });
      io.emit('game_over', { finishers });
      console.log('[game_over] TOP3 confirmed');
    }
  });

  socket.on('pick_item', ({ boxId }) => {
    const uuid = socketToUUID[socket.id];
    const p    = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (usedBoxes.has(boxId)) { socket.emit('item_rejected', { boxId }); return; }
    if (p.items.length >= 3)   { socket.emit('item_rejected', { boxId }); return; }
    usedBoxes.add(boxId);
    const itemId = Math.floor(Math.random() * 15) + 1;
    p.items.push(itemId);
    socket.emit('item_picked', { boxId, itemId });
  });

  socket.on('use_item', ({ slot, itemId }) => {
    const uuid = socketToUUID[socket.id];
    const p    = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (slot < 0 || slot > 2) return;
    if (p.items[slot] !== itemId) return;
    p.items.splice(slot, 1);
    socket.emit('item_used', { slot });
    applyItemEffect(uuid, p, itemId, socket);
  });

  socket.on('disconnect', () => {
    const uuid = socketToUUID[socket.id];
    if (uuid && players[uuid]) {
      if (players[uuid].status !== 'finished' && players[uuid].status !== 'game_over') {
        players[uuid].status = 'disconnected';
      }
      players[uuid].socketId = null;
      console.log(`[disconnect] ${players[uuid].name}`);
    }
    delete socketToUUID[socket.id];
  });
});

// ── Static files ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Admin REST ────────────────────────────────────────────────
app.post('/admin/reset', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'パスワードが違います' });

  players      = {};
  finishers    = [];
  gameOver     = false;
  socketToUUID = {};
  usedBoxes    = new Set();
  pendingDisasters.forEach(timer => clearTimeout(timer));
  pendingDisasters.clear();
  initBots();
  io.emit('game_reset');
  console.log('[admin] Game reset');
  res.json({ success: true });
});

app.post('/admin/schedule', (req, res) => {
  const { password, startTime } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'パスワードが違います' });
  if (!startTime) return res.status(400).json({ error: 'startTime が必要です' });

  const dt = new Date(startTime);
  if (isNaN(dt.getTime())) return res.status(400).json({ error: '無効な日時です' });

  schedule.startTime = dt;
  scheduleNotification();

  // Reset game state for new session
  players      = {};
  finishers    = [];
  gameOver     = false;
  socketToUUID = {};
  usedBoxes    = new Set();
  pendingDisasters.forEach(timer => clearTimeout(timer));
  pendingDisasters.clear();
  initBots();

  io.emit('schedule_updated', {
    phase:     getGamePhase(),
    startTime: schedule.startTime.getTime(),
  });
  console.log(`[admin] スケジュール設定: ${dt.toLocaleString('ja-JP')}`);
  res.json({ success: true, startTime: dt.toISOString(), phase: getGamePhase() });
});

app.get('/admin/schedule', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'パスワードが違います' });
  res.json({
    phase:        getGamePhase(),
    startTime:    schedule.startTime ? schedule.startTime.toISOString() : null,
    endTime:      schedule.startTime ? new Date(schedule.startTime.getTime() + GAME_DURATION_MS).toISOString() : null,
    notifyEmails: [...schedule.notifyEmails],
  });
});

app.post('/admin/test-email', async (req, res) => {
  const { password, to } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'パスワードが違います' });
  if (!to) return res.status(400).json({ error: '送信先メールアドレスが必要です' });
  const resend = getResend();
  if (!resend) return res.status(400).json({ error: 'RESEND_API_KEY が未設定です' });
  try {
    await resend.emails.send({
      from:    fromAddress(),
      to,
      subject: '⛷️ スキーゲーム テストメール',
      text:    'これはテストメールです。メール通知が正しく設定されています。',
    });
    console.log(`[admin] テストメール送信: ${to}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[admin] テストメール失敗:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/state', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'パスワードが違います' });
  res.json({
    playerCount: Object.keys(players).length,
    players: Object.values(players).map(p => ({
      name:      p.name,
      progress:  p.progress,
      status:    p.status,
      penaltyEnd: p.penaltyEnd,
      connected: !!p.socketId,
    })),
    finishers,
    gameOver,
    phase:     getGamePhase(),
    startTime: schedule.startTime ? schedule.startTime.toISOString() : null,
  });
});

server.listen(PORT, () => {
  console.log(`⛷️  Snow Ski Game → http://localhost:${PORT}`);
  console.log(`🔑 Admin: http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
});
