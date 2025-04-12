import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";

const { SUPABASE_URL = "", SUPABASE_ANON_KEY = "", PORT = 3000 } = process.env;
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_ANON_KEY:", SUPABASE_ANON_KEY ? "<non-empty>" : "<EMPTY>");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
app.use(cors({ origin: "*" }));

// --- Configuration ---
const itemColors = [
  "#FF5733",
  "#33FF57",
  "#3357FF",
  "#FF33A8",
  "#33FFF5",
  "#FFD133",
  "#8B5CF6",
];
const worldSize = { width: 4000, height: 4000 };

const MIN_ITEM_RADIUS = 4;
const MAX_ITEM_RADIUS = 10;
const BASE_SIZE = 20; // Taille de base d'un cercle
const MAX_ITEMS = 600;
const SPEED_NORMAL = 3.2;
const SPEED_BOOST = 6.4;
const BOUNDARY_MARGIN = 100;

const DEFAULT_ITEM_EATEN_COUNT = 18; // 18 => 6 segments par défaut
const BOOST_ITEM_COST = 3;
const BOOST_INTERVAL_MS = 250;

// On suppose ~16ms/tick => 60 FPS
// Seuil pour détecter un grand saut de la tête (exemple ici : si la distance dépasse 1×SPEED_NORMAL)
const BOOST_DISTANCE_FACTOR = 1;

// Pour le rééchantillonnage complet de la trajectoire (distance désirée entre deux points uniformisés, en pixels)
const SAMPLING_STEP = 2;

// -- Constantes pour filtrer la zone visible --
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 720;

// --- Fonction de clamp ---
function clampPosition(x, y, margin = BOUNDARY_MARGIN) {
  return {
    x: Math.min(Math.max(x, margin), worldSize.width - margin),
    y: Math.min(Math.max(y, margin), worldSize.height - margin)
  };
}

// --- Récupération du skin depuis la DB ---
async function getSkinDataFromDB(skin_id) {
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
  if (!skin || !skin.colors || skin.colors.length !== 20) {
    console.warn("Le skin récupéré ne contient pas 20 couleurs. Utilisation du skin par défaut.");
    return getDefaultSkinColors();
  }
  return skin.colors;
}

function getDefaultSkinColors() {
  return [
    "#FF5733", "#33FF57", "#3357FF", "#FF33A8", "#33FFF5",
    "#FFD133", "#8B5CF6", "#FF0000", "#00FF00", "#0000FF",
    "#FFFF00", "#FF00FF", "#00FFFF", "#AAAAAA", "#BBBBBB",
    "#CCCCCC", "#DDDDDD", "#EEEEEE", "#999999", "#333333"
  ];
}

function getItemValue(radius) {
  return Math.round(
    1 + ((radius - MIN_ITEM_RADIUS) / (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS)) * 5
  );
}

function randomItemRadius() {
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}

function getHeadRadius(player) {
  return BASE_SIZE / 2 + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT) * 0.05;
}
function getSegmentRadius(player) {
  return BASE_SIZE / 2 + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT) * 0.05;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Fonction de rééchantillonnage complet de la trajectoire
function resamplePath(positionHistory, step) {
  if (positionHistory.length === 0) return [];
  const resampled = [];
  let prev = positionHistory[0];
  resampled.push({ x: prev.x, y: prev.y });
  for (let i = 1; i < positionHistory.length; i++) {
    const curr = positionHistory[i];
    let d = distance(prev, curr);
    while (d >= step) {
      const ratio = step / d;
      const newX = prev.x + ratio * (curr.x - prev.x);
      const newY = prev.y + ratio * (curr.y - prev.y);
      resampled.push({ x: newX, y: newY });
      // Considère ce nouveau point comme point de départ pour le segment suivant
      prev = { x: newX, y: newY };
      d = distance(prev, curr);
    }
    // Passe au segment suivant
    prev = curr;
  }
  return resampled;
}

function getPositionAtDistance(positionHistory, targetDistance) {
  let totalDistance = 0;
  for (let i = positionHistory.length - 1; i > 0; i--) {
    const curr = positionHistory[i];
    const prev = positionHistory[i - 1];
    const segmentDistance = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    totalDistance += segmentDistance;
    if (totalDistance >= targetDistance) {
      const overshoot = totalDistance - targetDistance;
      const fraction = overshoot / segmentDistance;
      return {
        x: curr.x * (1 - fraction) + prev.x * fraction,
        y: curr.y * (1 - fraction) + prev.y * fraction
      };
    }
  }
  return { x: positionHistory[0].x, y: positionHistory[0].y };
}

