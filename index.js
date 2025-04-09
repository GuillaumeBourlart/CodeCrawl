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

const BASE_SIZE = 20; // Taille de base d'un cercle pour la tête
const MAX_ITEMS = 600;
const SPEED_NORMAL = 3.2;
const SPEED_BOOST = 6.4;
const BOUNDARY_MARGIN = 100; // Marge à respecter par rapport aux bords

// Paramètres pour le joueur et boost
const DEFAULT_ITEM_EATEN_COUNT = 18; // correspond à 6 segments (18/3=6)
const BOOST_ITEM_COST = 3;           // booster enlève 1 segment = 3 points
const BOOST_INTERVAL_MS = 250;

// --- Fonction de clamp pour contraindre la position ---
function clampPosition(x, y, margin = BOUNDARY_MARGIN) {
  return {
    x: Math.min(Math.max(x, margin), worldSize.width - margin),
    y: Math.min(Math.max(y, margin), worldSize.height - margin)
  };
}

// --- Fonction utilitaire pour récupérer le JSON d'un skin ---
// Remplacez cette fonction par la récupération depuis votre BDD ou cache.
function getSkinData(skin_id) {
  // Exemple de skins (skin_id est supposé être un entier ou une chaîne non nulle)
  const skins = {
    "1": { colors: ["#FF0000", "#00FF00", "#0000FF"] },
    "2": { colors: ["#FFFF00", "#FF00FF", "#00FFFF", "#FFFFFF"] },
    // Vous pouvez ajouter autant de skins que nécessaire
  };
  // Si aucun skin correspondant n'est trouvé, on renvoie le skin 1 par défaut
  return skins[skin_id] || skins["1"];
}

function getItemValue(radius) {
  // Interpolation linéaire : min radius => 1, max radius => 6
  return Math.round(1 + ((radius - MIN_ITEM_RADIUS) / (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS)) * 5);
}

function randomItemRadius() {
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}

// Pour que la croissance visuelle ne commence qu'au-delà du score de base
function getHeadRadius(player) {
  return BASE_SIZE / 2 + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT) * 0.05;
}

function getSegmentRadius(player) {
  return BASE_SIZE / 2 + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT) * 0.05;
}

// On stocke ici les coordonnées ET la couleur pour chaque segment
function getPlayerCircles(player) {
  const circles = [];
  // La tête du joueur : sa couleur peut être celle du skin (par exemple, le premier élément du pattern)
  circles.push({
    x: player.x,
    y: player.y,
    radius: getHeadRadius(player),
    color: getSkinData(player.skin_id).colors[0]  // on utilise ici le premier couleur du skin
  });
  player.queue.forEach(segment => {
    circles.push({
      x: segment.x,
      y: segment.y,
      radius: getSegmentRadius(player),
      color: segment.color  // la couleur assignée lors du calcul de la queue
    });
  });
  return circles;
}

function getPlayersForUpdate(players) {
  const result = {};
  Object.entries(players).forEach(([id, player]) => {
    result[id] = {
      x: player.x,
      y: player.y,
      direction: player.direction,
      boosting: player.boosting,
      pseudo: player.pseudo,
      length: BASE_SIZE,
      queue: player.queue,
      itemEatenCount: player.itemEatenCount,
      skin_id: player.skin_id || null
    };
  });
  return result;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
// Lorsqu'on drop des items depuis la queue, on utilise la couleur stockée dans le segment correspondant
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
        // Utilise la couleur du segment pour le drop
        color: segment.color,
        radius: r,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
    }
  });
  io.to(roomId).emit("update_items", roomsData[roomId].items);
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

// --- Mise à jour du leaderboard global avec Supabase ---
async function updateGlobalLeaderboard(playerId, score, pseudo) {
  const { data, error } = await supabase
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

// --- Recherche / création de room via Supabase ---
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
  await supabase.from("rooms").update({ current_players: newCount }).eq("id", roomId);
}

