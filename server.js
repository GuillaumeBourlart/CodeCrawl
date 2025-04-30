import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import cors from "cors";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient as createRedisClient } from "redis";

import dotenv from "dotenv";
dotenv.config();

const {
  SUPABASE_URL = "",
  SUPABASE_SERVICE_KEY = "",
  PORT = 3000,
  REDIS_URL = ""
} = process.env;

// Supabase & Redis
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const pubClient = createRedisClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();
await pubClient.connect();
await subClient.connect();

// Express & Socket.IO
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
io.adapter(createAdapter(pubClient, subClient));

// In-memory state cache
const rooms = new Map();  // roomId => { players, items }
// map socket.id → roomId pour retrouver la room quand le client ne l'envoie pas
const socketRooms = new Map();

const boostIntervals = new Map(); // socketId => interval handle
const scoreBuffer = {};

// Constants
const ROOM_PREFIX = "room:";
const EXPIRATION = 60 * 60;
const SCAN_COUNT = 100;
const TICK_RATE = 1000 / 60;
const CHECKPOINT_INTERVAL = 60 * 1000;

// World config
const worldSize = { width: 4000, height: 4000 };
const BOUNDARY_MARGIN = 100;
const VIEW_WIDTH = 1920;
const VIEW_HEIGHT = 1080;

const ITEMS_PER_SEGMENT   = 4;
const INITIAL_SEGMENTS    = 10;
const DEFAULT_ITEM_COUNT  = ITEMS_PER_SEGMENT * INITIAL_SEGMENTS;

const MIN_ITEM_RADIUS     = 4;
const MAX_ITEM_RADIUS     = 10;
const BASE_SIZE           = 20;
const HEAD_GROWTH         = 0.02;

const MAX_ITEMS           = 600;
const SPEED_NORMAL        = 3.2;
const SPEED_BOOST         = 6.4;
const BOOST_ITEM_COST     = 4;
const BOOST_INTERVAL_MS   = 250;
const MAX_HISTORY_LENGTH  = 1000;

// Utils & caches
const skinCache = {};
const itemColors = ["#FF5733","#33FF57","#3357FF","#FF33A8","#33FFF5","#FFD133","#8B5CF6"];

/** Clamp a position inside the world boundaries */
function clampPosition(x, y, margin = BOUNDARY_MARGIN) {
  return {
    x: Math.min(Math.max(x, margin), worldSize.width - margin),
    y: Math.min(Math.max(y, margin), worldSize.height - margin)
  };
}

/** Spatial hashing cell key */
function getCell(x, y, size = 400) {
  return `${Math.floor(x/size)}_${Math.floor(y/size)}`;
}

function distance(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }
function randomRadius() { 
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}
function getItemValue(r) {
  return Math.round(1 + ((r - MIN_ITEM_RADIUS) / (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS)) * 5);
}
function getHeadRadius(p) {
  return BASE_SIZE/2 + Math.max(0, p.itemEatenCount - DEFAULT_ITEM_COUNT) * HEAD_GROWTH;
}
function getSegmentRadius(p) { return getHeadRadius(p); }

/** Default 20-color skin */
function getDefaultSkinColors() {
  return [
    "#FF5733", "#33FF57", "#3357FF", "#FF33A8", "#33FFF5",
    "#FFD133", "#8B5CF6", "#FF0000", "#00FF00", "#0000FF",
    "#FFFF00", "#FF00FF", "#00FFFF", "#AAAAAA", "#BBBBBB",
    "#CCCCCC", "#DDDDDD", "#EEEEEE", "#999999", "#333333"
  ];
}

/** Load skin data from Supabase or default */
async function getSkinDataFromDB(skin_id) {
  if (skinCache[skin_id]) return skinCache[skin_id];
  const { data, error } = await supabase
    .from("game_skins")
    .select("data")
    .eq("id", skin_id)
    .single();
  if (error || !data) {
    console.error("Erreur de récupération du skin :", error);
    return getDefaultSkinColors();
  }
  const skin = data.data;
  if (!skin?.colors || skin.colors.length !== 20) {
    console.warn("Skin invalide, fallback");
    return getDefaultSkinColors();
  }
  skinCache[skin_id] = skin.colors;
  return skin.colors;
}