function circlesCollide(circ1, circ2) {
  return Math.hypot(circ1.x - circ2.x, circ1.y - circ2.y) < (circ1.radius + circ2.radius);
}

// --- Gestion des items (drops / génération) ---
function dropQueueItems(player, roomId) {
  player.queue.forEach((segment, index) => {
    if (index % 3 === 0) {
      const r = randomItemRadius();
      const value = getItemValue(r);
      const pos = clampPosition(segment.x, segment.y);
      const droppedItem = {
        id: `dropped-${Date.now()}-${Math.random()}`,
        x: pos.x,
        y: pos.y,
        value: value,
        color: segment.color,
        radius: r,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
    }
  });
}

function generateRandomItems(count, worldSize) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = randomItemRadius();
    const value = getItemValue(r);
    items.push({
      id: `item-${i}-${Date.now()}`,
      x: BOUNDARY_MARGIN + Math.random() * (worldSize.width - 2 * BOUNDARY_MARGIN),
      y: BOUNDARY_MARGIN + Math.random() * (worldSize.height - 2 * BOUNDARY_MARGIN),
      value: value,
      color: itemColors[Math.floor(Math.random() * itemColors.length)],
      radius: r
    });
  }
  return items;
}

const roomsData = {};

async function updateGlobalLeaderboard(playerId, score, pseudo) {
  const { error } = await supabase
    .from("global_leaderboard")
    .upsert([{ id: playerId, pseudo, score }]);
  if (error) {
    console.error("Erreur lors de la mise à jour du leaderboard global:", error);
    return;
  }
  const { data: leaderboardData, error: selectError } = await supabase
    .from("global_leaderboard")
    .select("score")
    .order("score", { ascending: false })
    .limit(1000);
  if (selectError) {
    console.error("Erreur lors de la récupération du leaderboard pour le nettoyage:", selectError);
    return;
  }
  if (leaderboardData.length === 1000) {
    const threshold = leaderboardData[leaderboardData.length - 1].score;
    const { error: deleteError } = await supabase
      .from("global_leaderboard")
      .delete()
      .lt("score", threshold);
    if (deleteError) {
      console.error("Erreur lors du nettoyage du leaderboard global:", deleteError);
    }
  }
}

async function findOrCreateRoom() {
  let { data: existingRooms, error } = await supabase
    .from("rooms")
    .select("*")
    .lt("current_players", 25)
    .order("current_players", { ascending: true })
    .limit(1);
  if (error) {
    console.error("Erreur Supabase (findOrCreateRoom):", error);
    return null;
  }
  let room = (existingRooms && existingRooms.length > 0) ? existingRooms[0] : null;
  if (!room) {
    const { data: newRoomData, error: newRoomError } = await supabase
      .from("rooms")
      .insert([{ name: "New Room" }])
      .select()
      .single();
    if (newRoomError) {
      console.error("Erreur création room:", newRoomError);
      return null;
    }
    room = newRoomData;
  }
  console.log(`Room trouvée/créée: ${room.id} avec ${room.current_players} joueurs.`);
  await supabase
    .from("rooms")
    .update({ current_players: room.current_players + 1 })
    .eq("id", room.id);
  return room;
}

async function leaveRoom(roomId) {
  if (!roomId) return;
  const { data, error } = await supabase
    .from("rooms")
    .select("current_players")
    .eq("id", roomId)
    .single();
  if (!data || error) {
    console.error("Erreur lecture room (leaveRoom):", error);
    return;
  }
  const newCount = Math.max(0, data.current_players - 1);
  console.log(`Mise à jour du nombre de joueurs pour la room ${roomId}: ${newCount}`);
  await supabase
    .from("rooms")
    .update({ current_players: newCount })
    .eq("id", roomId);
}

// -- Fonctions utilitaires pour filtrer les entités visibles --
function getVisibleItemsForPlayer(player, allItems) {
  const halfW = VIEW_WIDTH / 2;
  const halfH = VIEW_HEIGHT / 2;
  const minX = player.x - halfW;
  const maxX = player.x + halfW;
  const minY = player.y - halfH;
  const maxY = player.y + halfH;

  return allItems.filter(item =>
    item.x >= minX && item.x <= maxX &&
    item.y >= minY && item.y <= maxY
  );
}