// --- Gestion Socket.io ---
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
    
    const defaultDirection = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    const mag = Math.sqrt(defaultDirection.x ** 2 + defaultDirection.y ** 2) || 1;
    defaultDirection.x /= mag;
    defaultDirection.y /= mag;
    
    // Ici, le joueur commence avec 6 segments par défaut et itemEatenCount = DEFAULT_ITEM_EATEN_COUNT.
    // On ne peut pas avoir un skin nul donc le client devra avoir envoyé une valeur dans setPlayerInfo.
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      // La couleur par défaut sera calculée à partir du skin choisi lors de setPlayerInfo.
      color: null,
      pseudo: null, // Sera défini via setPlayerInfo
      skin_id: null, // Sera défini via setPlayerInfo
      itemEatenCount: DEFAULT_ITEM_EATEN_COUNT,
      // La queue sera initialisée avec 6 segments incluant la couleur à partir du skin.
      queue: Array(6).fill({ x: Math.random() * 800, y: Math.random() * 600 })
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);
    socket.join(roomId);
    socket.emit("joined_room", { roomId });
    io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    io.to(roomId).emit("update_items", roomsData[roomId].items);

    // Réception des infos de profil (pseudo et skin choisi ; skin_id ne peut être null)
    socket.on("setPlayerInfo", (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (player && data.pseudo && data.skin_id) {
        player.pseudo = data.pseudo;
        player.skin_id = data.skin_id;
        // Récupère le skin et applique-le :
        const skinData = getSkinData(player.skin_id);
        // Définir la couleur par défaut du joueur comme la première couleur du skin.
        player.color = skinData.colors[0];
      }
      console.log(`Infos définies pour ${socket.id} :`, data);
    });

    socket.on("changeDirection", (data) => {
      console.log(`changeDirection reçu de ${socket.id}:`, data);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag = Math.sqrt(x * x + y * y) || 1;
      let newDir = { x: x / mag, y: y / mag };
      const currentDir = player.direction;
      const dot = currentDir.x * newDir.x + currentDir.y * newDir.y;
      const clampedDot = Math.min(Math.max(dot, -1), 1);
      const angleDiff = Math.acos(clampedDot);
      const maxAngle = Math.PI / 9;
      if (angleDiff > maxAngle) {
        const cross = currentDir.x * newDir.y - currentDir.y * newDir.x;
        const sign = cross >= 0 ? 1 : -1;
        function rotateVector(vec, angle) {
          return {
            x: vec.x * Math.cos(angle) - vec.y * Math.sin(angle),
            y: vec.x * Math.sin(angle) + vec.y * Math.cos(angle)
          };
        }
        newDir = rotateVector(currentDir, sign * maxAngle);
      }
      player.direction = newDir;
      console.log(`Nouvelle direction pour ${socket.id}:`, newDir);
    });

    socket.on("boostStart", () => {
      console.log(`boostStart déclenché par ${socket.id}`);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      // Boost autorisé uniquement si la queue contient plus de 6 segments
      if (player.queue.length <= 6) {
        console.log(`boostStart impossible pour ${socket.id} car la queue est au minimum (6 segments).`);
        return;
      }
      if (player.boosting) return;
      
      // Lors du boost, on retire immédiatement un segment. On utilise la couleur du segment retiré.
      const droppedSegment = player.queue.pop();
      const r = randomItemRadius();
      const value = getItemValue(r);
      const pos = clampPosition(droppedSegment.x, droppedSegment.y);
      const droppedItem = {
        id: `dropped-${Date.now()}`,
        x: pos.x,
        y: pos.y,
        value: value,
        color: droppedSegment.color,  // On récupère la couleur du segment retiré
        owner: socket.id,
        radius: r,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
      io.to(roomId).emit("update_items", roomsData[roomId].items);
      
      if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
        player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
      }
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
      
      if (player.queue.length <= 6) {
        player.boosting = false;
        return;
      }
      
      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 6) {
          const droppedSegment = player.queue[player.queue.length - 1];
          const pos = clampPosition(droppedSegment.x, droppedSegment.y);
          const r = randomItemRadius();
          const value = getItemValue(r);
          const droppedItem = {
            id: `dropped-${Date.now()}`,
            x: pos.x,
            y: pos.y,
            value: value,
            color: droppedSegment.color, // On utilise la couleur du segment retiré
            owner: socket.id,
            radius: r,
            dropTime: Date.now()
          };
          roomsData[roomId].items.push(droppedItem);
          io.to(roomId).emit("update_items", roomsData[roomId].items);
          player.queue.pop();
          if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
            player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
          } else {
            clearInterval(player.boostInterval);
            player.boosting = false;
          }
          io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
          io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
        }
      }, BOOST_INTERVAL_MS);
      
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on("boostStop", () => {
      console.log(`boostStop déclenché par ${socket.id}`);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.boosting) {
        clearInterval(player.boostInterval);
        player.boosting = false;
        console.log(`Boost arrêté pour ${socket.id}`);
        io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
      }
    });

    socket.on("player_eliminated", (data) => {
      console.log(`Player ${socket.id} éliminé par ${data.eliminatedBy}`);
      const player = roomsData[roomId].players[socket.id];
      if (player) {
        dropQueueItems(player, roomId);
        updateGlobalLeaderboard(socket.id, player.itemEatenCount, player.pseudo || "Anonyme");
      }
      delete roomsData[roomId].players[socket.id];
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on("disconnect", async (reason) => {
      console.log(`Déconnexion du socket ${socket.id}. Raison: ${reason}`);
      if (roomsData[roomId]?.players[socket.id]) {
        console.log(`Suppression du joueur ${socket.id} de la room ${roomId}`);
        const player = roomsData[roomId].players[socket.id];
        dropQueueItems(player, roomId);
        updateGlobalLeaderboard(socket.id, player.itemEatenCount, player.pseudo || "Anonyme");
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });
  })();
});

