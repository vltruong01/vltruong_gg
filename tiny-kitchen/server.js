const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const BUILD = "tiny-kitchen-build-2025-12-24a";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));

server.listen(PORT, () => {
  console.log(`[${BUILD}] Tiny Kitchen server running at http://localhost:${PORT}`);
});

const TICK_RATE = 25;
const SNAPSHOT_RATE = 12;

const MAP_W = 900;
const MAP_H = 520;


const WALL_T = 18;
const KITCHEN_FENCE_X = 460; // smaller kitchen, larger dining/service area
const KITCHEN_DOOR_TOP = 90;
const KITCHEN_DOOR_BOT = 190;
const PLAYER_R = 16;
const PLAYER_SPEED = 175;

// Extra collision obstacles
const CUSTOMER_R = 12; // customers are treated as small circles for collision
const TABLE_COLLISION_PAD = 6; // makes the round table a bit "thicker" for collision

// Interaction distances (smaller = must stand closer)
// Requested: reduce further so pick/place/serve is less "far".
const INTERACT_DIST = 42;
const PICKUP_DIST = 26;

// Baking times (seconds)
// Requested: longer bake, and UI will show the burn bar only after cooked.
const BAKE_TIME = 9.0;
const BURN_EXTRA = 8.0;

const EAT_TIME_MIN = 5.0; // seconds customer eats after serving (min)
const EAT_TIME_MAX = 10.0; // seconds customer eats after serving (max)
const PRE_EAT_TIME_MIN = 2.0; // pre-item (coke/ice cream) eating time (min)
const PRE_EAT_TIME_MAX = 3.5; // pre-item eating time (max)
const WASH_TIME = 7.0; // seconds to wash a dirty plate

// Order taking / greeting
const ORDER_TAKE_TIME = 20.0; // seconds to greet/take order before customer leaves
const ORDER_QUICK_TIME = 10.0; // <= this means full wait time
const FOOD_WAIT_MAX = 60.0; // seconds customer will wait for food if greeted quickly
const FOOD_WAIT_MIN = 30.0; // minimum wait time if greeted very late
const INITIAL_CUSTOMER_SPAWN_DELAY = 5.0; // minimum seconds before the first group can spawn
function thirdTableSpawnChance(lockedCount) {
  const n = Math.max(2, Math.min(5, Number(lockedCount || 2)));
  // Higher player count => more likely to have all 3 tables occupied at once.
  if (n <= 2) return 0.18;
  if (n === 3) return 0.28;
  if (n === 4) return 0.48;
  return 0.62; // 5p
}

function ovenSlotCountForPlayers(lockedCount) {
  const n = Math.max(2, Math.min(5, Number(lockedCount || 2)));
  return n >= 4 ? 3 : 2;
}

const INITIAL_GROUP_MAX_SIZE = 2; // first spawned group cannot be 3 people
function maxCustomersForPlayers(lockedCount) {
  const n = Math.max(2, Math.min(5, Number(lockedCount || 2)));
  // Keep original caps (as requested): 2p:4, 3p:5, 4p:7, 5p:8
  if (n === 2) return 4;
  if (n === 3) return 5;
  if (n === 4) return 7;
  return 8;
}

const LEAVE_ANGRY_PENALTY_PER_PERSON = { 1: 12, 2: 18, 3: 24 }; // penalty per timed-out person, scaled by original group size
function leaveAngryPenaltyPerPerson(groupSize) {
  const s = Math.max(1, Math.min(3, Number(groupSize || 1)));
  return LEAVE_ANGRY_PENALTY_PER_PERSON[s] || 12;
}
const WRONG_DISH_WAIT_PENALTY = 10.0; // -10s ONCE from THIS seat's remaining wait time when serving wrong item
const PRE_BONUS_WAIT = 10.0; // +10s to remaining wait time after correctly serving+consuming a pre-item


const ACTIONS_PER_SEC_LIMIT = 10;

function nowMs() { return Date.now(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randRange(a, b) { return a + Math.random() * (b - a); }

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function shortId() { return Math.random().toString(36).slice(2, 10); }
function normalizeCode(code) { return String(code || "").trim().toUpperCase(); }

function circleRectOverlapResolve(px, py, pr, rx, ry, rw, rh) {
  const nearestX = clamp(px, rx, rx + rw);
  const nearestY = clamp(py, ry, ry + rh);
  const dx = px - nearestX;
  const dy = py - nearestY;
  const d2 = dx * dx + dy * dy;
  const r2 = pr * pr;
  if (d2 >= r2) return { x: px, y: py, hit: false };
  const d = Math.sqrt(d2) || 0.0001;
  const push = pr - d;
  const nx = dx / d;
  const ny = dy / d;
  return { x: px + nx * push, y: py + ny * push, hit: true };
}

function circleCircleOverlapResolve(px, py, pr, cx, cy, cr) {
  const dx = px - cx;
  const dy = py - cy;
  const minD = pr + cr;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD) return { x: px, y: py, hit: false };
  const d = Math.sqrt(d2) || 0.0001;
  const push = minD - d;
  const nx = dx / d;
  const ny = dy / d;
  return { x: px + nx * push, y: py + ny * push, hit: true };
}

function isPointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
function distPointToRect(px, py, rect) {
  const nx = clamp(px, rect.x, rect.x + rect.w);
  const ny = clamp(py, rect.y, rect.y + rect.h);
  return dist(px, py, nx, ny);
}
function nearRect(px, py, rect, margin) {
  return distPointToRect(px, py, rect) <= margin;
}

const DIFFICULTY = {
  2: { GAME_DURATION: 160, TARGET_SCORE: 140, ORDER_SLOTS: 2, ORDER_SPAWN_INTERVAL: 8.0, PATIENCE_TIME: 35 },
  3: { GAME_DURATION: 150, TARGET_SCORE: 190, ORDER_SLOTS: 3, ORDER_SPAWN_INTERVAL: 7.0, PATIENCE_TIME: 33 },
  4: { GAME_DURATION: 145, TARGET_SCORE: 240, ORDER_SLOTS: 3, ORDER_SPAWN_INTERVAL: 6.3, PATIENCE_TIME: 31 },
  5: { GAME_DURATION: 140, TARGET_SCORE: 290, ORDER_SLOTS: 4, ORDER_SPAWN_INTERVAL: 5.8, PATIENCE_TIME: 29 }
};

const PIZZA_TYPES = ["PIZZA_PHOMAI", "PIZZA_XUCXICH", "PIZZA_XUCXICH_PHOMAI"];
const PIZZA_ITEM_TYPES = ["PIZZA_BASE", "RAW_PIZZA", ...PIZZA_TYPES, "BURNT_PIZZA"];
const TOPPINGS = ["CHEESE", "SAUSAGE"];

const EXTRA_ORDERS = ["COKE", "ICE_CREAM"];

// Make dish comparisons robust across legacy/alternate naming.
// Canonical cooked dish types are:
// - PIZZA_PHOMAI
// - PIZZA_XUCXICH
// - PIZZA_XUCXICH_PHOMAI
function canonicalDishType(t) {
  const s = String(t || "").toUpperCase();
  if (!s) return null;
  const hasCheese = s.includes("PHOMAI") || s.includes("CHEESE");
  const hasSausage = s.includes("XUCXICH") || s.includes("SAUSAGE");
  if (hasCheese && hasSausage) return "PIZZA_XUCXICH_PHOMAI";
  if (hasCheese) return "PIZZA_PHOMAI";
  if (hasSausage) return "PIZZA_XUCXICH";
  return s;
}

function dishLabelVi(t) {
  const c = canonicalDishType(t);
  if (c === "PIZZA_PHOMAI") return "Pizza phô mai";
  if (c === "PIZZA_XUCXICH") return "Pizza xúc xích";
  if (c === "PIZZA_XUCXICH_PHOMAI") return "Pizza phô mai + xúc xích";
  if (c === "COKE") return "Coca";
  if (c === "ICE_CREAM") return "Kem ốc quế";
  if (String(t || "").toUpperCase() === "BURNT_PIZZA") return "Pizza cháy";
  return String(t || "");
}

function cookedTypeFromToppings(meta) {
  const cheese = !!meta?.cheese;
  const sausage = !!meta?.sausage;
  if (cheese && sausage) return "PIZZA_XUCXICH_PHOMAI";
  if (cheese) return "PIZZA_PHOMAI";
  if (sausage) return "PIZZA_XUCXICH";
  return null;
}
function hasAnyTopping(meta) {
  return !!meta?.cheese || !!meta?.sausage;
}

/** Layout */
function buildKitchenLayout(orderSlots, lockedCount) {
  const stations = [];
  // Normalize locked player count early (used by multiple station rules)
  const lc = Math.max(2, Math.min(5, Number(lockedCount || 2)));
  const topY = 26, topH = 54;
  const kitchenRightInner = KITCHEN_FENCE_X - WALL_T;
  // ingredient shelf (3 bins packed closely)
  const shelfX = 40;
  const binW = 78;
  const binGap = 0;
  stations.push({ id: "BIN_BASE", type: "BIN", gives: "PIZZA_BASE", label: "PIZZA", x: shelfX + (binW + binGap) * 0, y: topY, w: binW, h: topH });
  stations.push({ id: "BIN_CHEESE", type: "BIN", gives: "CHEESE", label: "CHEESE", x: shelfX + (binW + binGap) * 1, y: topY, w: binW, h: topH });
  stations.push({ id: "BIN_SAUSAGE", type: "BIN", gives: "SAUSAGE", label: "SAUSAGE", x: shelfX + (binW + binGap) * 2, y: topY, w: binW, h: topH });

  // Coke pump (auto provides cup + coca)
    // Coke pump (auto provides cup + coca) — moved to mid-left
  stations.push({ id: "COKE_PUMP", type: "DISPENSER", gives: "COKE", x: 40, y: 238, w: 78, h: 54, active: false, t: 0, byPlayerId: null });


  // OVEN: 2 slots by default; 3 slots for 4–5 players
  const ovenSlots = ovenSlotCountForPlayers(lc);
  const ovenW = ovenSlots === 3 ? 132 : 92;
  const ovenX = kitchenRightInner - ovenW - 10;
  stations.push({
    id: "OVEN",
    type: "OVEN",
    label: `OVEN (${ovenSlots})`,
    x: ovenX,
    y: topY,
    w: ovenW,
    h: topH,
    slotItemIds: Array(ovenSlots).fill(null),
    slotTs: Array(ovenSlots).fill(0)
  });

  const botY = 432, botH = 62;


  const sinkW = 92;
  const sinkX = kitchenRightInner - sinkW - 10;
  // Plate stacks: one in kitchen area, one in serving area (top middle-right).
  const homeSlots = lc >= 4 ? 4 : 3;
  const serveSlots = lc === 2 ? 1 : 2;
  const plateW = (n) => 12 + n * 40; // n=3 -> 132, n=4 -> 172, n=2 -> 92

  stations.push({ id: "PLATE_HOME", type: "PLATE", slotCount: homeSlots, label: `PLATE STACK (${homeSlots})`, x: 80, y: botY, w: plateW(homeSlots), h: botH });

  // Keep TRASH far on the right as "punishment"; just a bit smaller.
  stations.push({ id: "TRASH", type: "TRASH", label: "TRASH", x: 640, y: botY, w: 102, h: 56 });

  // sink (2 slots) so two players can wash simultaneously
  stations.push({
    id: "SINK",
    type: "SINK",
    label: "SINK (2)",
    x: sinkX, // near kitchen fence
    y: botY,
    w: 92,
    h: botH,
    slotItemIds: [null, null],
    slotTs: [0, 0],
    slotActives: [false, false],
    slotByPlayerIds: [null, null]
  });

  // Serving-area plate stack (top middle of serving side)
  stations.push({ id: "PLATE_SERVICE", type: "PLATE", slotCount: serveSlots, label: `PLATE STACK (${serveSlots})`, x: (KITCHEN_FENCE_X + 40), y: topY, w: plateW(serveSlots), h: topH });

  // Ice cream machine in dining area (auto provides cone + ice cream)
  stations.push({ id: "ICE_CREAM_MACHINE", type: "DISPENSER", gives: "ICE_CREAM", x: 780, y: topY, w: 92, h: topH, active: false, t: 0, byPlayerId: null });

  // MAIN TABLE: now only 3 slots (1x3)
  stations.push({ id: "CENTER", type: "CENTER", label: "MAIN TABLE (3 slots)", x: 270, y: 240, w: 132, h: 62 });

  const tables = [];
  // Round customer tables (each has 3 chairs).
  // Exactly 3 table sets in this map.
  // We keep x/y/w/h as a collision bounding box, but render using cx/cy/r.
  const base = [
    { cx: 620, cy: 180 },
    { cx: 750, cy: 180 },
    { cx: 685, cy: 325 }
  ];
  const tableR = 22;
  const boxR = 32; // bounding box half-size
  const chairDist = 42;
  const plateDist = 18;
  const chairAngles = [-90, 30, 150].map(a => a * Math.PI / 180);

  for (let i = 0; i < base.length; i++) {
    const cx = base[i].cx, cy = base[i].cy;
    const seats = chairAngles.map((ang) => ({
      chairX: cx + Math.cos(ang) * chairDist,
      chairY: cy + Math.sin(ang) * chairDist,
      plateX: cx + Math.cos(ang) * plateDist,
      plateY: cy + Math.sin(ang) * plateDist
    }));
    tables.push({
      id: `TABLE_${i + 1}`,
      cx, cy,
      r: tableR,
      seats,
      // collision box:
      x: cx - boxR,
      y: cy - boxR,
      w: boxR * 2,
      h: boxR * 2
    });
  }

  const walls = [];
  const t = WALL_T;
  walls.push({ x: 0, y: 0, w: MAP_W, h: t });
  walls.push({ x: 0, y: MAP_H - t, w: MAP_W, h: t });
  walls.push({ x: 0, y: 0, w: t, h: MAP_H });
  walls.push({ x: MAP_W - t, y: 0, w: t, h: MAP_H });

  for (const s of stations) walls.push({ x: s.x, y: s.y, w: s.w, h: s.h });

  // KITCHEN FENCE: separate kitchen (left) from dining (right).
  // Wall segments leave a doorway gap so players can pass through.
  const fenceX = KITCHEN_FENCE_X;
  const doorTop = KITCHEN_DOOR_TOP;
  const doorBot = KITCHEN_DOOR_BOT;
  walls.push({ x: fenceX, y: 0, w: t, h: doorTop });
  walls.push({ x: fenceX, y: doorBot, w: t, h: MAP_H - doorBot });

  const entrance = { x: 862, y: 305 };
  return { stations, walls, tables, entrance };
}

function computeCenterSlotCenters(centerStation) {
  const cols = 3, rows = 1;
  const marginX = 6, marginY = 16;
  const cellW = (centerStation.w - marginX * 2) / cols;
  const cellH = (centerStation.h - marginY * 2) / rows;
  const pts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pts.push({
        x: centerStation.x + marginX + cellW * (c + 0.5),
        y: centerStation.y + marginY + cellH * (r + 0.5),
      });
    }
  }
  return pts;
}