function getVisiblePlayersForPlayer(player, allPlayers) {
  const halfW = VIEW_WIDTH / 2;
  const halfH = VIEW_HEIGHT / 2;
  const minX = player.x - halfW;
  const maxX = player.x + halfW;
  const minY = player.y - halfH;
  const maxY = player.y + halfH;

  const result = {};
  Object.entries(allPlayers).forEach(([pid, otherPlayer]) => {
    if (otherPlayer.isSpectator) return;
    const headIsVisible =
      otherPlayer.x >= minX && otherPlayer.x <= maxX &&
      otherPlayer.y >= minY && otherPlayer.y <= maxY;
    const filteredQueue = otherPlayer.queue.filter(seg =>
      seg.x >= minX && seg.x <= maxX &&
      seg.y >= minY && seg.y <= maxY
    );
    if (headIsVisible || filteredQueue.length > 0) {
      result[pid] = {
        x: otherPlayer.x,
        y: otherPlayer.y,
        pseudo: otherPlayer.pseudo,
        color: otherPlayer.color,
        itemEatenCount: otherPlayer.itemEatenCount,
        boosting: otherPlayer.boosting,
        direction: otherPlayer.direction,
        skin_id: otherPlayer.skin_id,
        headVisible: headIsVisible,
        queue: filteredQueue,
      };
    }
  });
  return result;
}

// --------------------------------------------------------------

app.use(cors({ origin: "*" }));

io.on("connection", (socket) => {
  console.log("Nouveau client connecté:", socket.id);

  (async () => {
    const room = await findOrCreateRoom();
    if (!room) {
      console.error(`Aucune room disponible pour ${socket.id}`);
      socket.emit("no_room_available");
      socket.disconnect();
      return;
    }
    const roomId = room.id;
    console.log(`Le joueur ${socket.id} rejoint la room ${roomId}`);

    if (!roomsData[roomId]) {
      roomsData[roomId] = {
        players: {},
        items: generateRandomItems(MAX_ITEMS, worldSize)
      };
      console.log(`Initialisation de la room ${roomId} avec ${MAX_ITEMS} items.`);
    }

    // Direction aléatoire
    const defaultDirection = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    const mag = Math.sqrt(defaultDirection.x ** 2 + defaultDirection.y ** 2) || 1;
    defaultDirection.x /= mag;
    defaultDirection.y /= mag;

    // Initialisation du joueur
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      color: null,
      pseudo: null,
      isSpectator: false,
      skin_id: null,
      itemEatenCount: DEFAULT_ITEM_EATEN_COUNT,
      queue: Array(6).fill({ x: Math.random() * 800, y: Math.random() * 600 })
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);

    socket.join(roomId);
    socket.emit("joined_room", { roomId });

    // setPlayerInfo
    socket.on("setPlayerInfo", async (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (player && data.pseudo && data.skin_id) {
        player.pseudo = data.pseudo;
        player.skin_id = data.skin_id;
        const skinColors = await getSkinDataFromDB(player.skin_id);
        player.skinColors = skinColors;
        player.color = skinColors[0];
      }
      console.log(`Infos définies pour ${socket.id}:`, data);
    });

    // Changement de direction
    socket.on("changeDirection", (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag2 = Math.sqrt(x * x + y * y) || 1;
      let newDir = { x: x / mag2, y: y / mag2 };
      const currentDir = player.direction;
      const dot = currentDir.x * newDir.x + currentDir.y * newDir.y;
      const clampedDot = Math.min(Math.max(dot, -1), 1);
      const angleDiff = Math.acos(clampedDot);
      const maxAngle = Math.PI / 9;
      if (angleDiff > maxAngle) {
        const cross = currentDir.x * newDir.y - currentDir.y * newDir.x;
        const sign = cross >= 0 ? 1 : -1;
        newDir = {
          x: currentDir.x * Math.cos(sign * maxAngle) - currentDir.y * Math.sin(sign * maxAngle),
          y: currentDir.x * Math.sin(sign * maxAngle) + currentDir.y * Math.cos(sign * maxAngle)
        };
      }
      player.direction = newDir;
    });

    // Boost
    socket.on("boostStart", () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.queue.length <= 6) return;
      if (player.boosting) return;

      // Retirer immédiatement un segment
      const droppedSegment = player.queue.pop();
      const r = randomItemRadius();
      const value = getItemValue(r);
      const pos = clampPosition(droppedSegment.x, droppedSegment.y);
      const droppedItem = {
        id: `dropped-${Date.now()}`,
        x: pos.x,
        y: pos.y,
        value: value,
        color: droppedSegment.color,
        owner: socket.id,
        radius: r,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
      if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
        player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
      }
      if (player.queue.length <= 6) {
        player.boosting = false;
        return;
      }
      // Interval pour continuer à retirer des segments pendant le boost
      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 6) {
          const lastSeg = player.queue[player.queue.length - 1];
          const pos2 = clampPosition(lastSeg.x, lastSeg.y);
          const r2 = randomItemRadius();
          const value2 = getItemValue(r2);
          const droppedItem2 = {
            id: `dropped-${Date.now()}`,
            x: pos2.x,
            y: pos2.y,
            value: value2,
            color: lastSeg.color,
            owner: socket.id,
            radius: r2,
            dropTime: Date.now()
          };
          roomsData[roomId].items.push(droppedItem2);
          player.queue.pop();
          if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
            player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
          } else {
            clearInterval(player.boostInterval);
            player.boosting = false;
          }
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
        }
      }, BOOST_INTERVAL_MS);
    });

    socket.on("boostStop", () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.boosting) {
        clearInterval(player.boostInterval);
        player.boosting = false;
      }
    });

    // Déconnexion
    socket.on("disconnect", async () => {
      if (roomsData[roomId]?.players[socket.id]) {
        const player = roomsData[roomId].players[socket.id];
        dropQueueItems(player, roomId);
        updateGlobalLeaderboard(socket.id, player.itemEatenCount, player.pseudo || "Anonyme");
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
    });
  })();
});