/** find existing room or create a new one */
async function findOrCreateRoom() {
  let { data: existing, error } = await supabase
    .from("rooms")
    .select("*")
    .lt("current_players", 25)
    .order("current_players", { ascending: true })
    .limit(1);
  if (error) { console.error("findOrCreateRoom error:", error); return null; }

  let room = existing?.[0] ?? null;
  if (!room) {
    const { data: newRoom, error: err2 } = await supabase
      .from("rooms")
      .insert([{ name: "New Room" }])
      .select()
      .single();
    if (err2) { console.error("create room error:", err2); return null; }
    room = newRoom;
  }
  await supabase
    .from("rooms")
    .update({ current_players: room.current_players + 1 })
    .eq("id", room.id);
  console.log(`Room ${room.id} now has ${room.current_players + 1} players`);
  return room;
}

/** decrement room player count or delete row */
async function leaveRoom(roomId) {
  if (!roomId) return;
  const { data, error } = await supabase
    .from("rooms")
    .select("current_players")
    .eq("id", roomId)
    .maybeSingle();
  if (error || !data) return;
  const newCount = Math.max(0, data.current_players - 1);
  if (newCount === 0) {
    await supabase.from("rooms").delete().eq("id", roomId);
  } else {
    await supabase
      .from("rooms")
      .update({ current_players: newCount })
      .eq("id", roomId);
  }
}

/** delete all user data */
async function deleteUserAccount(userId) {
  try {
    let { error: e1 } = await supabase.from("user_skins").delete().eq("user_id", userId);
    if (e1) throw e1;
    let { error: e2 } = await supabase.from("profiles").delete().eq("id", userId);
    if (e2) throw e2;
    console.log(`Deleted user ${userId}`);
    return { success: true };
  } catch (err) {
    console.error("deleteUserAccount error:", err);
    return { success: false, error: err };
  }
}

/** generate N random items in the world */
function generateRandomItems(count, worldSize) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = randomRadius(), value = getItemValue(r);
    items.push({
      id: `item-${i}-${Date.now()}`,
      x: BOUNDARY_MARGIN + Math.random() * (worldSize.width - 2*BOUNDARY_MARGIN),
      y: BOUNDARY_MARGIN + Math.random() * (worldSize.height - 2*BOUNDARY_MARGIN),
      value, color: itemColors[Math.floor(Math.random()*itemColors.length)], radius: r
    });
  }
  return items;
}

// Redis scan/load/save rooms
async function loadAllRooms() {
  const roomsData = [];
  const keys = [];
  for await (const key of pubClient.scanIterator({ MATCH: `${ROOM_PREFIX}*`, COUNT: SCAN_COUNT })) {
    keys.push(key);
  }
  if (!keys.length) return roomsData;
  const pipeline = pubClient.multi();
  keys.forEach(k => pipeline.get(k));
  const raws = await pipeline.exec();
  for (let i = 0; i < keys.length; i++) {
    const roomId = keys[i].slice(ROOM_PREFIX.length);
    const raw = raws[i];
    if (!raw) continue;
    roomsData.push({ roomId, state: JSON.parse(raw) });
  }
  return roomsData;
}

async function saveAllRooms(roomsData) {
  const pipeline = pubClient.multi();
  roomsData.forEach(({ roomId, state }) => {
    pipeline.set(ROOM_PREFIX + roomId, JSON.stringify(state), { EX: EXPIRATION });
  });
  await pipeline.exec();
}

/** drop the remaining queue segments as items */
function dropQueueItems(player, roomId) {
  const state = rooms.get(roomId);
  if (!state) return;
  for (let i = 0; i < player.queue.length; i += 3) {
    const seg = player.queue[i];
    const r = randomRadius(), value = getItemValue(r);
    state.items.push({
      id: `dropped-${Date.now()}-${Math.random()}`,
      x: seg.x, y: seg.y,
      radius: r, value,
      color: seg.color,
      dropTime: Date.now()
    });
  }
}

/** Rebuild snake tail for a player */
function updateTail(player) {
  const colors = (player.skinColors?.length>=20) ? player.skinColors : getDefaultSkinColors();
  const spacing = getHeadRadius(player) * 0.3;
  const targetCount = Math.max(INITIAL_SEGMENTS, Math.floor(player.itemEatenCount / ITEMS_PER_SEGMENT));
  const newQueue = [];
  let prev = { x: player.x, y: player.y };
  for (let i = 0; i < targetCount; i++) {
    const old = player.queue[i] || prev;
    const dx = prev.x - old.x, dy = prev.y - old.y;
    const dist = Math.hypot(dx, dy) || spacing;
    const ux = dx / dist, uy = dy / dist;
    const sx = prev.x - ux * spacing, sy = prev.y - uy * spacing;
    newQueue.push({ x: sx, y: sy, color: colors[i % 20] });
    prev = { x: sx, y: sy };
  }
  player.queue = newQueue;
}