// --- Boucle de mise à jour du jeu ---
// Ici, on recalcule la queue pour chaque joueur en assignant au segment sa couleur issue du skin choisi.
setInterval(() => {
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];
    const playerIds = Object.keys(room.players);

    const playersToEliminate = new Set();
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
      if (room.players[id]) {
        dropQueueItems(room.players[id], roomId);
        updateGlobalLeaderboard(id, room.players[id].itemEatenCount, room.players[id].pseudo || "Anonyme");
        delete room.players[id];
      }
    });

    Object.entries(room.players).forEach(([id, player]) => {
      if (!player.direction) return;
      
      // Mettre à jour l'historique de position
      player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
      if (player.positionHistory.length > 5000) {
        player.positionHistory.shift();
      }
      
      // Recalcul de la queue
      // On récupère le skin actuel du joueur
      const skinData = getSkinData(player.skin_id);
      const tailSpacing = getHeadRadius(player) * 0.2;
      const desiredSegments = Math.max(6, Math.floor(player.itemEatenCount / 3));
      const newQueue = [];
      for (let i = 0; i < desiredSegments; i++) {
        const targetDistance = (i + 1) * tailSpacing;
        const posAtDistance = getPositionAtDistance(player.positionHistory, targetDistance);
        // Assigne la couleur du pattern : le pattern se répète
        const color = skinData.colors[i % skinData.colors.length];
        newQueue.push({ x: posAtDistance.x, y: posAtDistance.y, color: color });
      }
      player.queue = newQueue;
      
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      player.x += player.direction.x * speed;
      player.y += player.direction.y * speed;
      
      const circles = getPlayerCircles(player);
      for (const c of circles) {
        if (
          c.x - c.radius < 0 ||
          c.x + c.radius > worldSize.width ||
          c.y - c.radius < 0 ||
          c.y + c.radius > worldSize.height
        ) {
          console.log(`Le joueur ${id} a touché une paroi. Élimination.`);
          io.to(id).emit("player_eliminated", { eliminatedBy: "boundary" });
          dropQueueItems(player, roomId);
          updateGlobalLeaderboard(id, player.itemEatenCount, player.pseudo || "Anonyme");
          delete room.players[id];
          return;
        }
      }
      
      const headCircle = { x: player.x, y: player.y, radius: getHeadRadius(player) };
      for (let i = 0; i < room.items.length; i++) {
        const item = room.items[i];
        const itemCircle = { x: item.x, y: item.y, radius: item.radius };
        if (item.owner && item.owner === id) {
          if (Date.now() - item.dropTime < 500) continue;
        }
        if (circlesCollide(headCircle, itemCircle)) {
          const oldQueueLength = player.queue.length;
          player.itemEatenCount += item.value;
          const targetQueueLength = Math.max(6, Math.floor(player.itemEatenCount / 3));
          const segmentsToAdd = targetQueueLength - oldQueueLength;
          for (let j = 0; j < segmentsToAdd; j++) {
            if (player.queue.length === 0) {
              player.queue.push({ x: player.x, y: player.y, color: getSkinData(player.skin_id).colors[0] });
            } else {
              const lastSeg = player.queue[player.queue.length - 1];
              // On duplique le segment en gardant sa couleur
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
          io.to(roomId).emit("update_items", room.items);
          break;
        }
      }
    });
    
    const sortedPlayers = Object.entries(room.players)
      .sort(([, a], [, b]) => b.itemEatenCount - a.itemEatenCount);
    const top10 = sortedPlayers.slice(0, 10).map(([id, player]) => ({
      id,
      pseudo: player.pseudo || "Anonyme",
      score: player.itemEatenCount,
      color: player.color
    }));
    io.to(roomId).emit("update_room_leaderboard", top10);
    io.to(roomId).emit("update_players", getPlayersForUpdate(room.players));
  });
}, 16);

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