// -----------------------------------------------
// Boucle de mise à jour du jeu : collisions, trajectoire & queue
// Avec la solution « ultime » côté serveur : resample complet de la trajectoire
// -----------------------------------------------
setInterval(() => {
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];
    const playerIds = Object.keys(room.players);
    const playersToEliminate = new Set();

    // Gestion des collisions entre joueurs
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const id1 = playerIds[i], id2 = playerIds[j];
        const player1 = room.players[id1];
        const player2 = room.players[id2];
        if (!player1 || !player2) continue;
        const head1 = { x: player1.x, y: player1.y, radius: getHeadRadius(player1) };
        const head2 = { x: player2.x, y: player2.y, radius: getHeadRadius(player2) };
        if (circlesCollide(head1, head2)) {
          playersToEliminate.add(id1);
          playersToEliminate.add(id2);
          continue;
        }
        // Collision tête / queue
        for (const segment of player2.queue) {
          const segmentCircle = { x: segment.x, y: segment.y, radius: getSegmentRadius(player2) };
          if (circlesCollide(head1, segmentCircle)) {
            playersToEliminate.add(id1);
            break;
          }
        }
        for (const segment of player1.queue) {
          const segmentCircle = { x: segment.x, y: segment.y, radius: getSegmentRadius(player1) };
          if (circlesCollide(head2, segmentCircle)) {
            playersToEliminate.add(id2);
            break;
          }
        }
      }
    }

    playersToEliminate.forEach(id => {
      io.to(id).emit("player_eliminated", { eliminatedBy: "collision" });
      const p = room.players[id];
      if (!p) return;
      dropQueueItems(p, roomId);
      updateGlobalLeaderboard(id, p.itemEatenCount, p.pseudo || "Anonyme");
      p.isSpectator = true;
      p.queue = [];
      p.positionHistory = [];
    });

    // Mise à jour de la trajectoire et reconstruction de la queue
    Object.entries(room.players).forEach(([id, player]) => {
      if (player.isSpectator) return;
      if (!player.direction) return;
      
      // 1) Ajout de la position actuelle dans l'historique brut
      player.positionHistory.push({ x: player.x, y: player.y });
      if (player.positionHistory.length > 5000) {
        player.positionHistory.shift();
      }
      
      // 2) Calcul de la nouvelle position de la tête ce tick
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      const newX = player.x + player.direction.x * speed;
      const newY = player.y + player.direction.y * speed;
      
      // 3) Ajout de la nouvelle position brute dans l'historique
      player.positionHistory.push({ x: newX, y: newY });
      
      // Mise à jour des coordonnées de la tête
      player.x = newX;
      player.y = newY;
      if (player.positionHistory.length > 5000) {
        player.positionHistory.shift();
      }
      
      // 4) Rééchantillonnage complet de la trajectoire (pour obtenir un chemin uniformisé)
      const uniformHistory = resamplePath(player.positionHistory, SAMPLING_STEP);
      // (Optionnel) Log pour debug – attention, cela peut générer beaucoup de texte :
      console.log(`Uniform history for player ${id}:`, uniformHistory);
      
      // 5) Reconstruction de la queue : pour chaque segment désiré, on cherche la position dans le chemin uniformisé
      const skinColors = player.skinColors || getDefaultSkinColors();
      const colors = (Array.isArray(skinColors) && skinColors.length >= 20)
        ? skinColors
        : getDefaultSkinColors();
      const tailSpacing = getHeadRadius(player) * 0.2; // Espacement désiré entre segments
      const desiredSegments = Math.max(6, Math.floor(player.itemEatenCount / 3));
      const newQueue = [];
      for (let i = 0; i < desiredSegments; i++) {
        const targetDistance = (i + 1) * tailSpacing;
        const posAtDistance = getPositionAtDistance(uniformHistory, targetDistance);
        const segmentColor = colors[i % 20];
        newQueue.push({ x: posAtDistance.x, y: posAtDistance.y, color: segmentColor });
      }
      player.queue = newQueue;
      player.color = colors[0];
      
      // 6) Vérification de la sortie du monde
      const headRadius = getHeadRadius(player);
      if (
        (player.x - headRadius < 0) ||
        (player.x + headRadius > worldSize.width) ||
        (player.y - headRadius < 0) ||
        (player.y + headRadius > worldSize.height)
      ) {
        io.to(id).emit("player_eliminated", { eliminatedBy: "boundary" });
        dropQueueItems(player, roomId);
        updateGlobalLeaderboard(id, player.itemEatenCount, player.pseudo || "Anonyme");
        player.isSpectator = true;
        player.queue = [];
        player.positionHistory = [];
        return;
      }
      
      // 7) Collision avec items
      const headCircle = { x: player.x, y: player.y, radius: headRadius };
      for (let i = 0; i < room.items.length; i++) {
        const item = room.items[i];
        if (item.owner && item.owner === id) {
          if (Date.now() - item.dropTime < 500) continue;
        }
        const itemCircle = { x: item.x, y: item.y, radius: item.radius };
        if (circlesCollide(headCircle, itemCircle)) {
          const oldQueueLength = player.queue.length;
          player.itemEatenCount += item.value;
          const targetQueueLength = Math.max(6, Math.floor(player.itemEatenCount / 3));
          const segmentsToAdd = targetQueueLength - oldQueueLength;
          for (let j = 0; j < segmentsToAdd; j++) {
            if (player.queue.length === 0) {
              player.queue.push({ x: player.x, y: player.y, color: colors[1] });
            } else {
              const lastSeg = player.queue[player.queue.length - 1];
              player.queue.push({ x: lastSeg.x, y: lastSeg.y, color: lastSeg.color });
            }
          }
          room.items.splice(i, 1);
          i--;
          if (room.items.length < MAX_ITEMS) {
            const r = randomItemRadius();
            const value = getItemValue(r);
            const newItem = {
              id: `item-${Date.now()}`,
              x: BOUNDARY_MARGIN + Math.random() * (worldSize.width - 2 * BOUNDARY_MARGIN),
              y: BOUNDARY_MARGIN + Math.random() * (worldSize.height - 2 * BOUNDARY_MARGIN),
              value: value,
              color: itemColors[Math.floor(Math.random() * itemColors.length)],
              radius: r
            };
            room.items.push(newItem);
          }
          break;
        }
      }
    });
    
    // Classement local (top 10)
    const sortedPlayers = Object.entries(room.players)
      .sort(([, a], [, b]) => b.itemEatenCount - a.itemEatenCount);
    const top10 = sortedPlayers.slice(0, 10).map(([id, player]) => ({
      id,
      pseudo: player.pseudo || "Anonyme",
      score: player.itemEatenCount,
      color: player.color
    }));
    
    // Envoi individuel des entités visibles à chaque joueur
    for (const pid of Object.keys(room.players)) {
      const viewingPlayer = room.players[pid];
      const visibleItems = getVisibleItemsForPlayer(viewingPlayer, room.items);
      const visiblePlayers = getVisiblePlayersForPlayer(viewingPlayer, room.players);
      
      io.to(pid).emit("update_entities", {
        players: visiblePlayers,
        items: visibleItems,
        leaderboard: top10
      });
    }
  });
}, 16);

// Routes HTTP
app.get("/", (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

app.get("/globalLeaderboard", async (req, res) => {
  const { data, error } = await supabase
    .from("global_leaderboard")
    .select("*")
    .order("score", { ascending: false })
    .limit(10);
  if (error) {
    console.error("Erreur lors de la récupération du leaderboard global :", error);
    return res.status(500).send(error);
  }
  res.json(data);
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