function computePlateStackSlotCenters(plateStation) {
  // N slots in a single row (plate shelves).
  const cols = Math.max(1, Number(plateStation.slotCount || 3));
  const marginX = 8, marginY = 14;
  const cellW = (plateStation.w - marginX * 2) / cols;
  const cy = plateStation.y + plateStation.h / 2;
  const pts = [];
  for (let c = 0; c < cols; c++) {
    pts.push({
      x: plateStation.x + marginX + cellW * (c + 0.5),
      y: cy
    });
  }
  return pts;
}

function computeRowSlotCenters(station, cols) {
  const c = Math.max(1, Math.floor(Number(cols || 1)));
  const marginX = 6, marginY = 10;
  const cellW = (station.w - marginX * 2) / c;
  const cy = station.y + station.h / 2;
  const pts = [];
  for (let i = 0; i < c; i++) {
    pts.push({
      x: station.x + marginX + cellW * (i + 0.5),
      y: cy
    });
  }
  return pts;
}

function computeTwoSlotCenters(station) {
  // 2 slots in a single row (for SINK)
  return computeRowSlotCenters(station, 2);
}


/** Rooms */
const rooms = new Map();

function getSpawnPositions() {
  return [
    { x: 250, y: 330 },
    { x: 300, y: 350 },
    { x: 350, y: 330 },
    { x: 400, y: 350 },
    { x: 450, y: 330 }
  ];
}

function makePlayer(socketId, name, spawn) {
  return {
    id: socketId,
    name: String(name || "Player").slice(0, 18),
    x: spawn.x,
    y: spawn.y,
    r: PLAYER_R,
    heldItemId: null,
    connected: true,
    input: { up: false, down: false, left: false, right: false, ax: null, ay: null },
    lastInputAt: nowMs(),
    actionTokens: ACTIONS_PER_SEC_LIMIT,
    actionTokenAt: nowMs()
  };
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  let pick = null;
  for (const p of room.players.values()) { if (p.connected) { pick = p; break; } }
  if (!pick) for (const p of room.players.values()) { pick = p; break; }
  room.hostId = pick ? pick.id : null;
}
function connectedCount(room) {
  let c = 0;
  for (const p of room.players.values()) if (p.connected) c++;
  return c;
}
function roomBroadcast(room) {
  ensureHost(room);
  io.to(room.code).emit("roomUpdate", {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, connected: p.connected })),
    lockedCount: room.lockedCount || null
  });
}
function sendNote(room, text) {
  io.to(room.code).emit("note", { text: String(text || ""), at: nowMs() });
}

/** Items */
function makeItem(type, x, y, zone = "floor", meta = null) {
  const it = { id: shortId(), type, x, y, zone };
  if (type === "PLATE") {
    it.completed = false;
    it.dishType = null;
    it.tray = null; // { stage:"PIZZA_BASE"|"RAW_PIZZA", meta }
    it.dirty = false; // needs washing after serving / trashing food
  }
  if (type === "PIZZA_BASE" || type === "RAW_PIZZA") {
    it.meta = { cheese: false, sausage: false, ...(meta || {}) };
  }
  return it;
}
function findItem(game, itemId) {
  return game.items.find(it => it.id === itemId) || null;
}
function removeItemById(game, itemId) {
  const idx = game.items.findIndex(it => it.id === itemId);
  if (idx < 0) return;
  const it = game.items[idx];

  // Clear any slot references so arrays don't keep dangling ids.
  if (it) {
    // MAIN TABLE
    if (typeof it.slotIndex === "number" && Array.isArray(game.centerSlots) && game.centerSlots[it.slotIndex] === it.id) {
      game.centerSlots[it.slotIndex] = null;
    }
    // PLATE STACKS
    if (it.plateStationId && typeof it.plateSlotIndex === "number" && game.plateStacks && game.plateStacks[it.plateStationId] && Array.isArray(game.plateStacks[it.plateStationId].slots) && game.plateStacks[it.plateStationId].slots[it.plateSlotIndex] === it.id) {
      game.plateStacks[it.plateStationId].slots[it.plateSlotIndex] = null;
    }
    // CUSTOMER TABLE (3 seats per table)
    if (typeof it.tableIndex === "number" && typeof it.seatIndex === "number" && Array.isArray(game.tableSeatSlots) && Array.isArray(game.tableSeatSlots[it.tableIndex]) && game.tableSeatSlots[it.tableIndex][it.seatIndex] === it.id) {
      game.tableSeatSlots[it.tableIndex][it.seatIndex] = null;
    }
    // OVEN / SINK (2-slot)
    const oven = game.layout?.stations?.find(s => s.id === "OVEN");
    if (oven) {
      if (Array.isArray(oven.slotItemIds)) {
        for (let oi = 0; oi < oven.slotItemIds.length; oi++) {
          if (oven.slotItemIds[oi] === it.id) {
            oven.slotItemIds[oi] = null;
            if (Array.isArray(oven.slotTs)) oven.slotTs[oi] = 0;
          }
        }
      } else if (oven.slotItemId === it.id) {
        oven.slotItemId = null; oven.active = false; oven.t = 0; oven.burnt = false;
      }
    }
    const sink = game.layout?.stations?.find(s => s.id === "SINK");
    if (sink) {
      if (Array.isArray(sink.slotItemIds)) {
        for (let si = 0; si < sink.slotItemIds.length; si++) {
          if (sink.slotItemIds[si] === it.id) {
            sink.slotItemIds[si] = null;
            if (Array.isArray(sink.slotTs)) sink.slotTs[si] = 0;
            if (Array.isArray(sink.slotActives)) sink.slotActives[si] = false;
            if (Array.isArray(sink.slotByPlayerIds)) sink.slotByPlayerIds[si] = null;
          }
        }
      } else if (sink.slotItemId === it.id) {
        sink.slotItemId = null; sink.active = false; sink.t = 0;
      }
    }
  }

  game.items.splice(idx, 1);
}
function canConsumeAction(player) {
  const t = nowMs();
  const dt = (t - player.actionTokenAt) / 1000;
  if (dt > 0) {
    player.actionTokens = Math.min(ACTIONS_PER_SEC_LIMIT, player.actionTokens + dt * ACTIONS_PER_SEC_LIMIT);
    player.actionTokenAt = t;
  }
  if (player.actionTokens >= 1) { player.actionTokens -= 1; return true; }
  return false;
}

function resetPlate(plate) {
  if (!plate || plate.type !== "PLATE") return;
  plate.completed = false;
  plate.dishType = null;
  plate.tray = null;
}
function plateHasDish(plate) {
  return plate && plate.type === "PLATE" && plate.completed && !!plate.dishType;
}
function plateHasTray(plate) {
  return plate && plate.type === "PLATE" && !!plate.tray;
}
function plateIsEmpty(plate) {
  return plate && plate.type === "PLATE" && !plateHasDish(plate) && !plateHasTray(plate);
}

// A plate is "usable" for catching an oven item when it has no tray and no completed dish.
// NOTE: Dirtiness is checked separately where relevant so we can show a clearer message.
function plateIsUsable(plate) {
  return plateIsEmpty(plate);
}

function dropHeldToFloor(room, player) {
  const game = room.game;
  if (!game || !player.heldItemId) return;
  const it = findItem(game, player.heldItemId);
  if (!it) { player.heldItemId = null; return; }
  it.zone = "floor";
  it.x = clamp(player.x + (Math.random() * 18 - 9), 30, MAP_W - 30);
  it.y = clamp(player.y + (Math.random() * 18 - 9), 30, MAP_H - 30);
  player.heldItemId = null;
}

/** Customers (groups: 1–3 per table) */
function foodWaitFromGreetDelay(delaySec) {
  if (delaySec <= ORDER_QUICK_TIME) return FOOD_WAIT_MAX;
  const t = clamp((delaySec - ORDER_QUICK_TIME) / (ORDER_TAKE_TIME - ORDER_QUICK_TIME), 0, 1);
  return FOOD_WAIT_MAX - t * (FOOD_WAIT_MAX - FOOD_WAIT_MIN);
}

function samplePreItem() {
  // 40% customers: 20% ice cream, 20% coke (served BEFORE main dish)
  const r = Math.random();
  if (r < 0.20) return "ICE_CREAM";
  if (r < 0.40) return "COKE";
  return null;
}
function sampleMainDish() {
  return randChoice(PIZZA_TYPES);
}

// Weighted group size. As player count increases, 2–3 person groups become more likely.
function sampleGroupSize(lockedCount) {
  const n = Number(lockedCount || 2);

  // More players => more 2–3 person groups.
  let w1 = 0.52, w2 = 0.36, w3 = 0.12; // 2p
  if (n === 3) { w1 = 0.34; w2 = 0.44; w3 = 0.22; }
  else if (n === 4) { w1 = 0.22; w2 = 0.46; w3 = 0.32; }
  else if (n >= 5) { w1 = 0.18; w2 = 0.44; w3 = 0.38; }

  const sum = w1 + w2 + w3;
  const r = Math.random() * sum;
  if (r < w1) return 1;
  if (r < (w1 + w2)) return 2;
  return 3;
}


