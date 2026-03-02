'use strict';
// ════════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════════
const TOTAL_COURSE   = 1800;    // 1× speed → 30 min, 12× speed → ~2.5 min
const MIN_SPEED      = 0.3;
const MAX_SPEED      = 12.0;
const GAME_W         = 800;
const BASE_PPU       = 50;
const GAME_SEED      = 0xBEEFDEAD;
const CHUNK_SIZE     = 10;
const SYNC_MS        = 150;
const P_HALF_W       = 11;
const P_HALF_H       = 11;
const SIDEBAR_L      = 120;
const SIDEBAR_R      = 240;

const COL_BG   = '#FFFFFF';
const COL_DARK = '#1A1A2E';

const ITEM_BOX_INTERVAL = 15;
const ITEM_BOX_SEED_XOR = 0xDEAD1234;
const SHELTER_INTERVAL  = 180;
const SHELTER_SEED_XOR  = 0xBEEF4567;

const ITEMS = [
  { id:1,  name:'ゆきだま',               icon:'⚪', desc:'あいて1にん+2じかん' },
  { id:2,  name:'おおゆきだま',           icon:'🔵', desc:'1い+3じかん' },
  { id:3,  name:'ふぶき',                 icon:'❄️',  desc:'らんだむ3にん+1じかん' },
  { id:4,  name:'なだれ',                 icon:'🏔️',  desc:'ぜんいん+3じかん(いわかげでかいひか)' },
  { id:5,  name:'ゆきだるま',             icon:'⛄', desc:'ぜんぽう3にん+2じかん(かいひか)' },
  { id:6,  name:'しゅんかんいどう',       icon:'⚡', desc:'じぶん+50%すすむ' },
  { id:7,  name:'おゆ',                   icon:'♨️',  desc:'つぎのさいがいをむこうか' },
  { id:8,  name:'わっくす',               icon:'🎿', desc:'さいこうそく×1.5 30ふん' },
  { id:9,  name:'こーひー',               icon:'☕', desc:'ぺなるてぃ-3じかん' },
  { id:10, name:'おとしあな',             icon:'🕳️',  desc:'1い+4じかん' },
  { id:11, name:'ろけっと',               icon:'🚀', desc:'じぶん+10%すすむ' },
  { id:12, name:'ぶーすたー',             icon:'💨', desc:'そくど×2 10ふん' },
  { id:13, name:'あいすばーん',           icon:'🧊', desc:'らんだむ5にん+1じかん' },
  { id:14, name:'すーぱーゆきだるま',     icon:'⛰️',  desc:'ぜんぽう5にん+3じかん(かいひか)' },
  { id:15, name:'おんせん',               icon:'🛁', desc:'じぶんのぺなるてぃそくじかいじょ' },
];

// ── Dynamic screen dimensions ──
let CW, CH, SX, PPU, B_PY;

function resize() {
  CW = canvas.width  = window.innerWidth - SIDEBAR_L - SIDEBAR_R;
  CH = canvas.height = window.innerHeight;
  SX  = CW / GAME_W;
  PPU = BASE_PPU * (CH / 600);
  B_PY = CH * 0.22;
}

function PY() {
  const t = (mySpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED);
  return B_PY + t * CH * 0.18;
}
function scY(wp) { return PY() + (wp - myProgress) * PPU; }
function scX(lx) { return lx * SX; }

// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════
let myUUID        = null;
let myName        = '';
let myProgress    = 0;
let myX           = GAME_W / 2;
let mySpeed       = 1.0;
let myStatus      = 'join';
let awaitServer   = false;
let penaltyEnd    = null;
let gracePeriodEnd = 0;
let joinedAt      = 0;
let hitSet        = new Set();
let lastSync      = 0;
let lastFrameTs   = 0;
let penaltyTimer  = null;
let paused        = false;
let targetX       = GAME_W / 2;

let serverPlayers   = [];
let serverFinishers = [];
let serverCount     = 0;

let mouseX = GAME_W / 2;
let mouseY = 300;

// Item state
let itemSlots    = [null, null, null];
let pickedBoxes  = new Set();
let speedBoostMult = 1.0;
let speedBoostEnd  = 0;
let toastTimer   = null;
const stageFX    = [];

// Track history for curved trails
const TRACK_MAX  = 120;
const trackHistory = [];

// Speed-line particles
const SL = Array.from({length: 24}, () => ({
  x: Math.random() * GAME_W,
  y: Math.random() * 600,
  len: 12 + Math.random() * 28,
}));

// ════════════════════════════════════════════════════════════
//  CANVAS
// ════════════════════════════════════════════════════════════
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

window.addEventListener('resize', resize);
resize();

// ════════════════════════════════════════════════════════════
//  UUID
// ════════════════════════════════════════════════════════════
function getUUID() {
  let id = localStorage.getItem('skiUUID');
  if (!id) {
    id = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    localStorage.setItem('skiUUID', id);
  }
  return id;
}

// ════════════════════════════════════════════════════════════
//  SEEDED RNG
// ════════════════════════════════════════════════════════════
function mkRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= (s << 13) >>> 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

// ════════════════════════════════════════════════════════════
//  OBSTACLES
// ════════════════════════════════════════════════════════════
const chunkCache  = new Map();
const MIN_PASS    = 44; // minimum gap width (logical units) that board must fit through

