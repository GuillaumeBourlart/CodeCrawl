import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import cors from "cors";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient as createRedisClient } from "redis";

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
const ITEMS_PER_SEGMENT = 4;
const INITIAL_SEGMENTS = 10;
const DEFAULT_ITEM_COUNT = ITEMS_PER_SEGMENT * INITIAL_SEGMENTS;
const BASE_SIZE = 20;
const HEAD_GROWTH = 0.02;

const itemColors = ["#FF5733","#33FF57","#3357FF","#FF33A8","#33FFF5","#FFD133","#8B5CF6"];

// Utilitaires**
function clampPosition(x, y, margin = BOUNDARY_MARGIN) {
  return { x: Math.min(Math.max(x, margin), worldSize.width - margin),
           y: Math.min(Math.max(y, margin), worldSize.height - margin) };
}
function getCell(x, y, size = 400) {
  return `${Math.floor(x/size)}_${Math.floor(y/size)}`;
}
function distance(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }
function getHeadRadius(p) {
  return BASE_SIZE/2 + Math.max(0,p.itemEatenCount-DEFAULT_ITEM_COUNT)*HEAD_GROWTH;
}
function getSegmentRadius(p) { return getHeadRadius(p); }
function getItemValue(r) {
  return Math.round(1 + ((r-4)/(10-4))*5);
}
function randomRadius() { return Math.floor(Math.random()*(10-4+1))+4; }

// Load all rooms from Redis via SCAN + MGET pipeline
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
  for (let i=0;i<keys.length;i++) {
    const roomId = keys[i].slice(ROOM_PREFIX.length);
    const raw = raws[i];
    if (!raw) continue;
    roomsData.push({ roomId, state: JSON.parse(raw) });
  }
  return roomsData;
}

// Save all rooms back to Redis in one pipeline
async function saveAllRooms(roomsData) {
  const pipeline = pubClient.multi();
  roomsData.forEach(({ roomId, state }) => {
    pipeline.set(
      ROOM_PREFIX+roomId,
      JSON.stringify(state),
      { EX: EXPIRATION }
    );
  });
  await pipeline.exec();
}