function makeGroup(game, tableIndex, size) {
  const gid = shortId();
  const g = {
    id: gid,
    tableIndex,
    size,
    memberIds: [],
    state: "arriving", // arriving -> await_order -> waiting_food -> leaving
    greetTotal: ORDER_TAKE_TIME,
    greetLeft: ORDER_TAKE_TIME,
    greetActive: false,
    acceptedCount: 0,
    patienceTotal: 0,
    patienceLeft: 0
  };
  if (!game.groups) game.groups = {};
  game.groups[gid] = g;
  return g;
}

function makeCustomerMember(group, seatIndex, entrance, chairX, chairY) {
  return {
    id: shortId(),
    groupId: group.id,
    tableIndex: group.tableIndex,
    seatIndex,
    createdAt: nowMs(),
    x: entrance.x,
    y: entrance.y,
    tx: chairX,
    ty: chairY,
    seatX: chairX,
    seatY: chairY,
    state: "walking", // walking -> await_order -> waiting_food -> eating -> leaving
    dishType: null,   // revealed when order is taken
    preType: null,   // optional pre-item (coke/ice cream)
    preServed: false,
    mainDishType: null,
    accepted: false,
    served: false,
    wrongPenaltyUsed: false,
    // per-seat food waiting timer (set when the LAST order in the group is taken)
    patienceTotal: null,
    patienceLeft: null,
    eatLeft: 0,
    eatingKind: null, // 'pre' | 'main'
    mainGreetTotal: null,
    mainGreetLeft: null,
    speed: 98
  };
}

function getGroup(game, groupId) {
  if (!game || !game.groups) return null;
  return game.groups[groupId] || null;
}

function spawnGroupIntoTable(room, game, tableIdx, capacityLeft) {
  const table = game.layout.tables[tableIdx];
  if (!table) return false;
  if (game.tableOccupied[tableIdx]) return false;

  let size = sampleGroupSize(room.lockedCount);
  // Do not spawn 3-person groups at the very beginning (first spawn only).
  if ((game.spawnedGroupsCount || 0) === 0) size = Math.min(size, INITIAL_GROUP_MAX_SIZE);

  // Cap group size so total customers on the map never exceeds the per-player limit.
  if (typeof capacityLeft === "number") {
    const cap = Math.max(0, Math.floor(capacityLeft));
    if (cap <= 0) return false;
    size = Math.max(1, Math.min(size, cap));
  }
  const group = makeGroup(game, tableIdx, size);
  game.spawnedGroupsCount = (game.spawnedGroupsCount || 0) + 1;
  game.tableOccupied[tableIdx] = true;

  for (let si = 0; si < size; si++) {
    const seat = table.seats?.[si];
    if (!seat) continue;
    const c = makeCustomerMember(group, si, game.layout.entrance, seat.chairX, seat.chairY);
    group.memberIds.push(c.id);
    game.customers.push(c);
  }

  sendNote(room, size === 1 ? "Customer sat down — take order!" : `Group of ${size} sat down — take ALL orders!`);
  return true;
}

function goldFromPatience(total, left) {
  const t = Math.max(1, Number(total || 1));
  const l = clamp(Number(left || 0), 0, t);
  const ratio = clamp(l / t, 0, 1);
  // min = 1/2 max (20 -> 40 by default)
  return Math.round(20 + 20 * ratio);
}
function serveGoldFromCustomer(c) {
  return goldFromPatience(c?.patienceTotal, c?.patienceLeft);
}


/** Game lifecycle */
function startGame(room, lockedCount) {
  const cfg = DIFFICULTY[lockedCount] || DIFFICULTY[2];
  room.lockedCount = lockedCount;
  room.config = cfg;

  const layout = buildKitchenLayout(cfg.ORDER_SLOTS, lockedCount);
  const center = layout.stations.find(s => s.id === "CENTER");
  const slotCenters = computeCenterSlotCenters(center);
  const plateStations = layout.stations.filter(st => st.type === "PLATE");
  const plateStacks = {};
  for (const ps of plateStations) {
    plateStacks[ps.id] = {
      slots: Array(Math.max(1, Number(ps.slotCount || 3))).fill(null),
      centers: computePlateStackSlotCenters(ps)
    };
  }
  const ovenS = layout.stations.find(st => st.id === "OVEN");
  const ovenSlotCenters = ovenS ? computeRowSlotCenters(ovenS, Array.isArray(ovenS.slotItemIds) ? ovenS.slotItemIds.length : 2) : [];
  const sinkS = layout.stations.find(st => st.id === "SINK");
  const sinkSlotCenters = sinkS ? computeTwoSlotCenters(sinkS) : [];

  room.phase = "playing";
  const game = {
    lastUpdateAt: nowMs(),
    lastSnapshotAt: 0,
    paused: false,
    duration: cfg.GAME_DURATION,
    timeLeft: cfg.GAME_DURATION,
    target: cfg.TARGET_SCORE,
    score: 0,

    items: [],
    layout,

    centerSlots: Array(3).fill(null),
    centerSlotCenters: slotCenters,

    // Plate stacks (multiple)
    plateStacks,

    // OVEN / SINK (2 slot centers)
    ovenSlotCenters,
    sinkSlotCenters,

    customers: [],
    customerSpawnT: (cfg.ORDER_SPAWN_INTERVAL - INITIAL_CUSTOMER_SPAWN_DELAY),
    spawnedGroupsCount: 0,
    tableOccupied: Array(layout.tables.length).fill(false),
    // Each customer table can hold exactly one plate placed for serving / dirty return
    tableSeatSlots: Array(layout.tables.length).fill(null).map(() => Array(3).fill(null)),

    groups: {},

    below2Since: null,
    ended: false,
    endInfo: null
  };

  const spawns = getSpawnPositions();
  let i = 0;
  for (const p of room.players.values()) {
    const s = spawns[i % spawns.length];
    p.x = s.x; p.y = s.y;
    p.heldItemId = null;
    p.input = { up: false, down: false, left: false, right: false, ax: null, ay: null };
    i++;
  }

  const oven = layout.stations.find(st => st.id === "OVEN");
if (oven) {
  const c = Array.isArray(oven.slotItemIds) ? oven.slotItemIds.length : ovenSlotCountForPlayers(room.lockedCount);
  oven.slotItemIds = Array(c).fill(null);
  oven.slotTs = Array(c).fill(0);
}

  const sink = layout.stations.find(st => st.id === "SINK");
  if (sink) {
    sink.slotItemIds = [null, null];
    sink.slotTs = [0, 0];
    sink.slotActives = [false, false];
    sink.slotByPlayerIds = [null, null];
  }


  // Spawn plates into each plate stack slots (home + serving).
  if (game.plateStacks) {
    for (const [sid, st] of Object.entries(game.plateStacks)) {
      const centers = Array.isArray(st.centers) ? st.centers : [];
      for (let k = 0; k < centers.length; k++) {
        const p = centers[k];
        const it = makeItem("PLATE", p.x, p.y, "counter");
        game.items.push(it);
        platePlaceItemIntoSlot(game, sid, it, k);
      }
    }
  }

  // Do not spawn customers immediately at game start.
  // We enforce a minimum initial delay before the first group appears.

  room.game = game;
  sendNote(room, `✅ ${BUILD} • MAIN TABLE uses NEAREST SLOT for take/place • Pizza can go into PLATE on table`);
  roomBroadcast(room);
}

function endGame(room, win, reason = "") {
  if (!room.game || room.game.ended) return;
  room.game.ended = true;
  room.phase = "ended";
  room.game.endInfo = { win: !!win, score: room.game.score, target: room.game.target, reason: String(reason || "") };
  io.to(room.code).emit("ended", room.game.endInfo);
  roomBroadcast(room);
}

/** Helpers */
function findStationById(game, id) {
  return game.layout.stations.find(s => s.id === id) || null;
}
function nearestStation(game, player) {
  let best = null;
  let bestD = INTERACT_DIST;
  for (const s of game.layout.stations) {
    const d = distPointToRect(player.x, player.y, s);
    if (d <= INTERACT_DIST && d < bestD) { bestD = d; best = s; }
  }
  return best;
}
function nearestTable(game, player) {
  let best = null, bestD = INTERACT_DIST;
  for (const tb of game.layout.tables) {
    const d = distPointToRect(player.x, player.y, tb);
    if (d <= INTERACT_DIST && d < bestD) { bestD = d; best = tb; }
  }
  return best;
}


function takeOrderAtDoor(room, player) {
  const game = room.game;
  if (!game || game.ended) return false;
  const waiting = game.customers
    .filter(c => c.state === "waiting_order")
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!waiting.length) { sendNote(room, "No customer waiting for order"); return false; }

  const c = waiting[0];
  const total = Number(c.greetTotal || ORDER_TAKE_TIME);
  const left = Number(c.greetLeft || 0);
  const elapsed = clamp(total - left, 0, total);

  const wait = Math.round(foodWaitFromGreetDelay(elapsed));
  c.preType = samplePreItem();
  c.mainDishType = sampleMainDish();
  c.dishType = c.preType || c.mainDishType;
  c.patienceTotal = wait;
  c.patienceLeft = wait;

  c.greetLeft = 0;
  c.state = "walking";
  c.tx = c.seatX;
  c.ty = c.seatY;

  sendNote(room, `Order taken ✅ (${elapsed.toFixed(1)}s) • Wait: ${wait}s • ${dishLabelVi(c.dishType)}`);
  return true;
}


function tableIndexById(game, tableId) {
  if (!game || !game.layout || !game.layout.tables) return -1;
  return game.layout.tables.findIndex(t => t.id === tableId);
}