// Returns true if sortedIntervals leave at least one gap >= minPass within [lo, hi]
function hasPassage(sorted, lo, hi, minPass) {
  if (!sorted.length) return true;
  if (sorted[0][0] - lo >= minPass) return true;
  if (hi - sorted[sorted.length - 1][1] >= minPass) return true;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1][0] - sorted[i][1] >= minPass) return true;
  }
  return false;
}

function chunkObs(ci) {
  if (chunkCache.has(ci)) return chunkCache.get(ci);
  const rng  = mkRNG((GAME_SEED + ci * 2654435761) >>> 0);
  const base = ci * CHUNK_SIZE;

  // Density grows linearly with progress: 1-2 near start, up to 1-7 near goal
  const pct  = Math.min(1, base / TOTAL_COURSE);
  const nMax = 2 + Math.floor(pct * 5);          // 2 → 7
  const n    = 1 + Math.floor(rng() * nMax);

  const PL   = 10;
  const PR   = GAME_W - 10;
  const list = [];
  const placed = []; // [x, x+w] intervals already placed in this chunk

  for (let i = 0; i < n; i++) {
    const r    = rng();
    const type = r < 0.55 ? 'tree' : r < 0.8 ? 'rock' : 'drift';
    const w    = type === 'tree' ? 24 + rng()*14 : type === 'rock' ? 28 + rng()*18 : 32 + rng()*22;
    const h    = type === 'tree' ? 44 + rng()*24 : type === 'rock' ? 18 + rng()*14 : 10 + rng()*8;
    const prog = base + rng() * CHUNK_SIZE;

    // Find a valid x that keeps at least one MIN_PASS corridor
    let x = PL + rng() * Math.max(1, PR - PL - w);
    let valid = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const test = [...placed, [x, x + w]].sort((a, b) => a[0] - b[0]);
      if (hasPassage(test, PL, PR, MIN_PASS)) { valid = true; break; }
      x = PL + rng() * Math.max(1, PR - PL - w);
    }
    if (!valid) continue; // skip if no valid position found

    placed.push([x, x + w]);
    list.push({ id:`${ci}_${i}`, type, prog, x, w, h });
  }
  chunkCache.set(ci, list);
  if (chunkCache.size > 120) chunkCache.delete(chunkCache.keys().next().value);
  return list;
}

