'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'snowadmin2024';
const MAX_FINISHERS = 3;
const BASE_PENALTY_MS = 60 * 60 * 1000; // 1 hour base
const CANVAS_W = 800;

const SHELTER_INTERVAL = 180;
const SHELTER_SEED_XOR = 0xBEEF4567;
const GAME_SEED_S = 0xBEEFDEAD;

// ── Game state (in-memory) ──────────────────────────────────
let players = {};      // uuid -> player data
let finishers = [];    // [{ uuid, name, rank, time, finishedAt }]
let gameOver = false;
let socketToUUID = {}; // socketId -> uuid
let usedBoxes = new Set();
const pendingDisasters = new Map();

// ── Bots ─────────────────────────────────────────────────────
const TOTAL_COURSE = 86400;
const BOT_DT       = 0.2; // seconds per tick (matches broadcast interval)

const BOT_DEFS = [
  { name: 'たろう',  speed: 1.2, amp: 95,  freq: 0.0018, phase: 0.0 },
  { name: 'はなこ',  speed: 0.9, amp: 120, freq: 0.0025, phase: 1.1 },
  { name: 'ゆうき',  speed: 1.8, amp: 70,  freq: 0.0030, phase: 2.3 },
  { name: 'さくら',  speed: 1.4, amp: 105, freq: 0.0022, phase: 0.7 },
  { name: 'けんじ',  speed: 2.1, amp: 60,  freq: 0.0040, phase: 3.5 },
  { name: 'みく',    speed: 0.7, amp: 140, freq: 0.0015, phase: 4.2 },
  { name: 'りょう',  speed: 1.6, amp: 85,  freq: 0.0028, phase: 1.8 },
  { name: 'あかね',  speed: 1.1, amp: 110, freq: 0.0020, phase: 5.0 },
];

let bots = [];

function initBots() {
  bots = BOT_DEFS.map((def, i) => ({
    uuid:     `bot-${i}`,
    name:     def.name,
    progress: (TOTAL_COURSE / BOT_DEFS.length) * i * 0.15 + Math.random() * 2000,
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
    if (bot.progress >= TOTAL_COURSE) bot.progress = 0; // loop
    bot.x = 400 + bot.amp * Math.sin(bot.freq * bot.progress + bot.phase);
  });
}

function createPlayer(uuid, name, joinedAt) {
  return {
    uuid,
    name,
    progress: 0,
    x: CANVAS_W / 2,
    speed: 1.0,
    status: 'playing', // playing | penalty | finished | disconnected | game_over
    penaltyEnd: null,
    joinedAt: joinedAt || Date.now(),
    socketId: null,
    items: [],
    hotWaterProtection: false,
    speedBoostMult: 1,
    speedBoostEnd: 0,
  };
}

// ── Seeded RNG (Xorshift32, identical to client mkRNG) ───────
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
    cx: 180 + rng() * 440,
    w: 80 + rng() * 60,
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

// ── Item effect helpers ───────────────────────────────────────
function applyPenaltyToPlayer(targetUuid, ms, msg) {
  const tp = players[targetUuid];
  if (!tp || tp.status === 'finished' || tp.status === 'disconnected' || tp.status === 'game_over') return;
  const now = Date.now();
  const base = (tp.penaltyEnd && tp.penaltyEnd > now) ? tp.penaltyEnd : now;
  tp.penaltyEnd = base + ms;
  tp.status = 'penalty';
  const ts = io.sockets.sockets.get(tp.socketId);
  if (ts) ts.emit('item_effect', { penaltyEnd: tp.penaltyEnd, msg });
  console.log(`[item_effect] ${tp.name} +${(ms / 3600000).toFixed(2)}h → ${msg}`);
}

function applyToRandom(fromUuid, n, ms, msg) {
  const candidates = Object.keys(players).filter(uid =>
    uid !== fromUuid &&
    players[uid].status !== 'finished' &&
    players[uid].status !== 'disconnected' &&
    players[uid].status !== 'game_over'
  );
  const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, n);
  shuffled.forEach(uid => applyPenaltyToPlayer(uid, ms, msg));
}