function tableNearestSeatIndex(game, tableIdx, player) {
  const tb = game.layout.tables[tableIdx];
  if (!tb || !Array.isArray(tb.seats) || !tb.seats.length) return 0;
  let bestIdx = 0, bestD = 1e9;
  for (let i = 0; i < tb.seats.length; i++) {
    const s = tb.seats[i];
    const d = dist(player.x, player.y, s.chairX, s.chairY);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}

function getTableSeatPlate(game, tableIdx, seatIdx) {
  const row = game.tableSeatSlots?.[tableIdx];
  const id = row ? row[seatIdx] : null;
  if (!id) return null;
  return findItem(game, id);
}

function placeItemOnTableSeat(game, item, tableIdx, seatIdx) {
  const tb = game.layout.tables[tableIdx];
  const seat = tb?.seats?.[seatIdx];
  if (!tb || !seat || !item) return false;
  if (!Array.isArray(game.tableSeatSlots?.[tableIdx])) return false;
  if (game.tableSeatSlots[tableIdx][seatIdx]) return false;

  // Place item at the small plate spot on the table
  item.zone = "table";
  item.x = seat.plateX;
  item.y = seat.plateY;
  item.tableIndex = tableIdx;
  item.seatIndex = seatIdx;

  game.tableSeatSlots[tableIdx][seatIdx] = item.id;
  return true;
}

function placePlateOnTableSeat(game, plate, tableIdx, seatIdx) {
  if (!plate || plate.type !== "PLATE") return false;
  return placeItemOnTableSeat(game, plate, tableIdx, seatIdx);
}


function removePlateFromTableSeat(game, tableIdx, seatIdx) {
  const row = game.tableSeatSlots?.[tableIdx];
  if (!row) return null;
  const id = row[seatIdx];
  row[seatIdx] = null;
  if (!id) return null;
  const it = findItem(game, id);
  if (it) {
    delete it.tableIndex;
    delete it.seatIndex;
  }
  return it;
}

function trashHeld(room, player) {
  const game = room.game;
  if (!game || !player.heldItemId) return;

  const it = findItem(game, player.heldItemId);
  if (!it) { player.heldItemId = null; return; }

  if (it.type === "PLATE") {
    const hadFood = plateHasTray(it) || plateHasDish(it);
    if (hadFood) {
      resetPlate(it);
      sendNote(room, "Scraped into trash");
    } else {
      sendNote(room, it.dirty ? "Plate is dirty (wash at SINK)" : "Plate is empty");
    }
    return;
  }

  if (typeof it.slotIndex === "number" && game.centerSlots[it.slotIndex] === it.id) {
    game.centerSlots[it.slotIndex] = null;
    delete it.slotIndex;
  }

  removeItemById(game, it.id);
  player.heldItemId = null;
  sendNote(room, "Trashed");
}

function pickPlateFromStack(game, player, plateStation) {
  if (player.heldItemId) return false;
  let best = null, bestD = 1e9;

  for (const it of game.items) {
    if (it.type !== "PLATE") continue;
    if (it.zone === "held") continue;

    const inStack = isPointInRect(it.x, it.y, plateStation) || nearRect(it.x, it.y, plateStation, 90);
    if (!inStack) continue;

    const d = dist(player.x, player.y, it.x, it.y);
    if (d < bestD) { bestD = d; best = it; }
  }

  if (!best) return false;
  best.zone = "held";
  player.heldItemId = best.id;
  return true;
}

function addToppingToPizzaItem(room, pizzaItem, toppingType) {
  if (!pizzaItem || !TOPPINGS.includes(toppingType)) return false;
  if (pizzaItem.type !== "PIZZA_BASE" && pizzaItem.type !== "RAW_PIZZA") {
    sendNote(room, "Can't add topping after baking");
    return false;
  }
  pizzaItem.meta = pizzaItem.meta || { cheese: false, sausage: false };

  if (toppingType === "CHEESE") {
    if (pizzaItem.meta.cheese) { sendNote(room, "Cheese already"); return false; }
    pizzaItem.meta.cheese = true;
  } else {
    if (pizzaItem.meta.sausage) { sendNote(room, "Sausage already"); return false; }
    pizzaItem.meta.sausage = true;
  }

  if (pizzaItem.type === "PIZZA_BASE") pizzaItem.type = "RAW_PIZZA";
  sendNote(room, `Added ${toppingType}`);
  return true;
}

/** MAIN TABLE (6 slots) */
function centerNearestSlotIndex(game, player) {
  let bestIdx = -1, bestD = 1e9;
  for (let i = 0; i < game.centerSlotCenters.length; i++) {
    const p = game.centerSlotCenters[i];
    const d = dist(player.x, player.y, p.x, p.y);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}
function centerPlaceItemIntoSlot(game, item, slotIdx) {
  const p = game.centerSlotCenters[slotIdx];
  game.centerSlots[slotIdx] = item.id;
  item.zone = "counter";
  item.x = p.x; item.y = p.y;
  item.slotIndex = slotIdx;
}
function centerRemoveFromSlot(game, slotIdx) {
  const id = game.centerSlots[slotIdx];
  game.centerSlots[slotIdx] = null;
  if (!id) return null;
  const it = findItem(game, id);
  if (it) delete it.slotIndex;
  return it;
}
function centerGetSlotItem(game, slotIdx) {
  const id = game.centerSlots[slotIdx];
  if (!id) return null;
  return findItem(game, id);
}

/** PLATE STACKS (multiple shelves) */
function plateStackInfo(game, stationId) {
  if (!game.plateStacks) return null;
  return game.plateStacks[stationId] || null;
}
function plateNearestSlotIndex(game, player, stationId) {
  const st = plateStackInfo(game, stationId);
  if (!st || !Array.isArray(st.centers) || !st.centers.length) return -1;
  let bestIdx = -1, bestD = 1e9;
  for (let i = 0; i < st.centers.length; i++) {
    const p = st.centers[i];
    const d = dist(player.x, player.y, p.x, p.y);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}
function platePlaceItemIntoSlot(game, stationId, item, slotIdx) {
  const st = plateStackInfo(game, stationId);
  if (!st) return;
  const p = st.centers[slotIdx];
  st.slots[slotIdx] = item.id;
  item.zone = "counter";
  item.x = p.x; item.y = p.y;
  item.plateStationId = stationId;
  item.plateSlotIndex = slotIdx;
}
function plateRemoveFromSlot(game, stationId, slotIdx) {
  const st = plateStackInfo(game, stationId);
  if (!st) return null;
  const id = st.slots[slotIdx];
  st.slots[slotIdx] = null;
  if (!id) return null;
  const it = findItem(game, id);
  if (it) { delete it.plateStationId; delete it.plateSlotIndex; }
  return it;
}
function plateGetSlotItem(game, stationId, slotIdx) {
  const st = plateStackInfo(game, stationId);
  if (!st) return null;
  const id = st.slots[slotIdx];
  if (!id) return null;
  return findItem(game, id);
}

/** OVEN (2 slots) */
function ovenNearestSlotIndex(game, player) {
  if (!game.ovenSlotCenters || !game.ovenSlotCenters.length) return -1;
  let bestIdx = -1, bestD = 1e9;
  for (let i = 0; i < game.ovenSlotCenters.length; i++) {
    const p = game.ovenSlotCenters[i];
    const d = dist(player.x, player.y, p.x, p.y);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}

/** SINK (2 slots) */
function sinkNearestSlotIndex(game, player) {
  if (!game.sinkSlotCenters || !game.sinkSlotCenters.length) return -1;
  let bestIdx = -1, bestD = 1e9;
  for (let i = 0; i < game.sinkSlotCenters.length; i++) {
    const p = game.sinkSlotCenters[i];
    const d = dist(player.x, player.y, p.x, p.y);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}

/** station action */
function stationAction(room, player) {
  const game = room.game;
  if (!game || game.ended) return;

  const held = player.heldItemId ? findItem(game, player.heldItemId) : null;

  // customer table interaction (round tables: 3 seats)
  const tb = nearestTable(game, player);
  if (tb) {
    const tableIdx = game.layout.tables.findIndex(t => t.id === tb.id);
    if (tableIdx >= 0) {
      const seatIdx = tableNearestSeatIndex(game, tableIdx, player);

      const seatCust = game.customers.find(c => c.tableIndex === tableIdx && c.seatIndex === seatIdx && c.state !== "leaving") || null;
      const group = seatCust ? getGroup(game, seatCust.groupId) : null;

      const seatPlate = getTableSeatPlate(game, tableIdx, seatIdx);
      const eatingHere = !!(seatCust && seatCust.state === "eating");

      // Take order at THIS seat (allowed even while holding a plate)
      if (seatCust && seatCust.state === "await_order" && !seatCust.accepted) {
        if (!group || !group.greetActive) { sendNote(room, "Wait for customers to sit first"); return; }

        seatCust.accepted = true;
        seatCust.preType = samplePreItem();
        if (seatCust.preType) {
          // This seat orders a drink/dessert FIRST; main dish order will appear only after they finish it.
          seatCust.mainDishType = null;
          seatCust.dishType = seatCust.preType;
        } else {
          seatCust.mainDishType = sampleMainDish();
          seatCust.dishType = seatCust.mainDishType;
        }
        group.acceptedCount = (group.acceptedCount || 0) + 1;

        if (seatCust.preType) sendNote(room, `Order taken ✅ Seat ${seatIdx + 1}: ${dishLabelVi(seatCust.preType)} trước`);
        else sendNote(room, `Order taken ✅ Seat ${seatIdx + 1}: ${dishLabelVi(seatCust.mainDishType)}`);
// When the LAST seat is taken, start the food waiting timer for the whole group
        if (group.acceptedCount >= group.size) {
          const elapsed = clamp(group.greetTotal - group.greetLeft, 0, group.greetTotal);
          const wait = Math.round(foodWaitFromGreetDelay(elapsed));
          group.state = "waiting_food";

          // Start per-seat food waiting timers from the LAST taken order.
          for (const c2 of game.customers) {
            if (c2.groupId === group.id && c2.state === "await_order") {
              // If this seat has a pre-item, they will wait for it BEFORE the main dish.
              c2.state = c2.preType ? "waiting_pre" : "waiting_food";
              if (!c2.dishType) c2.dishType = c2.preType || c2.mainDishType || sampleMainDish();
              if (c2.preType) {
              c2.patienceTotal = FOOD_WAIT_MAX;
              c2.patienceLeft = FOOD_WAIT_MAX;
            } else {
              c2.patienceTotal = wait;
              c2.patienceLeft = wait;
            }
            }
          }

          sendNote(room, `All orders taken ✅ (${elapsed.toFixed(1)}s) • Wait: ${wait}s`);
        }
        return;
      }

      
      // Take MAIN order after the pre-item is finished (pre-item has no payment).
      // This is a per-seat order timer (20s) independent from the initial group greeting timer.
      if (seatCust && seatCust.state === "await_order_main") {
        const total = Number(seatCust.mainGreetTotal || ORDER_TAKE_TIME);
        const left = Number(seatCust.mainGreetLeft || 0);
        const elapsed = clamp(total - left, 0, total);

        seatCust.mainDishType = sampleMainDish();
        seatCust.dishType = seatCust.mainDishType;

        let wait = Math.round(foodWaitFromGreetDelay(elapsed));
        // If they got the pre-item they asked for, main-dish waiting time is +10s (bonus).
        if (seatCust.preServed) wait += 10;

        seatCust.patienceTotal = wait;
        seatCust.patienceLeft = wait;

        seatCust.mainGreetLeft = null;
        seatCust.mainGreetTotal = null;

        seatCust.state = "waiting_food";
        sendNote(room, `Order món chính ✅ Seat ${seatIdx + 1}: ${dishLabelVi(seatCust.dishType)} • Wait: ${wait}s`);
        return;
      }

// Pickup plate from THIS seat (hands empty) - but not while the customer is eating
      if (!held && seatPlate && !eatingHere) {
        const it = removePlateFromTableSeat(game, tableIdx, seatIdx);
        if (it) {
          it.zone = "held";
          player.heldItemId = it.id;
          if (it.type === "PLATE") sendNote(room, it.dirty ? "Picked DIRTY plate 🧼" : "Picked plate");
          else sendNote(room, `Picked ${dishLabelVi(it.type)}`);
        }
        return;
      }


      // Serve food/drink/dessert by placing the correct item onto THIS seat
if (held && (held.type === "PLATE" || held.type === "COKE" || held.type === "ICE_CREAM")) {
  if (!seatCust || (seatCust.state !== "waiting_food" && seatCust.state !== "waiting_pre")) { sendNote(room, "No waiting customer at this seat"); return; }

  // For simplicity (and to avoid stacking), require the seat spot to be empty before serving anything.
  if (seatPlate) { sendNote(room, "Seat occupied"); return; }

  const want = canonicalDishType(seatCust.dishType);
  let got = null;

  if (held.type === "PLATE") {
    if (!plateHasDish(held)) { sendNote(room, "Need a cooked pizza on the plate"); return; }
    got = canonicalDishType(held.dishType);
  } else {
    got = canonicalDishType(held.type);
  }

  if (!want || !got || want !== got) {
    // No gold penalty for wrong dish. Instead, reduce THIS seat's remaining wait time ONCE.
    if (!seatCust.wrongPenaltyUsed) {
      seatCust.wrongPenaltyUsed = true;
      if (typeof seatCust.patienceLeft === "number") {
        seatCust.patienceLeft = Math.max(0, seatCust.patienceLeft - WRONG_DISH_WAIT_PENALTY);
      }
      sendNote(room, `Sai món (-${WRONG_DISH_WAIT_PENALTY}s chờ) ❌ Khách cần: ${dishLabelVi(want)} • Bạn đưa: ${dishLabelVi(got || held.dishType || held.type)}`);
    } else {
      sendNote(room, `Sai món ❌ Khách cần: ${dishLabelVi(want)} • Bạn đưa: ${dishLabelVi(got || held.dishType || held.type)}`);
    }
    return;
  }

  // ✅ Correct item
  if (seatCust.state === "waiting_pre") {
    // Serve pre-item (Coke / Ice cream). It will be consumed, THEN the main dish order appears.
    if (!placeItemOnTableSeat(game, held, tableIdx, seatIdx)) { sendNote(room, "Can't place here"); return; }
    player.heldItemId = null;

    seatCust.preServed = true;
    seatCust.state = "eating";
    seatCust.eatingKind = "pre";
    seatCust.eatLeft = randRange(PRE_EAT_TIME_MIN, PRE_EAT_TIME_MAX);
    seatCust.pay = 0; // no payment for pre-item

    sendNote(room, `Served ${dishLabelVi(want)} ✅ (xong sẽ gọi món chính)`);
    return;
  }

  // Main dish: place item onto the table seat. Payment is received only AFTER the customer finishes eating.
  const pts = serveGoldFromCustomer(seatCust);

  if (!placeItemOnTableSeat(game, held, tableIdx, seatIdx)) { sendNote(room, "Can't place here"); return; }
  player.heldItemId = null;

  seatCust.state = "eating";
  seatCust.eatLeft = randRange(EAT_TIME_MIN, EAT_TIME_MAX);
  seatCust.served = true;
  seatCust.pay = pts;

  sendNote(room, `Served ✅ (will pay after eating)`);
  return;
}


    }
  }

  const s = nearestStation(game, player);
  if (!s) return;

  if (s.type === "PLATE") {
    // Plate stack behaves like a mini 3-slot counter.
    const slotIdx = plateNearestSlotIndex(game, player, s.id);
    if (slotIdx === -1) { sendNote(room, "No slot"); return; }
    const slotItem = plateGetSlotItem(game, s.id, slotIdx);

    // empty hand: pick ONLY if that nearest slot has item
    if (!held) {
      if (!slotItem) { sendNote(room, "This slot is empty"); return; }
      const it = plateRemoveFromSlot(game, s.id, slotIdx);
      if (!it) { sendNote(room, "Missing item"); return; }
      it.zone = "held";
      player.heldItemId = it.id;
      sendNote(room, `Picked ${it.type}`);
      return;
    }

    // holding TOPPING: apply to pizza item or plate-tray, else allow placing topping into empty slot
    if (TOPPINGS.includes(held.type)) {
      // apply to pizza item in slot
      if (slotItem && (slotItem.type === "PIZZA_BASE" || slotItem.type === "RAW_PIZZA")) {
        const applied = addToppingToPizzaItem(room, slotItem, held.type);
        if (applied) { removeItemById(game, held.id); player.heldItemId = null; }
        return;
      }
      // apply to tray pizza on plate
      if (slotItem && slotItem.type === "PLATE" && slotItem.tray && (slotItem.tray.stage === "PIZZA_BASE" || slotItem.tray.stage === "RAW_PIZZA")) {
        const meta = slotItem.tray.meta || { cheese: false, sausage: false };
        let applied = false;
        if (held.type === "CHEESE") {
          if (meta.cheese) { sendNote(room, "Cheese already"); applied = false; }
          else { meta.cheese = true; applied = true; }
        } else {
          if (meta.sausage) { sendNote(room, "Sausage already"); applied = false; }
          else { meta.sausage = true; applied = true; }
        }
        if (applied) {
          slotItem.tray.meta = meta;
          if (slotItem.tray.stage === "PIZZA_BASE") slotItem.tray.stage = "RAW_PIZZA";
          sendNote(room, `Added ${held.type}`);
          removeItemById(game, held.id);
          player.heldItemId = null;
        }
        return;
      }
      // place topping item into empty slot
      if (!slotItem) {
        platePlaceItemIntoSlot(game, s.id, held, slotIdx);
        player.heldItemId = null;
        sendNote(room, `Placed ${held.type}`);
        return;
      }
      sendNote(room, "Slot occupied");
      return;
    }

    // holding PIZZA: if slot has EMPTY clean plate -> put pizza into that plate
    if (PIZZA_ITEM_TYPES.includes(held.type)) {
      if (slotItem && slotItem.type === "PLATE" && plateIsEmpty(slotItem) && slotItem.dirty) {
        sendNote(room, "Plate dirty — wash first");
        return;
      }
      if (slotItem && slotItem.type === "PLATE" && plateIsEmpty(slotItem) && !slotItem.dirty) {
        if (held.type === "PIZZA_BASE" || held.type === "RAW_PIZZA") {
          slotItem.tray = { stage: held.type, meta: { ...(held.meta || { cheese:false, sausage:false }) } };
        } else {
          slotItem.completed = true;
          slotItem.dishType = held.type;
        }
        removeItemById(game, held.id);
        player.heldItemId = null;
        sendNote(room, "Pizza placed into plate ✅");
        return;
      }
      // else place pizza item into empty slot
      if (!slotItem) {
        platePlaceItemIntoSlot(game, s.id, held, slotIdx);
        player.heldItemId = null;
        sendNote(room, `Placed ${held.type}`);
        return;
      }
      sendNote(room, "Slot occupied");
      return;
    }

    // holding PLATE: allow catching pizza from slot if plate empty, else place whole plate if slot empty
    if (held.type === "PLATE") {
      if (plateIsEmpty(held) && !held.dirty && slotItem && PIZZA_ITEM_TYPES.includes(slotItem.type)) {
        const pizza = plateRemoveFromSlot(game, s.id, slotIdx);
        if (!pizza) { sendNote(room, "Missing pizza"); return; }
        if (pizza.type === "PIZZA_BASE" || pizza.type === "RAW_PIZZA") {
          held.tray = { stage: pizza.type, meta: { ...(pizza.meta || { cheese:false, sausage:false }) } };
        } else {
          held.completed = true;
          held.dishType = pizza.type;
        }
        removeItemById(game, pizza.id);
        sendNote(room, "Caught pizza into plate ✅");
        return;
      }

      // never split pizza off a plate onto this shelf
      if (!slotItem) {
        platePlaceItemIntoSlot(game, s.id, held, slotIdx);
        player.heldItemId = null;
        sendNote(room, "Placed plate");
        return;
      }
      sendNote(room, "Slot occupied");
      return;
    }

    // any other item: place into empty slot
    if (!slotItem) {
      platePlaceItemIntoSlot(game, s.id, held, slotIdx);
      player.heldItemId = null;
      sendNote(room, `Placed ${held.type}`);
      return;
    }
    sendNote(room, "Slot occupied");
    return;
  }

  if (s.type === "TRASH") {
    trashHeld(room, player);
    return;
  }

  if (s.type === "SINK") {
    const sink = s;
    const slotIdx = sinkNearestSlotIndex(game, player);
    if (slotIdx === -1) { sendNote(room, "No sink slot"); return; }

    // Backward-compat (should not happen in current build)
    if (!Array.isArray(sink.slotItemIds)) {
      sendNote(room, "Sink config error");
      return;
    }

    const slotId = sink.slotItemIds[slotIdx];
    const slotItem = slotId ? findItem(game, slotId) : null;
    if (slotId && !slotItem) {
      sink.slotItemIds[slotIdx] = null;
      if (Array.isArray(sink.slotTs)) sink.slotTs[slotIdx] = 0;
      if (Array.isArray(sink.slotActives)) sink.slotActives[slotIdx] = false;
      if (Array.isArray(sink.slotByPlayerIds)) sink.slotByPlayerIds[slotIdx] = null;
    }

    const pCenter = game.sinkSlotCenters?.[slotIdx] || { x: sink.x + sink.w / 2, y: sink.y + sink.h / 2 };

    // ===== TAKE / START WASH (hands empty) =====
    if (!held) {
      if (!slotItem) { sendNote(room, "This sink slot is empty"); return; }

      // already washing
      if (sink.slotActives?.[slotIdx]) { sendNote(room, "Washing..."); return; }

      // dirty plate: start washing (plate stays in sink)
      if (slotItem.type === "PLATE" && slotItem.dirty) {
        sink.slotActives[slotIdx] = true;
        sink.slotTs[slotIdx] = 0;
        sink.slotByPlayerIds[slotIdx] = player.id;
        sendNote(room, "Washing plate... 🫧");
        return;
      }

      // clean plate: pick up
      slotItem.zone = "held";
      player.heldItemId = slotItem.id;
      sink.slotItemIds[slotIdx] = null;
      sink.slotTs[slotIdx] = 0;
      sink.slotActives[slotIdx] = false;
      sink.slotByPlayerIds[slotIdx] = null;
      sendNote(room, "Took plate");
      return;
    }

    // ===== PUT IN (holding something) =====
    if (held.type !== "PLATE") { sendNote(room, "Only PLATE can go into sink"); return; }

    if (slotItem) { sendNote(room, "Sink slot occupied"); return; }

    // place plate into sink slot
    held.zone = "station";
    held.x = pCenter.x;
    held.y = pCenter.y;
    sink.slotItemIds[slotIdx] = held.id;
    sink.slotTs[slotIdx] = 0;
    sink.slotActives[slotIdx] = false;
    sink.slotByPlayerIds[slotIdx] = null;
    player.heldItemId = null;

    // auto-start washing if dirty + empty
    if (held.dirty && plateIsEmpty(held)) {
      sink.slotActives[slotIdx] = true;
      sink.slotByPlayerIds[slotIdx] = player.id;
      sendNote(room, "Washing plate... 🫧");
    } else {
      sendNote(room, held.dirty ? "Placed DIRTY plate" : "Placed plate");
    }
    return;
  }

    if (s.type === "DISPENSER") {
    if (player.heldItemId) { sendNote(room, "Hands full!"); return; }
    if (s.active) {
      if (s.byPlayerId === player.id) { sendNote(room, "Dispensing..."); return; }
      sendNote(room, "Machine busy");
      return;
    }
    // Start dispensing (takes same time as washing). Player must stay nearby.
    s.active = true;
    s.t = 0;
    s.byPlayerId = player.id;
    sendNote(room, `Dispensing ${dishLabelVi(s.gives)}...`);
    return;
  }

if (s.type === "BIN") {
    if (player.heldItemId) { sendNote(room, "Hands full!"); return; }
    const it = makeItem(s.gives, player.x, player.y, "held");
    game.items.push(it);
    player.heldItemId = it.id;
    sendNote(room, `Got ${s.gives}`);
    return;
  }

  // MAIN TABLE (NEAREST SLOT behavior)
  if (s.type === "CENTER") {
    const slotIdx = centerNearestSlotIndex(game, player);
    if (slotIdx === -1) { sendNote(room, "No slot"); return; }
    const slotItem = centerGetSlotItem(game, slotIdx);

    // empty hand: pick ONLY if that nearest slot has item
    if (!held) {
      if (!slotItem) { sendNote(room, "This slot is empty"); return; }
      const it = centerRemoveFromSlot(game, slotIdx);
      if (!it) { sendNote(room, "Missing item"); return; }
      it.zone = "held";
      player.heldItemId = it.id;
      sendNote(room, `Picked ${it.type}`);
      return;
    }

    // holding TOPPING: apply ONLY to pizza in nearest slot, else place into empty slot
    if (TOPPINGS.includes(held.type)) {
      // 1) Apply topping to pizza item sitting on this slot
      if (slotItem && (slotItem.type === "PIZZA_BASE" || slotItem.type === "RAW_PIZZA")) {
        const applied = addToppingToPizzaItem(room, slotItem, held.type);
        if (applied) {
          removeItemById(game, held.id);
          player.heldItemId = null;
        }
        return;
      }

      // 2) ✅ Apply topping to pizza that is currently on a PLATE in this slot (tray)
      if (
        slotItem &&
        slotItem.type === "PLATE" &&
        slotItem.tray &&
        (slotItem.tray.stage === "PIZZA_BASE" || slotItem.tray.stage === "RAW_PIZZA")
      ) {
        const meta = slotItem.tray.meta || { cheese: false, sausage: false };
        let applied = false;

        if (held.type === "CHEESE") {
          if (meta.cheese) { sendNote(room, "Cheese already"); applied = false; }
          else { meta.cheese = true; applied = true; }
        } else {
          if (meta.sausage) { sendNote(room, "Sausage already"); applied = false; }
          else { meta.sausage = true; applied = true; }
        }

        if (applied) {
          slotItem.tray.meta = meta;
          if (slotItem.tray.stage === "PIZZA_BASE") slotItem.tray.stage = "RAW_PIZZA";
          sendNote(room, `Added ${held.type}`);
          removeItemById(game, held.id);
          player.heldItemId = null;
        }
        return;
      }

      // 3) If this slot is empty -> allow placing topping item here
      if (!slotItem) {
        centerPlaceItemIntoSlot(game, held, slotIdx);
        player.heldItemId = null;
        sendNote(room, `Placed ${held.type} in this slot`);
        return;
      }

      // 4) Otherwise occupied by something else
      sendNote(room, "Can't put topping here");
      return;
    }

    // holding PIZZA: if nearest slot has EMPTY PLATE -> put pizza INTO that plate (plate stays)
    if (PIZZA_ITEM_TYPES.includes(held.type)) {
      if (slotItem && slotItem.type === "PLATE" && plateIsEmpty(slotItem) && slotItem.dirty) {
        sendNote(room, "Plate dirty — wash first");
        return;
      }
      if (slotItem && slotItem.type === "PLATE" && plateIsEmpty(slotItem) && !slotItem.dirty) {
        if (held.type === "PIZZA_BASE" || held.type === "RAW_PIZZA") {
          slotItem.tray = { stage: held.type, meta: { ...(held.meta || { cheese:false, sausage:false }) } };
        } else {
          slotItem.completed = true;
          slotItem.dishType = held.type;
        }
        // consume pizza item
        if (typeof held.slotIndex === "number" && game.centerSlots[held.slotIndex] === held.id) {
          game.centerSlots[held.slotIndex] = null;
        }
        removeItemById(game, held.id);
        player.heldItemId = null;
        sendNote(room, "Pizza placed into plate ✅");
        return;
      }

      // else place pizza into this slot ONLY if empty
      if (!slotItem) {
        centerPlaceItemIntoSlot(game, held, slotIdx);
        player.heldItemId = null;
        sendNote(room, `Placed ${held.type} in this slot`);
        return;
      }

      sendNote(room, "Slot occupied");
      return;
    }

    // holding PLATE: catch pizza from nearest slot if plate empty, else place plate/pizza-from-plate into THIS slot if empty
    if (held.type === "PLATE") {
      // plate empty -> can catch pizza from THIS nearest slot (must be pizza)
      if (plateIsEmpty(held) && !held.dirty && slotItem && PIZZA_ITEM_TYPES.includes(slotItem.type)) {
        const pizza = centerRemoveFromSlot(game, slotIdx);
        if (!pizza) { sendNote(room, "Missing pizza"); return; }

        if (pizza.type === "PIZZA_BASE" || pizza.type === "RAW_PIZZA") {
          held.tray = { stage: pizza.type, meta: { ...(pizza.meta || { cheese:false, sausage:false }) } };
        } else {
          held.completed = true;
          held.dishType = pizza.type;
        }
        removeItemById(game, pizza.id);
        sendNote(room, "Caught pizza into plate ✅");
        return;
      }

      // NOTE: Do NOT split pizza off a plate onto the MAIN TABLE.
// If the plate already contains a tray pizza or cooked dish, the whole plate can be placed down,
// but the pizza cannot be separated from the plate here. Pizza can leave a plate via:
// - OVEN flow (RAW_PIZZA baking / takeout to plate)
// - SERVE at customer tables
// - TRASH (resets the plate)

      // plate (any state) + slot empty -> place the whole plate into THIS slot
      if (!slotItem) {
        centerPlaceItemIntoSlot(game, held, slotIdx);
        player.heldItemId = null;
        sendNote(room, "Placed plate into this slot");
        return;
      }

sendNote(room, "Slot occupied");
      return;
    }

    // any other item: place into THIS slot only if empty
    if (!slotItem) {
      centerPlaceItemIntoSlot(game, held, slotIdx);
      player.heldItemId = null;
      sendNote(room, `Placed ${held.type} in this slot`);
      return;
    }
    sendNote(room, "Slot occupied");
    return;
  }

  // OVEN
  if (s.type === "OVEN") {
    const oven = s;

    const slotIdx = ovenNearestSlotIndex(game, player);
    if (slotIdx === -1) { sendNote(room, "No oven slot"); return; }
    if (!Array.isArray(oven.slotItemIds)) { sendNote(room, "Oven config error"); return; }

    const slotId = oven.slotItemIds[slotIdx];
    const slotItem = slotId ? findItem(game, slotId) : null;
    if (slotId && !slotItem) {
      oven.slotItemIds[slotIdx] = null;
      if (Array.isArray(oven.slotTs)) oven.slotTs[slotIdx] = 0;
    }

    const pCenter = game.ovenSlotCenters?.[slotIdx] || { x: oven.x + oven.w / 2, y: oven.y + oven.h / 2 };

    // ===== TAKE OUT (slot occupied) =====
    if (slotItem) {
      if (!held || held.type !== "PLATE") { sendNote(room, "Need PLATE to take out!"); return; }
      if (!plateIsUsable(held)) { sendNote(room, "Plate not empty"); return; }
      if (held.dirty) { sendNote(room, "Plate dirty — wash first"); return; }

      // Put result into the plate
      if (slotItem.type === "PIZZA_BASE" || slotItem.type === "RAW_PIZZA") {
        held.tray = { stage: slotItem.type, meta: { ...(slotItem.meta || { cheese:false, sausage:false }) } };
      } else {
        held.completed = true;
        held.dishType = slotItem.type;
      }

      removeItemById(game, slotItem.id);
      oven.slotItemIds[slotIdx] = null;
      if (Array.isArray(oven.slotTs)) oven.slotTs[slotIdx] = 0;
      sendNote(room, "Taken out into plate ✅");
      return;
    }

    // ===== PUT IN (slot empty) =====
    // 1) From a plate tray (RAW pizza only, must have topping)
    if (held && held.type === "PLATE" && plateHasTray(held)) {
      const tray = held.tray;
      if (tray.stage !== "RAW_PIZZA" || !hasAnyTopping(tray.meta)) { sendNote(room, "Need RAW pizza with topping"); return; }
      const it = makeItem("RAW_PIZZA", pCenter.x, pCenter.y, "station", tray.meta || null);
      game.items.push(it);
      held.tray = null;
      oven.slotItemIds[slotIdx] = it.id;
      if (Array.isArray(oven.slotTs)) oven.slotTs[slotIdx] = 0;
      sendNote(room, "Baking...");
      return;
    }

    // 2) Directly hold a RAW_PIZZA item
    if (!held) { sendNote(room, "Hold RAW pizza to bake"); return; }
    if (held.type !== "RAW_PIZZA") { sendNote(room, "Only RAW pizza can go into oven"); return; }
    if (!hasAnyTopping(held.meta)) { sendNote(room, "Add cheese/sausage first (on table)"); return; }

    held.zone = "station";
    held.x = pCenter.x;
    held.y = pCenter.y;
    oven.slotItemIds[slotIdx] = held.id;
    if (Array.isArray(oven.slotTs)) oven.slotTs[slotIdx] = 0;
    player.heldItemId = null;
    sendNote(room, "Baking...");
    return;
  }
}

/** Tick update */
function updateRoom(room) {
  const game = room.game;
  if (!game || room.phase !== "playing" || game.ended) return;

  const t = nowMs();
  let dt = (t - game.lastUpdateAt) / 1000;
  game.lastUpdateAt = t;
  dt = clamp(dt, 0, 0.06);

  // Host pause freezes the simulation (no movement, timers, cooking, washing, etc.).
  if (game.paused) {
    for (const p of room.players.values()) {
      if (p) {
        p.vx = 0; p.vy = 0;
      }
    }
    return;
  }

  const cc = connectedCount(room);
  if (cc < 2) {
    if (!game.below2Since) game.below2Since = t;
    if ((t - game.below2Since) / 1000 >= 15) { endGame(room, false, "Not enough players"); return; }
  } else game.below2Since = null;

  game.timeLeft -= dt;
  if (game.timeLeft < 0) game.timeLeft = 0;

  // OVEN (2 slots) progression
  const oven = findStationById(game, "OVEN");
  if (oven && Array.isArray(oven.slotItemIds)) {
    for (let oi = 0; oi < oven.slotItemIds.length; oi++) {
      const id = oven.slotItemIds[oi];
      if (!id) {
        if (Array.isArray(oven.slotTs)) oven.slotTs[oi] = 0;
        continue;
      }

      const it = findItem(game, id);
      if (!it) {
        oven.slotItemIds[oi] = null;
        if (Array.isArray(oven.slotTs)) oven.slotTs[oi] = 0;
        continue;
      }

      const slotCount = Array.isArray(oven.slotItemIds) ? oven.slotItemIds.length : 2;
if (!Array.isArray(oven.slotTs) || oven.slotTs.length !== slotCount) oven.slotTs = Array(slotCount).fill(0);
oven.slotTs[oi] += dt;


      // RAW -> cooked
      if (oven.slotTs[oi] >= BAKE_TIME && it.type === "RAW_PIZZA") {
        const cookType = cookedTypeFromToppings(it.meta);
        if (cookType) {
          it.type = cookType;
          sendNote(room, "Pizza baked ✅");
        }
      }

      // cooked -> burnt
      if (oven.slotTs[oi] >= (BAKE_TIME + BURN_EXTRA) && PIZZA_TYPES.includes(it.type)) {
        it.type = "BURNT_PIZZA";
        sendNote(room, "Burnt pizza 💀");
      }
    }
  }

  // SINK washing progression (2 slots)
  const sink = findStationById(game, "SINK");
  if (sink && Array.isArray(sink.slotItemIds)) {
    if (!Array.isArray(sink.slotTs)) sink.slotTs = [0, 0];
    if (!Array.isArray(sink.slotActives)) sink.slotActives = [false, false];
    if (!Array.isArray(sink.slotByPlayerIds)) sink.slotByPlayerIds = [null, null];

    for (let si = 0; si < sink.slotItemIds.length; si++) {
      const id = sink.slotItemIds[si];
      if (!id) {
        sink.slotTs[si] = 0;
        sink.slotActives[si] = false;
        sink.slotByPlayerIds[si] = null;
        continue;
      }

      const plate = findItem(game, id);
      if (!plate) {
        sink.slotItemIds[si] = null;
        sink.slotTs[si] = 0;
        sink.slotActives[si] = false;
        sink.slotByPlayerIds[si] = null;
        continue;
      }

      if (!sink.slotActives[si]) continue;

      // Player must stay at the sink to keep washing.
      const washer = sink.slotByPlayerIds[si] ? room.players.get(sink.slotByPlayerIds[si]) : null;
      const washerHere = washer && washer.connected && nearRect(washer.x, washer.y, sink, INTERACT_DIST);

      if (!washerHere) {
        // Cancel wash and reset progress (must restart from 0)
        sink.slotActives[si] = false;
        sink.slotTs[si] = 0;
        sink.slotByPlayerIds[si] = null;
        continue;
      }

      sink.slotTs[si] += dt;
      if (sink.slotTs[si] >= WASH_TIME) {
        sink.slotTs[si] = WASH_TIME;
        sink.slotActives[si] = false;
        sink.slotByPlayerIds[si] = null;
        plate.dirty = false;
        sendNote(room, "Plate washed ✅");
      }
    }
  }

// DISPENSERS (Coke / Ice cream) progression — same rules as washing:
// - ACTION starts dispensing (hands must be empty)
// - Player must stay nearby; moving away/disconnect/carrying cancels and resets progress.
if (game.layout && Array.isArray(game.layout.stations)) {
  for (const d of game.layout.stations) {
    if (!d || d.type !== "DISPENSER") continue;
    if (!d.active) continue;

    const p = d.byPlayerId ? room.players.get(d.byPlayerId) : null;
    const ok = p && p.connected && !p.heldItemId && nearRect(p.x, p.y, d, INTERACT_DIST);

    if (!ok) {
      d.active = false;
      d.t = 0;
      d.byPlayerId = null;
      continue;
    }

    d.t = Number(d.t || 0) + dt;
    if (d.t >= WASH_TIME) {
      d.active = false;
      d.t = 0;
      d.byPlayerId = null;

      const it = makeItem(d.gives, p.x, p.y, "held");
      game.items.push(it);
      p.heldItemId = it.id;

      sendNote(room, `Got ${dishLabelVi(d.gives)} ✅`);
    }
  }
}

  const cfg = room.config;

  // Spawn new GROUP (up to 3 tables total in this map).
  // We allow all 3 tables to fill (rarely) even on easier difficulties.
  game.customerSpawnT += dt;
  if (cfg && game.customerSpawnT >= cfg.ORDER_SPAWN_INTERVAL) {
    game.customerSpawnT = 0;

    const maxTables = Math.min(3, game.tableOccupied.length);
    const occupied = game.tableOccupied.filter(Boolean).length;

    const maxCustomers = maxCustomersForPlayers(room.lockedCount);
    const activeCustomers = game.customers.length;
    const remaining = maxCustomers - activeCustomers;

    // Make the 3rd simultaneous table rare (hard moment).
    let allowSpawn = true;
    if (occupied >= 2 && maxTables >= 3 && Math.random() > thirdTableSpawnChance(room.lockedCount)) allowSpawn = false;
    if (remaining <= 0) allowSpawn = false;

    if (allowSpawn && occupied < maxTables) {
      const freeTables = [];
      for (let i = 0; i < game.tableOccupied.length; i++) {
        if (!game.tableOccupied[i]) freeTables.push(i);
      }
      if (freeTables.length) {
        const tableIdx = freeTables[Math.floor(Math.random() * freeTables.length)];
        spawnGroupIntoTable(room, game, tableIdx, remaining);
      }
    }
  }

  // GROUP timers:
  // - greet timer starts once ALL members are seated
  // - food patience timer starts ONLY when the LAST order is taken
  if (game.groups) {
    for (const gid of Object.keys(game.groups)) {
      const g = game.groups[gid];
      if (!g) continue;

      // Start greet timer when everyone has reached their chairs
      if (!g.greetActive && g.acceptedCount < g.size && g.state !== "leaving") {
        const allSeated = g.memberIds.every(id => {
          const c = game.customers.find(cc => cc.id === id);
          return c && c.state === "await_order";
        });
        if (allSeated) {
          g.greetActive = true;
          g.greetLeft = g.greetTotal;
          g.state = "await_order";
        }
      }

      // No one took all orders in time
      if (g.greetActive && g.acceptedCount < g.size && g.state !== "leaving") {
        g.greetLeft -= dt;
        if (g.greetLeft <= 0) {
          g.greetLeft = 0;
          sendNote(room, "Customers left (no one took the orders) 😕");
          g.state = "leaving";
          for (const c of game.customers) {
            if (c.groupId === gid && c.state !== "leaving") {
              c.state = "leaving";
              c.tx = game.layout.entrance.x;
              c.ty = game.layout.entrance.y;
            }
          }
        }
      }

      // Per-seat food patience countdown (starts when the LAST order is taken).
      // Each customer has their own patienceLeft/patienceTotal; wrong dish reduces only that seat.
      if (g.state === "waiting_food" && g.state !== "leaving") {
        
        const timedOut = [];

        for (const id of g.memberIds) {
          const c = game.customers.find(cc => cc.id === id);
          if (!c) continue;

          if ((c.state === "waiting_food" || c.state === "waiting_pre") && !c.served && typeof c.patienceLeft === "number" && typeof c.patienceTotal === "number") {
            c.patienceLeft -= dt;
            if (c.patienceLeft <= 0) {
              c.patienceLeft = 0;
              timedOut.push(c);
            }
          }
        }

        // If one person runs out of time, ONLY that person leaves.
        // Penalty still scales with the original group size (harder tables punish more),
        // and people who already ate / are eating will still pay and leave together later.
        if (timedOut.length) {
          const perLeavePenalty = leaveAngryPenaltyPerPerson(g.size);
          const totalPenalty = perLeavePenalty * timedOut.length;
          game.score = Math.max(0, game.score - totalPenalty);

          const seats = timedOut.map(c => (c.seatIndex + 1)).join(", ");
          sendNote(room, timedOut.length === 1
            ? `Seat ${seats} left angry (-${perLeavePenalty} 🪙)`
            : `Seats ${seats} left angry (-${totalPenalty} 🪙)`);

          for (const c of timedOut) {
            c.state = "leaving";
            c.tx = game.layout.entrance.x;
            c.ty = game.layout.entrance.y;
          }
        }

      }

      // Everyone finished eating -> leave together (people who finish early will wait seated).
      if (g.state !== "leaving") {
        const allDone = g.memberIds.every(id => {
          const c = game.customers.find(cc => cc.id === id);
          return c && c.state === "done";
        });

        if (allDone && g.memberIds.length > 0) {
          g.state = "leaving";
          for (const c of game.customers) {
            if (c.groupId === gid && c.state === "done") {
              c.state = "leaving";
              c.tx = game.layout.entrance.x;
              c.ty = game.layout.entrance.y;
            }
          }
        }
      }
    }
  }

  // Individual customer movement / eating / cleanup
  for (let i = game.customers.length - 1; i >= 0; i--) {
    const c = game.customers[i];

    if (c.state === "walking" || c.state === "leaving") {
      const dx = c.tx - c.x;
      const dy = c.ty - c.y;
      const d = Math.hypot(dx, dy);
      if (d < 2.5) {
        c.x = c.tx; c.y = c.ty;
        if (c.state === "walking") {
          c.state = "await_order";
        } else {
          // remove at door
          const g = getGroup(game, c.groupId);
          if (g) g.memberIds = g.memberIds.filter(id => id !== c.id);
          game.customers.splice(i, 1);

          if (g && g.memberIds.length === 0) {
            // free table + remove group
            game.tableOccupied[g.tableIndex] = false;
            delete game.groups[g.id];
          }
          continue;
        }
      } else {
        const nx = dx / d, ny = dy / d;
        c.x += nx * c.speed * dt;
        c.y += ny * c.speed * dt;
      }
    }

    
    // After finishing a pre-item, customer waits to ORDER the main dish (20s). If not taken, they leave.
    if (c.state === "await_order_main") {
      if (typeof c.mainGreetTotal !== "number") c.mainGreetTotal = ORDER_TAKE_TIME;
      if (typeof c.mainGreetLeft !== "number") c.mainGreetLeft = c.mainGreetTotal;

      c.mainGreetLeft -= dt;
      if (c.mainGreetLeft <= 0) {
        c.mainGreetLeft = 0;
        sendNote(room, `Seat ${c.seatIndex + 1} left (no main order) 😕`);
        c.state = "leaving";
        c.tx = game.layout.entrance.x;
        c.ty = game.layout.entrance.y;
      }
    }

if (c.state === "eating") {
      c.eatLeft -= dt;
      if (c.eatLeft <= 0) {
        // Item at THIS seat after eating:
        // - Pizza plate becomes dirty and stays
        // - Coke / Ice cream is consumed and disappears
        const pid = game.tableSeatSlots?.[c.tableIndex]?.[c.seatIndex] || null;
        const item = pid ? findItem(game, pid) : null;
        if (item && item.type === "PLATE") {
          resetPlate(item);
          item.dirty = true;
        } else if (pid) {
          if (Array.isArray(game.tableSeatSlots?.[c.tableIndex])) game.tableSeatSlots[c.tableIndex][c.seatIndex] = null;
          removeItemById(game, pid);
        }

        const pay = Math.max(0, Math.round(Number(c.pay || 0)));

        // If this was a PRE-item (coke/ice cream), there is NO payment.
        // After finishing the pre-item, the MAIN order appears and must be taken within 20s.
        if (c.eatingKind === "pre") {
          c.eatingKind = null;

          // After finishing the pre-item: reveal the MAIN dish automatically (no extra ACTION).
          // Waiting timer is shared between pre and main; grant +10s bonus to remaining waiting time.
          if (!c.mainDishType) c.mainDishType = sampleMainDish();
          c.dishType = c.mainDishType;

          if (typeof c.patienceTotal !== "number" || typeof c.patienceLeft !== "number") {
            c.patienceTotal = FOOD_WAIT_MAX;
            c.patienceLeft = FOOD_WAIT_MAX;
          }

          c.patienceLeft = Math.max(0, Number(c.patienceLeft || 0) + PRE_BONUS_WAIT);

          c.state = "waiting_food";
          c.preServed = true;
          c.served = false;

          sendNote(room, `Món chính xuất hiện ✅ Seat ${c.seatIndex + 1}: ${dishLabelVi(c.dishType)} (+${PRE_BONUS_WAIT}s)`);
        } else {
          // Main dish payment (gold is received only AFTER eating)
          if (pay > 0) {
            game.score += pay;
            sendNote(room, `Paid +${pay} 🪙`);
          } else {
            sendNote(room, "Customer finished 🍽️");
          }
          // Customer stays seated until the whole group leaves together.
          c.state = "done";
        }
      }
    }
  }

  const walls = game.layout.walls;
  const playersArr = Array.from(room.players.values());

  for (const p of playersArr) {
    if (!p.connected) continue;

    const ix = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const iy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);

    const hasAnalog = typeof p.input.ax === "number" || typeof p.input.ay === "number";
    let vx = hasAnalog ? (p.input.ax || 0) : ix;
    let vy = hasAnalog ? (p.input.ay || 0) : iy;

    const mag = Math.hypot(vx, vy);
    if (mag > 0) {
      const scale = Math.min(1, mag);
      vx /= mag; vy /= mag;
      p.x += vx * PLAYER_SPEED * scale * dt;
      p.y += vy * PLAYER_SPEED * scale * dt;
    }

    p.x = clamp(p.x, PLAYER_R + 6, MAP_W - PLAYER_R - 6);
    p.y = clamp(p.y, PLAYER_R + 6, MAP_H - PLAYER_R - 6);

    for (const w of walls) {
      const res = circleRectOverlapResolve(p.x, p.y, PLAYER_R, w.x, w.y, w.w, w.h);
      if (res.hit) { p.x = res.x; p.y = res.y; }
    }

    // Prevent walking through customer tables (round) and customers.
    // Tables are circles; customers are circles at their current positions.
    if (game.layout && Array.isArray(game.layout.tables)) {
      for (const tb of game.layout.tables) {
        if (typeof tb.cx !== "number" || typeof tb.cy !== "number" || typeof tb.r !== "number") continue;
        const res = circleCircleOverlapResolve(p.x, p.y, PLAYER_R, tb.cx, tb.cy, tb.r + TABLE_COLLISION_PAD);
        if (res.hit) { p.x = res.x; p.y = res.y; }
      }
    }

    if (Array.isArray(game.customers)) {
      for (const c of game.customers) {
        if (!c) continue;
        // Keep collision for all active customers (including leaving), but skip fully removed ones.
        if (c.state === "gone" || c.state === "removed") continue;
        const res = circleCircleOverlapResolve(p.x, p.y, PLAYER_R, c.x, c.y, CUSTOMER_R);
        if (res.hit) { p.x = res.x; p.y = res.y; }
      }
    }

    // Re-clamp & re-resolve walls after circle pushes so we never end up inside a wall.
    p.x = clamp(p.x, PLAYER_R + 6, MAP_W - PLAYER_R - 6);
    p.y = clamp(p.y, PLAYER_R + 6, MAP_H - PLAYER_R - 6);
    for (const w of walls) {
      const res = circleRectOverlapResolve(p.x, p.y, PLAYER_R, w.x, w.y, w.w, w.h);
      if (res.hit) { p.x = res.x; p.y = res.y; }
    }
  }

  for (let i = 0; i < playersArr.length; i++) {
    for (let j = i + 1; j < playersArr.length; j++) {
      const a = playersArr[i], b = playersArr[j];
      const minD = a.r + b.r;
      const d = dist(a.x, a.y, b.x, b.y);
      if (d > 0 && d < minD) {
        const push = (minD - d) / 2;
        const nx = (a.x - b.x) / d;
        const ny = (a.y - b.y) / d;
        const af = a.connected ? 1 : 0.2;
        const bf = b.connected ? 1 : 0.2;

        a.x += nx * push * af; a.y += ny * push * af;
        b.x -= nx * push * bf; b.y -= ny * push * bf;

        a.x = clamp(a.x, PLAYER_R + 6, MAP_W - PLAYER_R - 6);
        a.y = clamp(a.y, PLAYER_R + 6, MAP_H - PLAYER_R - 6);
        b.x = clamp(b.x, PLAYER_R + 6, MAP_W - PLAYER_R - 6);
        b.y = clamp(b.y, PLAYER_R + 6, MAP_H - PLAYER_R - 6);
      }
    }
  }

  for (const p of playersArr) {
    if (p.heldItemId) {
      const it = findItem(game, p.heldItemId);
      if (it) {
        it.zone = "held";
        it.x = p.x;
        it.y = p.y - 30;
        if (typeof it.slotIndex === "number") delete it.slotIndex;
      } else p.heldItemId = null;
    }
  }

  if (game.score >= game.target) { endGame(room, true, "Target reached"); return; }
  if (game.timeLeft <= 0) { endGame(room, false, "Time up"); return; }

  if (t - game.lastSnapshotAt >= (1000 / SNAPSHOT_RATE)) {
    game.lastSnapshotAt = t;
    io.to(room.code).emit("state", buildSnapshot(room));
  }
}

function buildSnapshot(room) {
  const game = room.game;


  const cfg = room.config;
  const layout = game ? game.layout : buildKitchenLayout(2);

  const stationsOut = layout.stations.map(s => {
    const out = {
      id: s.id,
      type: s.type,
      label: s.label,
      gives: s.gives || null,
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h
    };

    if (s.type === "PLATE") {
      out.slotCount = Number(s.slotCount || 0) || null;
    }

    // OVEN: 2 slots + per-slot timers
    if (s.type === "OVEN") {
      const ids = Array.isArray(s.slotItemIds) ? s.slotItemIds : [s.slotItemId || null];
      const slots = ids.map(id => {
        if (!id || !game) return null;
        const it = game.items.find(it => it.id === id);
        if (!it) return null;
        return { type: it.type, meta: it.meta || null };
      });
      out.slots = slots;
      out.slotTs = Array.isArray(s.slotTs) ? s.slotTs : [Number(s.t || 0)];
    }

    // SINK: 2 slots + per-slot wash timers/actives
    if (s.type === "SINK") {
      const ids = Array.isArray(s.slotItemIds) ? s.slotItemIds : [s.slotItemId || null];
      const slots = ids.map(id => {
        if (!id || !game) return null;
        const it = game.items.find(it => it.id === id);
        if (!it) return null;
        return { type: it.type };
      });
      out.slots = slots;
      out.slotTs = Array.isArray(s.slotTs) ? s.slotTs : [Number(s.t || 0)];
      out.slotActives = Array.isArray(s.slotActives) ? s.slotActives : [!!s.active];
    }
    // DISPENSER: timed progress (like washing)
    if (s.type === "DISPENSER") {
      out.active = !!s.active;
      out.t = Number(s.t || 0);
      out.byPlayerId = s.byPlayerId || null;
    }


    return out;
  });

  const playersOut = Array.from(room.players.values()).map(p => {
    let heldType = null;
    let heldMeta = null;
    let heldPlate = null;

    if (game && p.heldItemId) {
      const it = game.items.find(it => it.id === p.heldItemId);
      if (it) {
        heldType = it.type;
        heldMeta = it.meta || null;
        if (it.type === "PLATE") {
          heldPlate = {
            dirty: !!it.dirty,
            completed: !!it.completed,
            dishType: it.dishType || null,
            tray: it.tray ? { stage: it.tray.stage, meta: it.tray.meta || null } : null
          };
        }
      }
    }

    return { id: p.id, name: p.name, x: p.x, y: p.y, connected: p.connected, heldType, heldMeta, heldPlate };
  });

  const itemsOut = game ? game.items
    .filter(it => it.zone !== "held")
    .map(it => ({
      id: it.id,
      type: it.type,
      x: it.x,
      y: it.y,
      zone: it.zone,
      meta: it.meta || null,
      slotIndex: typeof it.slotIndex === "number" ? it.slotIndex : null,
      plateStationId: it.plateStationId || null,
      plateSlotIndex: typeof it.plateSlotIndex === "number" ? it.plateSlotIndex : null,
      completed: it.type === "PLATE" ? !!it.completed : undefined,
      dishType: it.type === "PLATE" ? (it.dishType || null) : undefined,
      dirty: it.type === "PLATE" ? !!it.dirty : undefined,
      tray: it.type === "PLATE" ? (it.tray ? { stage: it.tray.stage, meta: it.tray.meta || null } : null) : undefined
    })) : [];

  const customersOut = game ? game.customers.map(c => {
    const g = getGroup(game, c.groupId);
    const inGreetGroup = (c.state === "await_order") && g && g.greetActive && (g.acceptedCount < g.size);
    const inGreetMain = (c.state === "await_order_main") && (typeof c.mainGreetLeft === "number") && (typeof c.mainGreetTotal === "number");
    const inWait = (c.state === "waiting_food" || c.state === "waiting_pre") && (typeof c.patienceLeft === "number") && (typeof c.patienceTotal === "number");

    return {
      id: c.id,
      x: c.x,
      y: c.y,
      state: c.state,
      groupId: c.groupId || null,
      tableIndex: typeof c.tableIndex === "number" ? c.tableIndex : null,
      seatIndex: typeof c.seatIndex === "number" ? c.seatIndex : null,

      // Reveal dish only after order is taken
      dishType: c.dishType || null,

      // shared timers
      greetLeft: inGreetGroup ? g.greetLeft : (inGreetMain ? c.mainGreetLeft : null),
      greetTotal: inGreetGroup ? g.greetTotal : (inGreetMain ? c.mainGreetTotal : null),
      patienceLeft: inWait ? c.patienceLeft : null,
      patienceTotal: inWait ? c.patienceTotal : null
    };
  }) : [];

  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    lockedCount: room.lockedCount || null,
    map: { w: MAP_W, h: MAP_H, walls: layout.walls },
    game: game ? { timeLeft: game.timeLeft, duration: game.duration, score: game.score, target: game.target, below2Since: game.below2Since, paused: !!game.paused } : null,
    config: cfg || null,
    stations: stationsOut,
    tables: layout.tables,
    entrance: layout.entrance,
    customers: customersOut,
    players: playersOut,
    items: itemsOut,
    centerSlots: game ? game.centerSlots : null,
    plateStacks: game ? game.plateStacks : null,
    plateSlots: (game && game.plateStacks && game.plateStacks.PLATE_HOME) ? game.plateStacks.PLATE_HOME.slots : null,
    tableSeatSlots: game ? game.tableSeatSlots : null
  };
}

/** Sockets */
io.on("connection", (socket) => {
  socket.data.roomCode = null;

  socket.on("createRoom", ({ name }) => {
    const playerName = String(name || "Player").trim().slice(0, 18) || "Player";
    let code = makeCode(5);
    while (rooms.has(code)) code = makeCode(5);

    const room = {
      code,
      phase: "lobby",
      hostId: socket.id,
      lockedCount: null,
      config: null,
      game: null,
      players: new Map(),
      createdAt: nowMs()
    };

    const spawns = getSpawnPositions();
    room.players.set(socket.id, makePlayer(socket.id, playerName, spawns[0]));
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("joined", { code });
    roomBroadcast(room);
  });

  socket.on("joinRoom", ({ name, code }) => {
    const playerName = String(name || "Player").trim().slice(0, 18) || "Player";
    const roomCode = normalizeCode(code);

    const room = rooms.get(roomCode);
    if (!room) { socket.emit("errorMsg", "Room not found."); return; }
    if (room.players.size >= 5) { socket.emit("errorMsg", "Room is full (max 5)."); return; }

    const spawns = getSpawnPositions();
    room.players.set(socket.id, makePlayer(socket.id, playerName, spawns[Math.min(room.players.size, 4)]));

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    ensureHost(room);
    socket.emit("joined", { code: roomCode });
    roomBroadcast(room);

    if (room.phase === "playing" && room.game && !room.game.ended) {
      socket.emit("state", buildSnapshot(room));
      sendNote(room, `${playerName} joined (difficulty locked at ${room.lockedCount}).`);
    }
  });

  socket.on("leaveRoom", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    socket.leave(code);
    socket.data.roomCode = null;
    if (!room) return;

    if (room.phase === "playing" && room.game && !room.game.ended) {
      const p = room.players.get(socket.id);
      if (p) {
        p.connected = false;
        p.input = { up: false, down: false, left: false, right: false, ax: null, ay: null };
        if (p.heldItemId) dropHeldToFloor(room, p);
      }
      ensureHost(room);
      roomBroadcast(room);
      sendNote(room, "A player left (ghost stays).");
      return;
    }

    room.players.delete(socket.id);
    ensureHost(room);
    roomBroadcast(room);
    if (room.players.size === 0) rooms.delete(code);
  });

  socket.on("startGame", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    ensureHost(room);
    if (socket.id !== room.hostId) { socket.emit("errorMsg", "Only host can start."); return; }
    if (room.phase !== "lobby" && room.phase !== "ended") { socket.emit("errorMsg", "Cannot start right now."); return; }

    const cc = connectedCount(room);
    if (cc < 2 || cc > 5) { socket.emit("errorMsg", "Need 2–5 connected players to start."); return; }

    startGame(room, cc);
    io.to(room.code).emit("state", buildSnapshot(room));
  });

  socket.on("restart", ({ mode }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    ensureHost(room);
    if (socket.id !== room.hostId) { socket.emit("errorMsg", "Only host can restart."); return; }

    const m = String(mode || "lobby");
    if (m === "again") {
      const cc = connectedCount(room);
      if (cc < 2 || cc > 5) { socket.emit("errorMsg", "Need 2–5 connected players to play again."); return; }
      startGame(room, cc);
      io.to(room.code).emit("state", buildSnapshot(room));
      return;
    }

    room.phase = "lobby";
    room.lockedCount = null;
    room.config = null;
    room.game = null;

    for (const [id, p] of room.players.entries()) {
      if (!p.connected) room.players.delete(id);
      else p.heldItemId = null;
    }
    ensureHost(room);
    roomBroadcast(room);
  });

  socket.on("togglePause", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.phase !== "playing" || !room.game || room.game.ended) return;

    ensureHost(room);
    if (socket.id !== room.hostId) { socket.emit("errorMsg", "Only host can pause."); return; }

    room.game.paused = !room.game.paused;
    sendNote(room, room.game.paused ? "⏸ Paused" : "▶️ Resumed");
    io.to(room.code).emit("state", buildSnapshot(room));
  });

  socket.on("input", (inp) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.phase !== "playing" || !room.game || room.game.ended) return;

    const p = room.players.get(socket.id);
    if (!p || !p.connected) return;

    const ax = (typeof inp?.ax === "number") ? clamp(inp.ax, -1, 1) : null;
    const ay = (typeof inp?.ay === "number") ? clamp(inp.ay, -1, 1) : null;
    p.input = { up: !!inp?.up, down: !!inp?.down, left: !!inp?.left, right: !!inp?.right, ax, ay };
    p.lastInputAt = nowMs();
  });

  socket.on("action", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.phase !== "playing" || !room.game || room.game.ended) return;
    if (room.game.paused) return;
    const p = room.players.get(socket.id);
    if (!p || !p.connected) return;
    if (!canConsumeAction(p)) return;
    stationAction(room, p);
  });

  socket.on("drop", () => {}); // unused

  socket.on("trash", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.phase !== "playing" || !room.game || room.game.ended) return;
    if (room.game.paused) return;
    const p = room.players.get(socket.id);
    if (!p || !p.connected) return;
    if (!canConsumeAction(p)) return;

    const trashS = findStationById(room.game, "TRASH");
    if (trashS && nearRect(p.x, p.y, trashS, INTERACT_DIST)) trashHeld(room, p);
    else sendNote(room, "Not near TRASH");
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (room.phase === "playing" && room.game && !room.game.ended) {
      const p = room.players.get(socket.id);
      if (p) {
        p.connected = false;
        p.input = { up: false, down: false, left: false, right: false, ax: null, ay: null };
        if (p.heldItemId) dropHeldToFloor(room, p);
      }
      ensureHost(room);
      roomBroadcast(room);
      return;
    }

    room.players.delete(socket.id);
    ensureHost(room);
    roomBroadcast(room);
    if (room.players.size === 0) rooms.delete(code);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === "playing") updateRoom(room);
  }
}, Math.round(1000 / TICK_RATE));