/** Main game tick for one room */
function tickRoom(roomId, state) {
  // 1) spatial hash players
  const grid = {};
  for (const [pid, p] of Object.entries(state.players)) {
    if (p.isSpectator) continue;
    const cell = getCell(p.x, p.y);
    (grid[cell] = grid[cell]||[]).push({ id: pid, player: p });
  }
  // 2) detect collisions head↔head and head↔queue
  const dirs = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
  const toElim = new Set();
  for (const cellKey of Object.keys(grid)) {
    const [cx, cy] = cellKey.split("_").map(Number);
    let nearby = [];
    for (const [dx, dy] of dirs) {
      const c2 = `${cx+dx}_${cy+dy}`;
      if (grid[c2]) nearby.push(...grid[c2]);
    }
    for (let i = 0; i < nearby.length; i++) {
      for (let j = i+1; j < nearby.length; j++) {
        const a = nearby[i], b = nearby[j];
        const h1 = { x: a.player.x, y: a.player.y, radius: getHeadRadius(a.player) };
        const h2 = { x: b.player.x, y: b.player.y, radius: getHeadRadius(b.player) };
        if (distance(h1, h2) < h1.radius + h2.radius) {
          toElim.add(a.id);
          toElim.add(b.id);
          continue;
        }
        // head-a vs queue-b
        for (const seg of b.player.queue) {
          if (distance(h1, { x: seg.x, y: seg.y }) < h1.radius + getSegmentRadius(b.player)) {
            toElim.add(a.id);
            break;
          }
        }
        // head-b vs queue-a
        for (const seg of a.player.queue) {
          if (distance(h2, { x: seg.x, y: seg.y }) < h2.radius + getSegmentRadius(a.player)) {
            toElim.add(b.id);
            break;
          }
        }
      }
    }
  }
  // 3) eliminate marked players
  toElim.forEach(id => {
    const p = state.players[id];
    if (!p || p.isSpectator) return;
    io.to(id).emit("player_eliminated", { eliminatedBy:"collision" });
    // drop items
    for (let i = 0; i < p.queue.length; i+=3) {
      const seg = p.queue[i];
      const r = randomRadius(), val = getItemValue(r);
      state.items.push({ id:`d-${Date.now()}`, x:seg.x, y:seg.y, value: val, color: seg.color, radius: r, dropTime: Date.now() });
    }
    scoreBuffer[id] = { pseudo: p.pseudo||"Anonyme", score: p.itemEatenCount };
    p.isSpectator = true;
    p.queue = [];
    p.positionHistory = [];
  });

  // 4) movement + item collisions + tail rebuild + boundary
  for (const p of Object.values(state.players)) {
    if (p.isSpectator || !p.direction) continue;
    p.positionHistory.push({ x: p.x, y: p.y });
    if (p.positionHistory.length > MAX_HISTORY_LENGTH) p.positionHistory.shift();

    // move head
    const speed = p.boosting ? SPEED_BOOST : SPEED_NORMAL;
    p.x += p.direction.x * speed;
    p.y += p.direction.y * speed;
    p.positionHistory.push({ x: p.x, y: p.y });
    if (p.positionHistory.length > MAX_HISTORY_LENGTH) p.positionHistory.shift();

    // rebuild tail
    updateTail(p);

    // boundary kill
    const hr = getHeadRadius(p);
    if (p.x<hr || p.x>worldSize.width-hr || p.y<hr || p.y>worldSize.height-hr) {
      io.to(p.id).emit("player_eliminated", { eliminatedBy:"boundary" });
      dropQueueItems(p, roomId);
      scoreBuffer[p.id] = { pseudo:p.pseudo||"Anonyme", score:p.itemEatenCount };
      p.isSpectator = true;
      p.queue = [];
      p.positionHistory = [];
      continue;
    }

    // item collisions
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      if (item.owner===p.id && Date.now() - item.dropTime < 500) continue;
      if (distance({ x:p.x, y:p.y }, { x:item.x, y:item.y }) < hr + item.radius) {
        p.itemEatenCount += item.value;
        state.items.splice(i--, 1);
        // respawn one
        const r = randomRadius(), val = getItemValue(r);
        state.items.push({
          id: `i-${Date.now()}`,
          x: BOUNDARY_MARGIN + Math.random()*(worldSize.width-2*BOUNDARY_MARGIN),
          y: BOUNDARY_MARGIN + Math.random()*(worldSize.height-2*BOUNDARY_MARGIN),
          value: val,
          color: itemColors[Math.floor(Math.random()*itemColors.length)],
          radius: r
        });
        break;
      }
    }
  }

  // 5) broadcast updates
  const top10 = Object.entries(state.players)
    .sort(([,a],[,b])=>b.itemEatenCount - a.itemEatenCount)
    .slice(0,10)
    .map(([id,p])=>({ id, pseudo: p.pseudo||"Anonyme", score: p.itemEatenCount, color: p.color }));
  for (const [id, p] of Object.entries(state.players)) {
    const halfW = VIEW_WIDTH/2, halfH = VIEW_HEIGHT/2;
    const minX = p.x-halfW, maxX = p.x+halfW, minY = p.y-halfH, maxY = p.y+halfH;
    const visItems = state.items.filter(it => it.x>=minX && it.x<=maxX && it.y>=minY && it.y<=maxY);
    const visPlayers = {};
    for (const [pid, op] of Object.entries(state.players)) {
      if (op.isSpectator) continue;
      const headVis = op.x>=minX && op.x<=maxX && op.y>=minY && op.y<=maxY;
      const qSegs = op.queue.filter(s=>s.x>=minX&&s.x<=maxX&&s.y>=minY&&s.y<=maxY);
      if (headVis || qSegs.length) {
        visPlayers[pid] = {
          x: op.x, y: op.y,
          pseudo: op.pseudo, color: op.color,
          itemEatenCount: op.itemEatenCount,
          boosting: op.boosting, direction: op.direction,
          skin_id: op.skin_id, headVisible: headVis,
          queue: qSegs
        };
      }
    }
    io.to(id).emit("update_entities", {
      players: visPlayers,
      items: visItems,
      leaderboard: top10,
      serverTs: Date.now()
    });
  }
}