function applyToAhead(fromUuid, n, ms, msg) {
  const me = players[fromUuid];
  if (!me) return;
  const ahead = Object.keys(players)
    .filter(uid =>
      uid !== fromUuid &&
      players[uid].status !== 'finished' &&
      players[uid].status !== 'disconnected' &&
      players[uid].status !== 'game_over' &&
      players[uid].progress > me.progress
    )
    .sort((a, b) => players[a].progress - players[b].progress)
    .slice(0, n);
  ahead.forEach(uid => applyPenaltyToPlayer(uid, ms, msg));
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
  if (sorted.length >= rank) {
    applyPenaltyToPlayer(sorted[rank - 1].uuid, ms, msg);
  }
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
      // お湯 protection
      if (tp.hotWaterProtection) {
        tp.hotWaterProtection = false;
        const ts = io.sockets.sockets.get(tp.socketId);
        if (ts) ts.emit('disaster_hit', { sheltered: true, protected: true });
        return;
      }
      // Shelter check
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
  const H = BASE_PENALTY_MS; // 1 hour in ms
  switch (itemId) {
    case 1: // 雪玉 - Random 1 opponent +2h
      applyToRandom(uuid, 1, 2 * H, '雪玉を食らった！+2時間');
      break;
    case 2: // 大雪玉 - Rank-1 +3h
      applyToRankN(1, uuid, 3 * H, '大雪玉を食らった！+3時間');
      break;
    case 3: // 吹雪 - 3 random opponents +1h
      applyToRandom(uuid, 3, H, '吹雪を食らった！+1時間');
      break;
    case 4: { // 雪崩 - ALL players +3h (avoidable)
      const targets = Object.keys(players).filter(uid =>
        players[uid].status !== 'finished' &&
        players[uid].status !== 'disconnected' &&
        players[uid].status !== 'game_over'
      );
      triggerDisaster(uuid, 'avalanche', 30, 3 * H, '雪崩発生！+3時間', targets);
      break;
    }
    case 5: { // 雪だるま - 3 ahead +2h (avoidable)
      const targets = Object.keys(players)
        .filter(uid =>
          players[uid].status !== 'finished' &&
          players[uid].status !== 'disconnected' &&
          players[uid].status !== 'game_over' &&
          players[uid].progress > p.progress
        )
        .sort((a, b) => players[a].progress - players[b].progress)
        .slice(0, 3);
      triggerDisaster(uuid, 'snowman', 30, 2 * H, '雪だるまが迫る！+2時間', targets);
      break;
    }
    case 6: // 瞬間移動 - self progress += 50% of TOTAL_COURSE
      p.progress = Math.min(TOTAL_COURSE - 1, p.progress + TOTAL_COURSE * 0.5);
      socket.emit('item_self_effect', { effect: 'teleport', progress: p.progress });
      break;
    case 7: // お湯 - protect self from next disaster
      p.hotWaterProtection = true;
      socket.emit('item_self_effect', { effect: 'hot_water' });
      break;
    case 8: // ワックス - MAX_SPEED × 1.5 for 30 real minutes
      p.speedBoostMult = 1.5;
      p.speedBoostEnd = Date.now() + 30 * 60 * 1000;
      socket.emit('item_self_effect', { effect: 'wax', speedBoostMult: 1.5, speedBoostEnd: p.speedBoostEnd });
      break;
    case 9: // コーヒー - penaltyEnd -= 3h
      if (p.penaltyEnd) {
        p.penaltyEnd = Math.max(Date.now(), p.penaltyEnd - 3 * H);
        socket.emit('item_self_effect', { effect: 'coffee', penaltyEnd: p.penaltyEnd });
      }
      break;
    case 10: // 落とし穴 - Rank-1 +4h
      applyToRankN(1, uuid, 4 * H, '落とし穴にはまった！+4時間');
      break;
    case 11: // ロケット - self progress += 10%
      p.progress = Math.min(TOTAL_COURSE - 1, p.progress + TOTAL_COURSE * 0.1);
      socket.emit('item_self_effect', { effect: 'rocket', progress: p.progress });
      break;
    case 12: // ブースター - speed × 2 for 10 real minutes
      p.speedBoostMult = 2.0;
      p.speedBoostEnd = Date.now() + 10 * 60 * 1000;
      socket.emit('item_self_effect', { effect: 'boost', speedBoostMult: 2.0, speedBoostEnd: p.speedBoostEnd });
      break;
    case 13: // アイスバーン - 5 random opponents +1h
      applyToRandom(uuid, 5, H, 'アイスバーン！+1時間');
      break;
    case 14: { // スーパー雪だるま - 5 ahead +3h (avoidable)
      const targets = Object.keys(players)
        .filter(uid =>
          players[uid].status !== 'finished' &&
          players[uid].status !== 'disconnected' &&
          players[uid].status !== 'game_over' &&
          players[uid].progress > p.progress
        )
        .sort((a, b) => players[a].progress - players[b].progress)
        .slice(0, 5);
      triggerDisaster(uuid, 'super_snowman', 30, 3 * H, 'スーパー雪だるま！+3時間', targets);
      break;
    }
    case 15: // 温泉 - cancel own penalty immediately
      p.penaltyEnd = null;
      if (p.status === 'penalty') p.status = 'playing';
      socket.emit('item_self_effect', { effect: 'onsen' });
      break;
    default:
      break;
  }
}