// Game loop per room
function tickRoom(roomId, state) {
  // Spatial hashing: build map of cells
  const grid = {};
  Object.entries(state.players).forEach(([pid,p]) => {
    if (p.isSpectator) return;
    const cell = getCell(p.x,p.y);
    grid[cell] = grid[cell]||[];
    grid[cell].push({ id: pid, player: p });
  });
  const dirs = [ [0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1] ];
  const toElim = new Set();
  // Collisions
  Object.keys(grid).forEach(cellKey => {
    const [cx,cy] = cellKey.split('_').map(Number);
    let nearby = [];
    dirs.forEach(([dx,dy])=>{
      const c2 = `${cx+dx}_${cy+dy}`;
      if (grid[c2]) nearby.push(...grid[c2]);
    });
    for (let i=0;i<nearby.length;i++){
      for (let j=i+1;j<nearby.length;j++){
        const a = nearby[i], b = nearby[j];
        const h1 = { x:a.player.x, y:a.player.y, radius:getHeadRadius(a.player)};
        const h2 = { x:b.player.x, y:b.player.y, radius:getHeadRadius(b.player)};
        if (distance(h1,h2)<h1.radius+h2.radius) { toElim.add(a.id); toElim.add(b.id); continue; }
        // head vs queue
        for (const seg of b.player.queue) if(distance(h1,{x:seg.x,y:seg.y})<h1.radius+getSegmentRadius(b.player)){ toElim.add(a.id); break; }
        for (const seg of a.player.queue) if(distance(h2,{x:seg.x,y:seg.y})<h2.radius+getSegmentRadius(a.player)){ toElim.add(b.id); break; }
      }
    }
  });
  // Eliminate
  toElim.forEach(id=>{
    const p = state.players[id];
    if (!p||p.isSpectator) return;
    io.to(id).emit("player_eliminated",{eliminatedBy:"collision"});
    // drop queue items
    for (let i=0;i<p.queue.length;i+=3){
      const s = p.queue[i];
      const r = randomRadius();
      state.items.push({ id:`d-${Date.now()}-${Math.random()}`, x:s.x, y:s.y, value:getItemValue(r), color:s.color, radius:r, dropTime:Date.now() });
    }
    scoreBuffer[id] = { pseudo:p.pseudo||"Anonyme", score:p.itemEatenCount };
    p.isSpectator=true; p.queue=[]; p.positionHistory=[];
  });
  // Movement & collisions with items
  Object.values(state.players).forEach(p=>{
    if(p.isSpectator||!p.direction) return;
    // history
    p.positionHistory.push({x:p.x,y:p.y}); if(p.positionHistory.length>1000) p.positionHistory.shift();
    // move
    const speed = p.boosting?6.4:3.2;
    const nx=p.x+p.direction.x*speed, ny=p.y+p.direction.y*speed;
    p.x=nx; p.y=ny; p.positionHistory.push({x:nx,y:ny}); if(p.positionHistory.length>1000) p.positionHistory.shift();
    // tail
    const colors = p.skinColors&&p.skinColors.length>=20?p.skinColors:getDefaultSkinColors();
    const spacing = getHeadRadius(p)*0.3;
    const segCount = Math.max(INITIAL_SEGMENTS,Math.floor(p.itemEatenCount/ITEMS_PER_SEGMENT));
    const newQ=[]; let prev={x:p.x,y:p.y};
    for(let i=0;i<segCount;i++){
      const old = p.queue[i]||prev;
      const dx=prev.x-old.x, dy=prev.y-old.y;
      const d=Math.hypot(dx,dy)||spacing;
      const ux=dx/d, uy=dy/d;
      const sx=prev.x-ux*spacing, sy=prev.y-uy*spacing;
      newQ.push({x:sx,y:sy,color:colors[i%20]}); prev={x:sx,y:sy};
    }
    p.queue=newQ;
    // boundary
    const hr = getHeadRadius(p);
    if(p.x<hr||p.x>worldSize.width-hr||p.y<hr||p.y>worldSize.height-hr){
      io.to(p.id).emit("player_eliminated",{eliminatedBy:"boundary"});
      for(let s of p.queue){state.items.push({ id:`d-${Date.now()}`, x:s.x, y:s.y, value:getItemValue(randomRadius()), color:s.color, radius:randomRadius(), dropTime:Date.now() });}
      scoreBuffer[p.id]={pseudo:p.pseudo||"Anonyme",score:p.itemEatenCount};
      p.isSpectator=true; p.queue=[]; p.positionHistory=[];
      return;
    }
    // item collisions
    for(let i=0;i<state.items.length;i++){
      const it=state.items[i];
      if(it.owner===p.id&&Date.now()-it.dropTime<500) continue;
      if(distance({x:p.x,y:p.y},{x:it.x,y:it.y})<getHeadRadius(p)+it.radius){
        p.itemEatenCount+=it.value;
        state.items.splice(i--,1);
        // respawn
        const r=randomRadius(), val=getItemValue(r);
        const newIt={id:`i-${Date.now()}`,x:BOUNDARY_MARGIN+Math.random()*(worldSize.width-2*BOUNDARY_MARGIN),y:BOUNDARY_MARGIN+Math.random()*(worldSize.height-2*BOUNDARY_MARGIN),value:val,color:itemColors[Math.floor(Math.random()*itemColors.length)],radius:r};
        state.items.push(newIt);
        break;
      }
    }
  });
  // emit updates
  const top10 = Object.entries(state.players).sort(([,a],[,b])=>b.itemEatenCount-a.itemEatenCount).slice(0,10).map(([id,p])=>({ id, pseudo:p.pseudo||"Anonyme", score:p.itemEatenCount, color:p.color }));
  Object.entries(state.players).forEach(([id,p])=>{
    const halfW = VIEW_WIDTH/2, halfH=VIEW_HEIGHT/2;
    const minX=p.x-halfW, maxX=p.x+halfW, minY=p.y-halfH, maxY=p.y+halfH;
    const visItems = state.items.filter(it=>it.x>=minX&&it.x<=maxX&&it.y>=minY&&it.y<=maxY);
    const visPlayers={};
    Object.entries(state.players).forEach(([pid,op])=>{
      if(op.isSpectator) return;
      const headVis=op.x>=minX&&op.x<=maxX&&op.y>=minY&&op.y<=maxY;
      const qSegs=op.queue.filter(s=>s.x>=minX&&s.x<=maxX&&s.y>=minY&&s.y<=maxY);
      if(headVis||qSegs.length) visPlayers[pid]={ x:op.x,y:op.y,pseudo:op.pseudo,color:op.color,itemEatenCount:op.itemEatenCount,boosting:op.boosting,direction:op.direction,skin_id:op.skin_id,headVisible:headVis,queue:qSegs };
    });
    io.to(id).emit("update_entities",{ players:visPlayers, items:visItems, leaderboard:top10, serverTs:Date.now() });
  });
}