// periodic save to Redis
setInterval(async () => {
  const all = Array.from(rooms.entries()).map(([roomId, state])=>({ roomId, state }));
  await saveAllRooms(all);
}, CHECKPOINT_INTERVAL);

// main loop: load from Redis, tick each, save back
setInterval(async () => {
  const allRooms = await loadAllRooms();
  rooms.clear();
  allRooms.forEach(r=>rooms.set(r.roomId, r.state));
  for (const [rid, st] of rooms.entries()) {
    tickRoom(rid, st);
  }
  await saveAllRooms(Array.from(rooms.entries()).map(([roomId,state])=>({ roomId, state })));
}, TICK_RATE);

// Express routes & Socket.IO handlers

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/", (req, res) => res.send("Hello from optimized Snake.io server!"));

app.get("/globalLeaderboard", async (req, res) => {
  const { data, error } = await supabase
    .from("global_leaderboard")
    .select("*")
    .order("score", { ascending: false })
    .limit(10);
  if (error) return res.status(500).send(error);
  res.json(data);
});

// Profile update
app.put("/updateProfile", async (req, res) => {
  const { userId, pseudo, skin_id } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: "userId requis" });
  if (pseudo===undefined && skin_id===undefined) {
    return res.status(400).json({ success: false, message: "pseudo ou skin_id requis" });
  }
  const updates = {};
  if (pseudo!==undefined) updates.pseudo = pseudo;
  if (skin_id!==undefined) updates.default_skin_id = skin_id;
  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId);
  if (error) return res.status(500).json({ success: false, error });
  res.json({ success: true, data });
});

// Delete account
app.delete("/deleteAccount", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: "userId manquant" });
  const result = await deleteUserAccount(userId);
  if (result.success) return res.json({ success: true });
  res.status(500).json({ success: false, error: result.error });
});