function nearbyObs(prog) {
  const ahead  = CH / PPU + 4;
  const behind = 2;
  const s = Math.max(0, Math.floor((prog - behind) / CHUNK_SIZE));
  const e = Math.ceil((prog + ahead) / CHUNK_SIZE);
  const out = [];
  for (let c = s; c <= e; c++) {
    for (const o of chunkObs(c)) {
      if (o.prog >= prog - behind && o.prog <= prog + ahead) out.push(o);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════
//  ITEM BOXES
// ════════════════════════════════════════════════════════════
function chunkItemBoxes(ci) {
  const rng = mkRNG(((GAME_SEED ^ ITEM_BOX_SEED_XOR) + ci * 0x6B8B4567) >>> 0);
  if (rng() < 0.55) {
    const base = ci * ITEM_BOX_INTERVAL;
    return [{ id: `box_${ci}`, prog: base + rng() * ITEM_BOX_INTERVAL, x: 50 + rng() * (GAME_W - 100) }];
  }
  return [];
}

function nearbyItemBoxes(prog) {
  const ahead  = CH / PPU + 4;
  const behind = 2;
  const s = Math.max(0, Math.floor((prog - behind) / ITEM_BOX_INTERVAL));
  const e = Math.ceil((prog + ahead) / ITEM_BOX_INTERVAL);
  const out = [];
  for (let c = s; c <= e; c++) {
    for (const b of chunkItemBoxes(c)) {
      if (b.prog >= prog - behind && b.prog <= prog + ahead) out.push(b);
    }
  }
  return out;
}

// Rock obstacles oscillate left/right (deterministic per obstacle)
function getRockOffset(o) {
  const hash = o.id.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
  const freq  = 0.3 + (hash % 100) / 100 * 0.4;   // 0.3–0.7 Hz
  const phase = (hash * 0.618) % (Math.PI * 2);
  const amp   = 40 + (hash % 40);                  // 40–80 logical units
  const raw   = Math.sin(performance.now() / 1000 * freq * Math.PI * 2 + phase) * amp;
  // Clamp so rock stays on stage
  const newX  = o.x + raw;
  return Math.max(0, Math.min(GAME_W - o.w, newX)) - o.x;
}

// ════════════════════════════════════════════════════════════
//  ROCK SHELTERS
// ════════════════════════════════════════════════════════════
function getShelterAt(ci) {
  const rng = mkRNG((((GAME_SEED ^ SHELTER_SEED_XOR) + ci * 0x846CA68B) >>> 0));
  if (rng() >= 0.65) return null;
  const base = ci * SHELTER_INTERVAL;
  return {
    id: `sh_${ci}`,
    prog: base + rng() * SHELTER_INTERVAL,
    cx: 180 + rng() * 440,
    w: 80 + rng() * 60,
    shadowDepth: 12,
  };
}

function nearbyShelters(prog) {
  const ahead  = CH / PPU + 4;
  const behind = 2;
  const s = Math.max(0, Math.floor((prog - behind) / SHELTER_INTERVAL));
  const e = Math.ceil((prog + ahead) / SHELTER_INTERVAL);
  const out = [];
  for (let c = s; c <= e; c++) {
    const sh = getShelterAt(c);
    if (sh && sh.prog >= prog - behind && sh.prog <= prog + ahead) out.push(sh);
  }
  return out;
}

function isInShelter() {
  if (mySpeed > 0.5) return false;
  const ci = Math.floor(myProgress / SHELTER_INTERVAL);
  for (let i = ci - 1; i <= ci + 1; i++) {
    if (i < 0) continue;
    const sh = getShelterAt(i);
    if (!sh) continue;
    if (myProgress >= sh.prog && myProgress <= sh.prog + sh.shadowDepth) {
      if (myX >= sh.cx - sh.w / 2 && myX <= sh.cx + sh.w / 2) return true;
    }
  }
  return false;
}

// ════════════════════════════════════════════════════════════
//  COLLISION
// ════════════════════════════════════════════════════════════
function isHit(o) {
  const screenDy = (o.prog - myProgress) * PPU;
  const oScreenY = PY() + screenDy;
  if (Math.abs(oScreenY - PY()) > o.h * SX / 2 + P_HALF_H * SX + 4) return false;
  const rockOff = o.type === 'rock' ? getRockOffset(o) : 0;
  const ox = (o.x + rockOff) * SX;
  const px = myX * SX;
  return (px + P_HALF_W * SX - 4) > (ox + 4) &&
         (px - P_HALF_W * SX + 4) < (ox + o.w * SX - 4);
}

function checkItemBoxCollisions() {
  if (myStatus !== 'playing' || Date.now() < gracePeriodEnd) return;
  for (const b of nearbyItemBoxes(myProgress)) {
    if (pickedBoxes.has(b.id)) continue;
    // Y check: progress-based distance converted to screen pixels
    const screenDy = (b.prog - myProgress) * PPU;
    if (Math.abs(screenDy) > (P_HALF_H + 10) * SX + 10) continue;
    // X check: logical units (no shrinkage margin for easier pickup)
    if (Math.abs(myX - b.x) < P_HALF_W + 10) {
      pickedBoxes.add(b.id);
      socket.emit('pick_item', { boxId: b.id });
    }
  }
}

// ════════════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════════════
function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor(s % 3600 / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/3600)}じかん${String(Math.floor(s%3600/60)).padStart(2,'0')}ふん${String(s%60).padStart(2,'0')}びょう`;
}

function effectiveMaxSpeed() {
  return speedBoostEnd > Date.now() ? MAX_SPEED * speedBoostMult : MAX_SPEED;
}

// ════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════
const socket = io();

// Auto-rejoin if saved session exists
socket.on('connect', () => {
  const savedName = localStorage.getItem('skiName');
  const savedUUID = localStorage.getItem('skiUUID');
  if (savedName && savedUUID && myStatus === 'join') {
    myUUID = savedUUID;
    myName = savedName;
    const inp = document.getElementById('nameInput');
    if (inp) inp.value = savedName;
    socket.emit('join', { uuid: myUUID, name: myName });
  }
});

socket.on('joined', ({ player, state }) => {
  syncState(state);
  if (!player) return;

  if ((state && state.gameOver) || player.status === 'game_over') {
    showGameOver(state.finishers || []);
    return;
  }

  myProgress = player.progress || 0;
  myX = player.x || GAME_W / 2;
  targetX = myX;
  joinedAt = player.joinedAt || Date.now();

  if (player.status === 'penalty' && player.penaltyEnd && player.penaltyEnd > Date.now()) {
    penaltyEnd = player.penaltyEnd;
    myStatus = 'penalty';
    showScreen('penalty');
    startCountdown();
  } else {
    myStatus = 'playing';
    gracePeriodEnd = Date.now() + 1500;
    showScreen('game');
  }
});

socket.on('state', syncState);

socket.on('penalty', ({ penaltyEnd: pe }) => {
  penaltyEnd  = pe;
  awaitServer = false;
  myStatus    = 'penalty';
  paused      = false;
  showScreen('penalty');
  startCountdown();
});


socket.on('you_finished', ({ rank, name, time }) => {
  window.location.href =
    `/finish.html?name=${encodeURIComponent(name)}&rank=${rank}&time=${time}`;
});

socket.on('game_over',  ({ finishers }) => showGameOver(finishers));
socket.on('game_reset', () => { localStorage.removeItem('skiUUID'); location.reload(); });

socket.on('schedule_info', ({ phase, startTime }) => {
  handleSchedulePhase(phase, startTime);
});
socket.on('schedule_updated', ({ phase, startTime }) => {
  handleSchedulePhase(phase, startTime);
});

socket.on('email_registered', ({ email }) => {
  const msg = document.getElementById('emailMsg');
  if (msg) { msg.textContent = `✓ ${email} にとうろくしました`; msg.style.color = '#34C759'; }
});

// ── Item socket events ──
socket.on('item_picked', ({ boxId, itemId }) => {
  const emptySlot = itemSlots.indexOf(null);
  if (emptySlot === -1) return;
  itemSlots[emptySlot] = itemId;
  updateItemSlotsUI();
});

socket.on('item_rejected', ({ boxId }) => {
  pickedBoxes.delete(boxId);
});

socket.on('item_used', ({ slot }) => {
  itemSlots.splice(slot, 1);
  itemSlots.push(null);
  updateItemSlotsUI();
});

socket.on('item_self_effect', ({ effect, progress, penaltyEnd: pe, speedBoostMult: sbm, speedBoostEnd: sbe }) => {
  switch (effect) {
    case 'teleport':
    case 'rocket':
      if (progress !== undefined) {
        myProgress = progress;
        hitSet.clear();
        trackHistory.length = 0;
        pickedBoxes.clear();
      }
      break;
    case 'wax':
    case 'boost':
      if (sbm !== undefined) speedBoostMult = sbm;
      if (sbe !== undefined) speedBoostEnd = sbe;
      break;
    case 'coffee':
      if (pe !== undefined && penaltyEnd !== null) {
        penaltyEnd = pe;
      }
      break;
    case 'onsen':
      penaltyEnd = null;
      if (myStatus === 'penalty') {
        if (penaltyTimer) { clearInterval(penaltyTimer); penaltyTimer = null; }
        myStatus = 'playing';
        gracePeriodEnd = Date.now() + 2000;
        showScreen('game');
      }
      break;
    case 'hot_water':
      showToast('♨️ おゆをそうび！つぎのさいがいをむこうか', 5);
      break;
    default:
      break;
  }
});

socket.on('item_effect', ({ penaltyEnd: pe, msg }) => {
  penaltyEnd  = pe;
  awaitServer = false;
  myStatus    = 'penalty';
  paused      = false;
  showScreen('penalty');
  startCountdown();
});

socket.on('disaster_warning', ({ type, disasterId, countdown, msg }) => {
  showToast(`⚠️ ${msg}`, countdown);
  const iconMap = { avalanche: '🏔️', snowman: '⛄', super_snowman: '⛰️' };
  const icon = iconMap[type] || '⚠️';
  const particles = Array.from({ length: 20 }, () => ({
    sx: Math.random() * CW,
    sy: Math.random() * CH,
    vel: 40 + Math.random() * 40,
    vx: (Math.random() - 0.5) * 20,
  }));
  addStageFX({ type: 'disaster_particles', icon, particles, t: countdown, maxT: countdown });
});

socket.on('disaster_hit', ({ sheltered, protected: prot }) => {
  if (sheltered || prot) {
    hideToast();
    showToast('🪨 いわかげでかいひ！', 3);
    addStageFX({ type: 'screen_flash', color: '#44FF88', t: 0.7, maxT: 0.7 });
  } else {
    addStageFX({ type: 'screen_flash', color: '#FF4444', t: 0.7, maxT: 0.7 });
  }
});

socket.on('item_visual', ({ itemId, fromUuid, fromX, fromProgress }) => {
  const def = ITEMS.find(it => it.id === itemId);
  if (!def) return;
  addStageFX({
    type: 'float_icon',
    icon: def.icon,
    sx: scX(fromX),
    sy: scY(fromProgress),
    vy: -60,
    t: 2.0,
    maxT: 2.0,
  });
});

function syncState(s) {
  if (!s) return;
  serverPlayers   = s.players   || [];
  serverFinishers = s.finishers || [];
  serverCount     = s.playerCount || 0;
  updateHUD();
}

// ════════════════════════════════════════════════════════════
//  PENALTY COUNTDOWN
// ════════════════════════════════════════════════════════════
function startCountdown() {
  if (penaltyTimer) clearInterval(penaltyTimer);
  const el = document.getElementById('penaltyCountdown');
  const tick = () => {
    const rem = penaltyEnd - Date.now();
    if (el) el.textContent = fmt(rem);
    if (rem <= 0) {
      clearInterval(penaltyTimer);
      penaltyTimer = null;
      penaltyEnd   = null;
      gracePeriodEnd = Date.now() + 2000;
      myStatus = 'playing';
      socket.emit('penalty_done');
      showScreen('game');
    }
  };
  tick();
  penaltyTimer = setInterval(tick, 500);
}

// ════════════════════════════════════════════════════════════
//  HUD / SIDEBARS
// ════════════════════════════════════════════════════════════
function updateItemSlotsUI() {
  for (let i = 0; i < 3; i++) {
    const slot = document.getElementById(`itemSlot${i}`);
    if (!slot) continue;
    const itemId = itemSlots[i];
    if (itemId !== null) {
      const def = ITEMS.find(it => it.id === itemId);
      slot.classList.add('filled');
      let icon = slot.querySelector('.item-icon');
      if (!icon) {
        icon = document.createElement('span');
        icon.className = 'item-icon';
        slot.insertBefore(icon, slot.firstChild);
      }
      icon.textContent = def ? def.icon : '?';
      slot.title = def ? `${def.name}: ${def.desc}` : '';
    } else {
      slot.classList.remove('filled');
      const icon = slot.querySelector('.item-icon');
      if (icon) icon.remove();
      slot.title = '';
    }
  }
}

function showToast(msg, sec) {
  if (toastTimer) clearInterval(toastTimer);
  const toast = document.getElementById('disasterToast');
  const msgEl = document.getElementById('toastMsg');
  const cdEl  = document.getElementById('toastCd');
  if (!toast || !msgEl || !cdEl) return;
  toast.classList.remove('hidden');
  msgEl.textContent = msg;
  let rem = Math.ceil(sec);
  cdEl.textContent = rem > 0 ? `${rem}s` : '';
  if (rem <= 0) { hideToast(); return; }
  toastTimer = setInterval(() => {
    rem--;
    if (rem <= 0) {
      hideToast();
    } else {
      cdEl.textContent = `${rem}s`;
    }
  }, 1000);
}

function hideToast() {
  if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
  const toast = document.getElementById('disasterToast');
  if (toast) toast.classList.add('hidden');
}

function updateHUD() {
  // Player count
  const ce = document.getElementById('countNum');
  if (ce) ce.textContent = serverCount;

  // My rank panel
  const myRankEl = document.getElementById('myRankDisplay');
  if (myRankEl && myUUID) {
    const fUUIDs = new Set(serverFinishers.map(f => f.uuid));
    const myFinisher = serverFinishers.find(f => f.uuid === myUUID);
    if (myFinisher) {
      myRankEl.textContent = `${myFinisher.rank} い`;
    } else {
      const active = serverPlayers
        .filter(p => !fUUIDs.has(p.uuid) && p.status !== 'disconnected')
        .sort((a, b) => b.progress - a.progress);
      const myIdx = active.findIndex(p => p.uuid === myUUID);
      if (myIdx >= 0) {
        myRankEl.textContent = `${serverFinishers.length + myIdx + 1} い`;
      } else {
        myRankEl.textContent = '-- 位';
      }
    }
  }

  // Ranking (right sidebar)
  const rl = document.getElementById('rankingList');
  if (rl) {
    const fUUIDs = new Set(serverFinishers.map(f => f.uuid));
    const rows = [];
    serverFinishers.forEach((f, i) => {
      rows.push({ name: f.name, rank: i+1, pct: 100, status: 'finished', isMe: f.uuid === myUUID });
    });
    serverPlayers
      .filter(p => !fUUIDs.has(p.uuid) && p.status !== 'disconnected')
      .sort((a, b) => b.progress - a.progress)
      .forEach((p, i) => {
        rows.push({
          name: p.name,
          rank: serverFinishers.length + i + 1,
          pct: p.progress / TOTAL_COURSE * 100,
          status: p.status,
          isMe: p.uuid === myUUID,
        });
      });

    rl.innerHTML = rows.slice(0, 16).map(r => {
      const icon = r.status === 'finished' ? ' ✓' : r.status === 'penalty' ? ' ×' : '';
      const cls  = [
        'ranking-entry',
        r.isMe ? 'is-me' : '',
        r.status === 'penalty'  ? 'status-penalty'  : '',
        r.status === 'finished' ? 'status-finished' : '',
      ].join(' ');
      return `<div class="${cls}">
        <span class="rank">${r.rank}</span>
        <span class="name">${r.name.slice(0,12)}${icon}</span>
        <span class="pct">${r.pct.toFixed(1)}%</span>
      </div>`;
    }).join('');
  }

  // Speed bar (left sidebar)
  const pct = (mySpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED);
  const sf  = document.getElementById('speedFill');
  const sv  = document.getElementById('speedValue');
  if (sf) sf.style.height = (pct * 100) + '%';
  if (sv) sv.textContent  = mySpeed.toFixed(1) + '×';

  // Stage minimap (left sidebar)
  updateStageMinimap();
  updateItemSlotsUI();
}

function updateStageMinimap() {
  const markers = document.getElementById('stageMarkers');
  if (!markers) return;

  // Build sorted list for top3 detection
  const fUUIDs = new Set(serverFinishers.map(f => f.uuid));
  const active = serverPlayers.filter(p => p.status !== 'disconnected' && !fUUIDs.has(p.uuid));
  const sorted = [...active].sort((a, b) => b.progress - a.progress);
  const top3UUIDs = new Set(sorted.slice(0, 3).map(p => p.uuid));

  const dots = [];

  // Finishers at 100%
  serverFinishers.forEach(f => {
    dots.push({ pct: 100, isMe: f.uuid === myUUID, isTop3: true, name: f.name });
  });

  // Active players
  serverPlayers.forEach(p => {
    if (p.status === 'disconnected') return;
    if (fUUIDs.has(p.uuid)) return;
    const pct = Math.min(99.9, p.progress / TOTAL_COURSE * 100);
    const isTop3 = top3UUIDs.has(p.uuid);
    dots.push({ pct, isMe: p.uuid === myUUID, isTop3, name: p.name });
  });

  markers.innerHTML = dots.map(d => {
    const label = (d.isTop3 || d.isMe)
      ? `<span class="dot-label">${d.pct.toFixed(1)}%</span>`
      : '';
    return `<div class="stage-dot ${d.isMe ? 'is-me' : ''} ${d.isTop3 && !d.isMe ? 'is-top3' : ''}"
      style="top:${d.pct.toFixed(2)}%"
      title="${d.name}: ${d.pct.toFixed(1)}%">${label}</div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════
//  STAGE FX
// ════════════════════════════════════════════════════════════
function addStageFX(fx) { stageFX.push(fx); }

function updateStageFX(dt) {
  for (let i = stageFX.length - 1; i >= 0; i--) {
    const fx = stageFX[i];
    fx.t -= dt;
    if (fx.t <= 0) { stageFX.splice(i, 1); continue; }
    if (fx.type === 'float_icon') {
      fx.sy += fx.vy * dt;
    } else if (fx.type === 'disaster_particles') {
      fx.particles.forEach(p => {
        p.sy += p.vel * dt;
        p.sx += p.vx * dt;
        if (p.sy > CH + 30) p.sy = -30;
      });
    }
  }
}

function drawStageFX() {
  for (const fx of stageFX) {
    ctx.save();
    if (fx.type === 'float_icon') {
      ctx.globalAlpha = Math.max(0, fx.t / fx.maxT);
      ctx.font = `${Math.round(22 * SX)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fx.icon, fx.sx, fx.sy);
    } else if (fx.type === 'screen_flash') {
      ctx.globalAlpha = Math.max(0, (fx.t / fx.maxT) * 0.45);
      ctx.fillStyle = fx.color;
      ctx.fillRect(0, 0, CW, CH);
    } else if (fx.type === 'disaster_particles') {
      ctx.globalAlpha = 0.60;
      ctx.font = `${Math.round(16 * SX)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fx.particles.forEach(p => ctx.fillText(fx.icon, p.sx, p.sy));
    }
    ctx.restore();
  }
}

// ════════════════════════════════════════════════════════════
//  RENDERING
// ════════════════════════════════════════════════════════════
function drawBg() {
  ctx.fillStyle = COL_BG;
  ctx.fillRect(0, 0, CW, CH);

  // Subtle horizontal texture lines
  const bH  = 40 * (CH / 600);
  const off = (myProgress * PPU) % bH;
  ctx.strokeStyle = 'rgba(26,26,46,0.025)';
  ctx.lineWidth = 1;
  for (let y = bH - off % bH; y < CH; y += bH) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CW, y); ctx.stroke();
  }
}

function drawTracks() {
  if (myStatus !== 'playing' || trackHistory.length < 3) return;
  const alpha = Math.min(0.32, mySpeed * 0.05);
  ctx.strokeStyle = `rgba(26,26,46,${alpha})`;
  ctx.lineWidth = 1.0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([3, 5]);

  for (const side of [-1, 1]) {
    const offPx = side * 4 * SX;
    ctx.beginPath();
    let started = false;
    for (const pt of trackHistory) {
      const sx2 = pt.x * SX + offPx;
      const sy2 = PY() + (pt.progress - myProgress) * PPU;
      if (sy2 < -60 || sy2 > CH + 10) continue;
      if (!started) { ctx.moveTo(sx2, sy2); started = true; }
      else ctx.lineTo(sx2, sy2);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawObs(o) {
  const sy = scY(o.prog);
  if (sy < -100 * SX || sy > CH + 30) return;
  const cx = scX(o.x + o.w / 2);
  const sw = o.w * SX;
  const sh = o.h * SX;

  ctx.save();
  ctx.fillStyle = '#111111';

  if (o.type === 'tree') {
    // ▲ Triangle (黒三角)
    ctx.beginPath();
    ctx.moveTo(cx - sw / 2, sy);
    ctx.lineTo(cx, sy - sh);
    ctx.lineTo(cx + sw / 2, sy);
    ctx.closePath();
    ctx.fill();

  } else if (o.type === 'drift') {
    // ■ Square / Rectangle (黒四角)
    const rx = cx - sw / 2;
    const ry = sy - sh;
    ctx.beginPath();
    ctx.rect(rx, ry, sw, sh);
    ctx.fill();

  } else if (o.type === 'rock') {
    // ⬟ Jagged circle (ギザギザ丸) — spiky star shape, moves left-right
    const offPx = getRockOffset(o) * SX;
    const rcx   = cx + offPx;
    const r1 = Math.min(sw, sh) * 0.50; // outer radius
    const r2 = r1 * 0.60;               // inner radius
    const spikes = 8;
    const cy2 = sy - sh * 0.35;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (Math.PI / spikes) * i - Math.PI / 2;
      const r = (i % 2 === 0) ? r1 : r2;
      const px2 = rcx + Math.cos(angle) * r;
      const py2 = cy2 + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px2, py2);
      else ctx.lineTo(px2, py2);
    }
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

function drawItemBox(b) {
  const sy = scY(b.prog);
  if (sy < -20 || sy > CH + 20) return;
  const bx = scX(b.x);
  const bw = 14 * SX;
  const bh = 14 * SX;
  ctx.save();
  ctx.fillStyle = '#FFD700';
  ctx.strokeStyle = '#B8860B';
  ctx.lineWidth = 1;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(bx - bw / 2, sy - bh / 2, bw, bh, 3);
    ctx.fill(); ctx.stroke();
  } else {
    ctx.fillRect(bx - bw / 2, sy - bh / 2, bw, bh);
    ctx.strokeRect(bx - bw / 2, sy - bh / 2, bw, bh);
  }
  ctx.fillStyle = COL_DARK;
  ctx.font = `bold ${Math.max(8, Math.round(9 * SX))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', bx, sy);
  ctx.restore();
}

function drawShelter(sh) {
  const sy = scY(sh.prog);
  if (sy < -200 || sy > CH + 50) return;
  const cx = scX(sh.cx);
  const rw = sh.w * SX * 0.5;
  const rh = 16 * SX;
  const shadowH = sh.shadowDepth * PPU;

  ctx.save();
  // Shadow zone (dashed rectangle below rock)
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(100,100,120,0.35)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(100,100,120,0.08)';
  ctx.fillRect(cx - rw, sy, rw * 2, shadowH);
  ctx.strokeRect(cx - rw, sy, rw * 2, shadowH);
  ctx.setLineDash([]);

  // Rock (grey ellipse)
  ctx.fillStyle = '#888894';
  ctx.beginPath();
  ctx.ellipse(cx, sy, rw, rh, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.ellipse(cx - rw * 0.15, sy - rh * 0.3, rw * 0.4, rh * 0.3, -0.3, 0, Math.PI * 2);
  ctx.fill();

  // Label
  ctx.fillStyle = 'rgba(80,80,100,0.6)';
  ctx.font = `${Math.max(8, Math.round(8 * SX))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('いわかげ', cx, sy + shadowH * 0.5);
  ctx.restore();
}

// Player as circle
function drawPlayer(lx, sy, name, isMe, idx) {
  ctx.save();
  const px    = lx * SX;
  const r     = 11 * SX;
  const color = isMe ? '#FF3B30' : '#808080';

  // Circle body
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px, sy, r, 0, Math.PI * 2);
  ctx.fill();

  // Inner highlight
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.arc(px - r * 0.25, sy - r * 0.3, r * 0.40, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Name tag (self only)
  if (isMe) {
    ctx.save();
    const dn = name.slice(0, 12);
    const fs = Math.round(10 * SX);
    ctx.font = `900 ${fs}px 'Noto Sans JP', sans-serif`;
    const tw = ctx.measureText(dn).width + 8 * SX;
    const tagY = sy - r - 20 * SX;
    ctx.fillStyle = '#FF3B30';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(px - tw / 2, tagY - 14 * SX, tw, 14 * SX, 3);
      ctx.fill();
    } else {
      ctx.fillRect(px - tw / 2, tagY - 14 * SX, tw, 14 * SX);
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(dn, px, tagY - 4 * SX);
    ctx.restore();
  }
}

function drawSpeedLines() {
  if (mySpeed < 3.0) return;
  const alpha = Math.min(0.15, (mySpeed - 3.0) / 9.0 * 0.15);
  SL.forEach(sl => {
    sl.y += mySpeed * 2.0;
    if (sl.y > 600 + sl.len) {
      sl.y = -sl.len;
      sl.x = Math.random() * GAME_W;
      sl.len = 12 + Math.random() * 28;
    }
  });
  ctx.strokeStyle = `rgba(26,26,46,${alpha})`;
  ctx.lineWidth = 0.7;
  SL.forEach(sl => {
    const sx2 = sl.x * SX;
    const sy2 = sl.y * (CH / 600);
    ctx.beginPath(); ctx.moveTo(sx2, sy2); ctx.lineTo(sx2, sy2 + sl.len * SX); ctx.stroke();
  });
}

function drawProgressGrid() {
  const interval = TOTAL_COURSE / 10;
  ctx.save();
  ctx.strokeStyle = 'rgba(26,26,46,0.12)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.font = `900 ${Math.max(9, Math.round(9 * SX))}px 'Noto Sans JP', sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(26,26,46,0.22)';
  for (let i = 0; i <= 10; i++) {
    const y = scY(i * interval);
    if (y < -20 || y > CH + 20) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(`${i * 10}%`, 4, y - 2);
    ctx.setLineDash([4, 6]);
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, CW, CH);
  drawBg();

  // Rock shelters (behind everything, after bg)
  for (const sh of nearbyShelters(myProgress)) drawShelter(sh);

  drawProgressGrid();
  drawSpeedLines();

  for (const o of nearbyObs(myProgress)) drawObs(o);

  // Item boxes (after obstacles)
  for (const b of nearbyItemBoxes(myProgress)) {
    if (!pickedBoxes.has(b.id)) drawItemBox(b);
  }

  drawTracks();

  // Other players
  serverPlayers.forEach((p, i) => {
    if (p.uuid === myUUID || p.status === 'disconnected' || p.status === 'game_over') return;
    const sy = scY(p.progress);
    if (sy < -60 || sy > CH + 60) return;
    ctx.globalAlpha = 0.60;
    drawPlayer(p.x || GAME_W / 2, sy, p.name, false, i);
    ctx.globalAlpha = 1;
  });

  if (myStatus !== 'join') drawPlayer(myX, PY(), myName, true, 0);

  drawStageFX();

  if (paused) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(0, 0, CW, CH);
  }
}

// ════════════════════════════════════════════════════════════
//  INPUT
// ════════════════════════════════════════════════════════════
canvas.addEventListener('mousemove', e => {
  mouseX = (e.clientX - SIDEBAR_L) / SX;
  mouseY = e.clientY;
});

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const t = e.touches[0];
  mouseX = (t.clientX - SIDEBAR_L) / SX;
  mouseY = t.clientY;
}, { passive: false });

canvas.addEventListener('click', () => {
  if (myStatus === 'playing') {
    paused = !paused;
    const pi = document.getElementById('pauseIndicator');
    if (pi) pi.classList.toggle('visible', paused);
  }
});

window.addEventListener('keydown', e => {
  if (myStatus !== 'playing') return;
  const key = e.key.toLowerCase();
  if (key === 'z') useItem(0);
  else if (key === 'x') useItem(1);
  else if (key === 'c') useItem(2);
});

function useItem(slot) {
  const itemId = itemSlots[slot];
  if (itemId === null) return;
  socket.emit('use_item', { slot, itemId });
}

// ════════════════════════════════════════════════════════════
//  GAME LOOP
// ════════════════════════════════════════════════════════════
function update(dt) {
  updateStageFX(dt);
  if (myStatus !== 'playing' || awaitServer || paused) return;

  const effMax = effectiveMaxSpeed();
  // Speed range mapped to center 60% of screen (top 20% = min, bottom 20% = max)
  const topBound = CH * 0.20;
  const botBound = CH * 0.80;
  const clampedY = Math.max(topBound, Math.min(botBound, mouseY));
  mySpeed = MIN_SPEED + ((clampedY - topBound) / (botBound - topBound)) * (effMax - MIN_SPEED);

  targetX = Math.max(10, Math.min(GAME_W - 10, mouseX));
  myX    += (targetX - myX) * Math.min(1, dt * 9);

  myProgress = Math.min(TOTAL_COURSE, myProgress + mySpeed * dt);

  // Record position for curved tracks
  trackHistory.push({ progress: myProgress, x: myX });
  if (trackHistory.length > TRACK_MAX) trackHistory.shift();

  if (myProgress >= TOTAL_COURSE) {
    awaitServer = true;
    socket.emit('finish');
    return;
  }

  if (Date.now() > gracePeriodEnd) {
    for (const o of nearbyObs(myProgress)) {
      if (hitSet.has(o.id)) continue;
      if (!isHit(o)) continue;
      hitSet.add(o.id);
      awaitServer = true;
      socket.emit('hit_tree', { speed: mySpeed, obsType: o.type });
      return;
    }
  }

  checkItemBoxCollisions();

  const now = performance.now();
  if (now - lastSync > SYNC_MS) {
    socket.emit('update', { progress: myProgress, x: myX, speed: mySpeed });
    lastSync = now;
  }
}

function loop(ts) {
  const dt = Math.min((ts - (lastFrameTs || ts)) / 1000, 0.1);
  lastFrameTs = ts;
  update(dt);
  render();
  updateHUD();
  requestAnimationFrame(loop);
}

// ════════════════════════════════════════════════════════════
//  SCREEN MANAGEMENT
// ════════════════════════════════════════════════════════════
function showScreen(name) {
  document.getElementById('joinScreen').classList.toggle('hidden',     name !== 'join');
  document.getElementById('penaltyScreen').classList.toggle('hidden',  name !== 'penalty');
  document.getElementById('gameOverScreen').classList.toggle('hidden', name !== 'gameover');
  document.getElementById('waitingScreen').classList.toggle('hidden',  name !== 'waiting');
  document.getElementById('endedScreen').classList.toggle('hidden',    name !== 'ended');
  canvas.style.opacity = name === 'penalty' ? '0.28' : '1';

  if (name !== 'game') {
    paused = false;
    const pi = document.getElementById('pauseIndicator');
    if (pi) pi.classList.remove('visible');
  }
}

let waitingCountdownTimer = null;

function handleSchedulePhase(phase, startTime) {
  if (phase === 'waiting') {
    myStatus = 'waiting';
    showScreen('waiting');
    startWaitingCountdown(startTime);
  } else if (phase === 'ended') {
    myStatus = 'ended';
    showScreen('ended');
  }
  // 'active' は join フローで処理
}

function startWaitingCountdown(startTime) {
  if (waitingCountdownTimer) clearInterval(waitingCountdownTimer);
  const el = document.getElementById('waitingCountdown');
  const lb = document.getElementById('waitingStartLabel');

  function tick() {
    if (!startTime) {
      if (el) el.textContent = '';
      if (lb) lb.textContent = 'かいさいじこくはみていです';
      return;
    }
    const now  = Date.now();
    const rem  = startTime - now;
    if (rem <= 0) {
      clearInterval(waitingCountdownTimer);
      waitingCountdownTimer = null;
      // Check if game is now active — reload to get fresh state
      location.reload();
      return;
    }
    const dt = new Date(startTime);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    if (lb) lb.textContent = `${hh}:${mm} からかいさいします`;

    const s   = Math.ceil(rem / 1000);
    const rh  = String(Math.floor(s / 3600)).padStart(2, '0');
    const rm  = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const rs  = String(s % 60).padStart(2, '0');
    if (el) el.textContent = `${rh}:${rm}:${rs}`;
  }
  tick();
  waitingCountdownTimer = setInterval(tick, 500);
}

function doRegisterEmail() {
  const inp = document.getElementById('notifyEmailInput');
  const msg = document.getElementById('emailMsg');
  if (!inp || !msg) return;
  const email = inp.value.trim();
  if (!email) { msg.textContent = 'めーるあどれすをにゅうりょくしてください'; msg.style.color = '#FF3B30'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'ただしいめーるあどれすをにゅうりょくしてください'; msg.style.color = '#FF3B30'; return; }
  msg.textContent = 'そうしんちゅう...'; msg.style.color = 'rgba(26,26,46,0.5)';
  socket.emit('register_email', { email });
}

function showGameOver(finishers) {
  myStatus = 'gameover';
  const el = document.getElementById('finalRanking');
  if (el) {
    el.innerHTML = (finishers || []).map(f => `
      <div class="final-entry rank-${f.rank}">
        <span>${f.rank === 1 ? '1st' : f.rank === 2 ? '2nd' : '3rd'} — ${f.name}</span>
        <span>${fmtTime(f.time)}</span>
      </div>`).join('');
  }
  showScreen('gameover');
}

// ════════════════════════════════════════════════════════════
//  JOIN
// ════════════════════════════════════════════════════════════
document.getElementById('joinBtn').addEventListener('click', doJoin);
document.getElementById('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name  = document.getElementById('nameInput').value.trim();
  const errEl = document.getElementById('joinError');
  if (!name) { errEl.textContent = 'なまえをにゅうりょくしてください'; return; }
  if (name.length > 20) { errEl.textContent = '20もじいないにしてください'; return; }
  errEl.textContent = '';
  myUUID = getUUID();
  myName = name;
  localStorage.setItem('skiName', name);
  socket.emit('join', { uuid: myUUID, name: myName });
}

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════
showScreen('join');
requestAnimationFrame(loop);