function getPublicState() {
  const visible = Object.values(players)
    .filter(p => p.status !== 'disconnected')
    .map(p => ({
      uuid: p.uuid,
      name: p.name,
      progress: p.progress,
      x: p.x,
      speed: p.speed,
      status: p.status,
      penaltyEnd: p.penaltyEnd,
      isBot: false,
    }));

  const botVisible = bots.map(b => ({
    uuid:      b.uuid,
    name:      b.name,
    progress:  b.progress,
    x:         b.x,
    speed:     b.speed,
    status:    b.status,
    penaltyEnd: null,
    isBot:     true,
  }));

  const allVisible = [...visible, ...botVisible];

  return {
    players:     allVisible,
    finishers,
    gameOver,
    playerCount: visible.filter(p => p.status !== 'game_over').length,
  };
}

// Broadcast + tick bots every 200ms
setInterval(() => {
  tickBots();
  io.emit('state', getPublicState());
}, 200);

// ── Socket handlers ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('join', ({ uuid, name }) => {
    if (!uuid || !name || typeof name !== 'string') return;
    const cleanName = name.trim().substring(0, 20);
    if (!cleanName) return;

    socketToUUID[socket.id] = uuid;

    if (players[uuid]) {
      // Returning player: restore
      players[uuid].socketId = socket.id;
      if (players[uuid].status === 'disconnected') {
        // Restore penalty if still active, otherwise resume playing
        if (players[uuid].penaltyEnd && players[uuid].penaltyEnd > Date.now()) {
          players[uuid].status = 'penalty';
        } else {
          players[uuid].status = 'playing';
          players[uuid].penaltyEnd = null;
        }
      }
      console.log(`[rejoin] ${cleanName}`);
    } else {
      // New player
      if (gameOver) {
        socket.emit('game_over', { finishers });
        return;
      }
      players[uuid] = createPlayer(uuid, cleanName);
      players[uuid].socketId = socket.id;
      console.log(`[join] ${cleanName}`);
    }

    socket.emit('joined', {
      player: players[uuid],
      state: getPublicState(),
    });
  });

  socket.on('update', ({ progress, x, speed }) => {
    const uuid = socketToUUID[socket.id];
    const p = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (typeof progress !== 'number') return;

    p.progress = Math.max(0, progress);
    p.x = Math.max(0, Math.min(CANVAS_W, x || CANVAS_W / 2));
    const maxSpd = (p.speedBoostEnd > Date.now()) ? 12 * p.speedBoostMult : 12;
    p.speed = Math.max(0.3, Math.min(maxSpd, speed || 1));
  });

  socket.on('hit_tree', ({ speed }) => {
    const uuid = socketToUUID[socket.id];
    const p = players[uuid];
    if (!p || p.status !== 'playing') return;

    const s = Math.max(0.3, Math.min(12.0, speed || 1));
    const penaltyMs = Math.round(BASE_PENALTY_MS * s);
    p.penaltyEnd = Date.now() + penaltyMs;
    p.status = 'penalty';

    socket.emit('penalty', { penaltyEnd: p.penaltyEnd, penaltyMs, speed: s });
    console.log(`[hit_tree] ${p.name} speed=${s.toFixed(1)}x → ban ${(penaltyMs/3600000).toFixed(2)}h`);
  });

  socket.on('hit_cliff', () => {
    const uuid = socketToUUID[socket.id];
    const p = players[uuid];
    if (!p) return;

    p.progress = 0;
    p.x = CANVAS_W / 2;
    socket.emit('cliff_reset');
    console.log(`[hit_cliff] ${p.name} reset`);
  });

  socket.on('penalty_done', () => {
    const uuid = socketToUUID[socket.id];
    const p = players[uuid];
    if (!p || p.status !== 'penalty') return;
    if (p.penaltyEnd && Date.now() >= p.penaltyEnd) {
      p.status = 'playing';
      p.penaltyEnd = null;
    }
  });

  socket.on('finish', () => {
    const uuid = socketToUUID[socket.id];
    const p = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (finishers.length >= MAX_FINISHERS) return;
    if (finishers.find(f => f.uuid === uuid)) return;

    const totalTime = Date.now() - p.joinedAt;
    p.status = 'finished';

    const rank = finishers.length + 1;
    finishers.push({ uuid, name: p.name, rank, time: totalTime, finishedAt: Date.now() });

    socket.emit('you_finished', { rank, name: p.name, time: totalTime });
    io.emit('player_finished', { rank, name: p.name });
    console.log(`[finish] ${p.name} rank=${rank} time=${(totalTime/3600000).toFixed(2)}h`);

    if (finishers.length >= MAX_FINISHERS) {
      gameOver = true;
      Object.values(players).forEach(pl => {
        if (pl.status === 'playing' || pl.status === 'penalty') {
          pl.status = 'game_over';
        }
      });
      io.emit('game_over', { finishers });
      console.log('[game_over] TOP3 confirmed');
    }
  });

  socket.on('pick_item', ({ boxId }) => {
    const uuid = socketToUUID[socket.id];
    const p = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (usedBoxes.has(boxId)) {
      socket.emit('item_rejected', { boxId });
      return;
    }
    if (p.items.length >= 3) {
      socket.emit('item_rejected', { boxId });
      return;
    }
    usedBoxes.add(boxId);
    const itemId = Math.floor(Math.random() * 15) + 1;
    p.items.push(itemId);
    socket.emit('item_picked', { boxId, itemId });
    console.log(`[pick_item] ${p.name} got item ${itemId}`);
  });

  socket.on('use_item', ({ slot, itemId }) => {
    const uuid = socketToUUID[socket.id];
    const p = players[uuid];
    if (!p || p.status !== 'playing') return;
    if (slot < 0 || slot > 2) return;
    if (p.items[slot] !== itemId) return;
    p.items.splice(slot, 1);
    socket.emit('item_used', { slot });
    applyItemEffect(uuid, p, itemId, socket);
    console.log(`[use_item] ${p.name} used item ${itemId}`);
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

// ── Admin REST ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/admin/reset', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  players = {};
  finishers = [];
  gameOver = false;
  socketToUUID = {};
  usedBoxes = new Set();
  pendingDisasters.forEach(timer => clearTimeout(timer));
  pendingDisasters.clear();
  initBots();

  io.emit('game_reset');
  console.log('[admin] Game reset');
  res.json({ success: true, message: 'ゲームをリセットしました' });
});

app.get('/admin/state', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  res.json({
    playerCount: Object.keys(players).length,
    players: Object.values(players).map(p => ({
      name: p.name,
      progress: p.progress,
      status: p.status,
      penaltyEnd: p.penaltyEnd,
      connected: !!p.socketId,
    })),
    finishers,
    gameOver,
  });
});

server.listen(PORT, () => {
  console.log(`⛷️  Snow Ski Game → http://localhost:${PORT}`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
});