io.on("connection", socket => {
  console.log("client connected", socket.id);
  socket.on("ping_test", (_d, ack) => ack());

   socket.on("disconnect", async () => {
    const roomId = socketRooms.get(socket.id);
    if (roomId) {
      const state = rooms.get(roomId);
      const p = state?.players[socket.id];
      if (p) {
        const h = boostIntervals.get(socket.id);
        if (h) { clearInterval(h); boostIntervals.delete(socket.id); }
        dropQueueItems(p, roomId);
        scoreBuffer[socket.id] = { pseudo: p.pseudo||"Anonyme", score: p.itemEatenCount };
       delete state.players[socket.id];
        await leaveRoom(roomId);
      }
    }
    socketRooms.delete(socket.id);
  });

  socket.on("join_room", async () => {
    try {
      const roomDb = await findOrCreateRoom();
      if (!roomDb) {
        socket.emit("no_room_available");
        return;
      }
      const roomId = roomDb.id;
      let state = rooms.get(roomId);
      if (!state) {
        const data = await pubClient.get(ROOM_PREFIX + roomId);
        state = data
          ? JSON.parse(data)
          : { players: {}, items: generateRandomItems(MAX_ITEMS, worldSize) };
        rooms.set(roomId, state);
      }
      // add player stub
      state.players[socket.id] = {
        x: Math.random()*800,
        y: Math.random()*600,
        queue: Array(INITIAL_SEGMENTS).fill({ x:0, y:0 }),
        positionHistory: [],
        direction: { x:0, y:0 },
        boosting: false,
        isSpectator: false,
        pseudo: null,
        skin_id: null,
        itemEatenCount: DEFAULT_ITEM_COUNT
      };
      socket.join(roomId);
       socketRooms.set(socket.id, roomId);
      socket.emit("joined_room", { roomId });
      console.log(`→ ${socket.id} joined room ${roomId}`);
    } catch (err) {
      console.error("join_room error:", err);
      socket.emit("no_room_available");
    }
  });

  socket.on("setPlayerInfo", async data => {
    // on récupère la roomId envoyée ou en fallback depuis socketRooms
    const roomId = data?.roomId ?? socketRooms.get(socket.id);
    if (!roomId) return;
   const state = rooms.get(roomId);
   if (!state || !state.players[socket.id]) return;
   const p = state.players[socket.id];
    p.pseudo = data.pseudo;
    p.skin_id = data.skin_id;
    p.skinColors = await getSkinDataFromDB(data.skin_id);
    p.color = p.skinColors[0];
  });

  

   socket.on("changeDirection", data => {
    const roomId = data?.roomId ?? socketRooms.get(socket.id);
    if (!roomId) return;
    const state = rooms.get(roomId);
   const p = state?.players[socket.id];
    if (!p) return;
    let { x, y } = data.direction;
    const mag = Math.hypot(x, y) || 1; x /= mag; y /= mag;
    const cd = p.direction;
    const dot = cd.x*x + cd.y*y;
    const ang = Math.acos(Math.min(Math.max(dot, -1), 1));
    const maxA = Math.PI / 9;
    if (ang > maxA) {
      const cross = cd.x*y - cd.y*x;
      const sgn = cross >= 0 ? 1 : -1;
      x = cd.x*Math.cos(sgn*maxA) - cd.y*Math.sin(sgn*maxA);
      y = cd.x*Math.sin(sgn*maxA) + cd.y*Math.cos(sgn*maxA);
    }
    p.direction = { x, y };
  });

 socket.on("boostStart", data => {
   const roomId = data?.roomId ?? socketRooms.get(socket.id);
  if (!roomId) return;
  const state = rooms.get(roomId);
   const p = state?.players[socket.id];
    if (!p || p.queue.length <= 6 || p.boosting) return;
    const seg = p.queue.pop();
    const r = randomRadius(), val = getItemValue(r);
    state.items.push({
      id: `d-${Date.now()}`, x: seg.x, y: seg.y,
      value: val, color: seg.color, radius: r,
      dropTime: Date.now(), owner: socket.id
    });
    if (p.itemEatenCount > DEFAULT_ITEM_COUNT) {
      p.itemEatenCount = Math.max(DEFAULT_ITEM_COUNT, p.itemEatenCount - BOOST_ITEM_COST);
    }
    p.boosting = true;
    const handle = setInterval(() => {/* nothing here */}, BOOST_INTERVAL_MS);
    boostIntervals.set(socket.id, handle);
  });


  socket.on("boostStop", data => {
    const h = boostIntervals.get(socket.id);
    if (!h) return;
    clearInterval(h);
    boostIntervals.delete(socket.id);
    const roomId = data?.roomId ?? socketRooms.get(socket.id);
    if (!roomId) return;
    const state = rooms.get(roomId);
    const p = state?.players[socket.id];
    if (p) p.boosting = false;
  });

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