// Periodic checkpoint
setInterval(async()=>{
  const all = Array.from(rooms.entries()).map(([roomId,state])=>({ roomId, state }));
  await saveAllRooms(all);
}, CHECKPOINT_INTERVAL);

// Main game loop
setInterval(async()=>{
  const allRooms = await loadAllRooms();
  rooms.clear();
  allRooms.forEach(r=>rooms.set(r.roomId,r.state));
  rooms.forEach((state, roomId)=>tickRoom(roomId, state));
  // batch save after tick
  await saveAllRooms(Array.from(rooms.entries()).map(([roomId,state])=>({ roomId, state })));
}, TICK_RATE);

// HTTP & Sock events unchanged
app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/",(req,res)=>res.send("Hello from optimized Snake.io server!"));
app.get("/globalLeaderboard", async(req,res)=>{
  const { data, error } = await supabase.from("global_leaderboard").select("*").order("score",{ascending:false}).limit(10);
  if(error) return res.status(500).send(error);
  res.json(data);
});

io.on("connection",socket=>{
  console.log("client connected",socket.id);
  socket.on("ping_test",(_,ack)=>ack());

  socket.on("setPlayerInfo", async data=>{
    const roomId = data.roomId;
    const state = rooms.get(roomId);
    if(!state||!state.players[socket.id]) return;
    const p = state.players[socket.id];
    p.pseudo=data.pseudo; p.skin_id=data.skin_id;
    p.skinColors = await getSkinDataFromDB(data.skin_id);
    p.color=p.skinColors[0];
  });

  socket.on("changeDirection", async data=>{
    const roomId=data.roomId;
    const p = rooms.get(roomId)?.players[socket.id];
    if(!p) return;
    let {x,y}=data.direction; const mag=Math.hypot(x,y)||1; x/=mag; y/=mag;
    const cd=p.direction; const dot=cd.x*x+cd.y*y; const ang= Math.acos(Math.min(Math.max(dot,-1),1));
    const maxA=Math.PI/9; if(ang>maxA){const c=cd.x*y-cd.y*x; const sgn=c>=0?1:-1; x=cd.x*Math.cos(sgn*maxA)-cd.y*Math.sin(sgn*maxA); y=cd.x*Math.sin(sgn*maxA)+cd.y*Math.cos(sgn*maxA);}    
    p.direction={x,y};
  });

  socket.on("boostStart", data=>{
    const roomId=data.roomId;
    const p=rooms.get(roomId)?.players[socket.id]; if(!p||p.queue.length<=6||p.boosting) return;
    const seg=p.queue.pop(); const r=randomRadius();
    rooms.get(roomId).items.push({ id:`d-${Date.now()}`, x:seg.x, y:seg.y, value:getItemValue(r), color:seg.color, radius:r, dropTime:Date.now(), owner:socket.id });
    if(p.itemEatenCount>DEFAULT_ITEM_COUNT) p.itemEatenCount=Math.max(DEFAULT_ITEM_COUNT,p.itemEatenCount-4);
    p.boosting=true;
    const handle=setInterval(()=>{/* handled in main loop */},250);
    boostIntervals.set(socket.id,handle);
  });
  socket.on("boostStop", data=>{
    const handle=boostIntervals.get(socket.id); if(handle){ clearInterval(handle); boostIntervals.delete(socket.id); const p=rooms.get(data.roomId)?.players[socket.id]; if(p) p.boosting=false; }
  });

  socket.on("disconnect",()=>{
    const roomEntry = Array.from(rooms.entries()).find(([_,s])=>!!s.players[socket.id]);
    if(roomEntry){ const [rid,state]=roomEntry; const p=state.players[socket.id];
      const h=boostIntervals.get(socket.id); if(h){clearInterval(h); boostIntervals.delete(socket.id);}      
      for(let i=0;i<p.queue.length;i+=3){const s=p.queue[i]; const r=randomRadius(); state.items.push({ id:`d-${Date.now()}`,x:s.x,y:s.y,value:getItemValue(r),color:s.color,radius:r,dropTime:Date.now() }); }
      scoreBuffer[socket.id]={pseudo:p.pseudo||"Anonyme",score:p.itemEatenCount};
      delete state.players[socket.id];
    }
  });
});

httpServer.listen(PORT,()=>console.log(`Server listening on ${PORT}`));
