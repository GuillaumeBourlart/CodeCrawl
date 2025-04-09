import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL = "", SUPABASE_ANON_KEY = "", PORT = 3000 } = process.env;
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_ANON_KEY:", SUPABASE_ANON_KEY ? "<non-empty>" : "<EMPTY>");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

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
const MAX_ITEMS = 300;
const SPEED_NORMAL = 3.2;
const SPEED_BOOST = 6.4;

// --- Fonctions utilitaires ---
function randomItemRadius() {
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}

function getHeadRadius(player) {
  return BASE_SIZE / 2 + player.itemEatenCount * 0.1 * 1.2;
}

function getSegmentRadius(player) {
  return BASE_SIZE / 2 + player.itemEatenCount * 0.1;
}

function getPlayerCircles(player) {
  const circles = [];
  circles.push({
    x: player.x,
    y: player.y,
    radius: getHeadRadius(player)
  });
  player.queue.forEach(segment => {
    circles.push({
      x: segment.x,
      y: segment.y,
      radius: getSegmentRadius(player)
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
      color: player.color,
      pseudo: player.pseudo,
      length: BASE_SIZE,
      queue: player.queue,
      itemEatenCount: player.itemEatenCount
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

function dropQueueItems(player, roomId) {
  player.queue.forEach((segment, index) => {
    if (index % 3 === 0) {
      const droppedItem = {
        id: `dropped-${Date.now()}-${Math.random()}`,
        x: segment.x,
        y: segment.y,
        value: Math.floor(Math.random() * 5) + 1,
        color: player.color,
        radius: randomItemRadius(),
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
    items.push({
      id: `item-${i}-${Date.now()}`,
      x: Math.random() * worldSize.width,
      y: Math.random() * worldSize.height,
      value: Math.floor(Math.random() * 5) + 1,
      color: itemColors[Math.floor(Math.random() * itemColors.length)],
      radius: randomItemRadius()
    });
  }
  return items;
}

const roomsData = {};

// --- Mise à jour du leaderboard global avec Supabase ---
// Cette fonction effectue un upsert sur la table "global_leaderboard"
// avec l'id, le pseudo et le score du joueur.
async function updateGlobalLeaderboard(playerId, score, pseudo) {
  const { data, error } = await supabase
    .from("global_leaderboard")
    .upsert([{ id: playerId, pseudo, score }]);
  if (error) {
    console.error("Erreur lors de la mise à jour du leaderboard global:", error);
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
  let room = existingRooms && existingRooms.length > 0 ? existingRooms[0] : null;
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
    // Initialisation du joueur avec une propriété "pseudo" qui sera défini plus tard
    const defaultDirection = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    const mag = Math.sqrt(defaultDirection.x ** 2 + defaultDirection.y ** 2) || 1;
    defaultDirection.x /= mag;
    defaultDirection.y /= mag;
    const playerColors = [
      "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF",
      "#00FFFF", "#8B5CF6", "#D946EF", "#F97316", "#0EA5E9"
    ];
    const randomColor = playerColors[Math.floor(Math.random() * playerColors.length)];
    const initialX = Math.random() * 800;
    const initialY = Math.random() * 600;

    roomsData[roomId].players[socket.id] = {
      x: initialX,
      y: initialY,
      length: BASE_SIZE,
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      color: randomColor,
      pseudo: null,         // Ce champ sera mis à jour lorsque le joueur choisira son pseudo
      itemEatenCount: 50,
      queue: Array(5).fill({ x: initialX, y: initialY })
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);
    socket.join(roomId);
    socket.emit("joined_room", { roomId });
    io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    io.to(roomId).emit("update_items", roomsData[roomId].items);

    // Gestion de l'événement pour définir le pseudo du joueur
    socket.on("setPseudo", (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (player && data.pseudo) {
        player.pseudo = data.pseudo;
        console.log(`Le joueur ${socket.id} a choisi le pseudo : ${data.pseudo}`);
      }
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
      if (player.queue.length <= 5) {
        console.log(`boostStart impossible pour ${socket.id} car la queue est minimale.`);
        return;
      }
      if (player.boosting) return;
      
      // Retirer immédiatement un segment et le transformer en item
      const droppedSegment = player.queue.pop();
      const droppedItem = {
        id: `dropped-${Date.now()}`,
        x: droppedSegment.x,
        y: droppedSegment.y,
        value: 6,
        color: player.color,
        owner: socket.id,
        radius: MAX_ITEM_RADIUS,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
      io.to(roomId).emit("update_items", roomsData[roomId].items);

      if (player.itemEatenCount > 50) {
        player.itemEatenCount = Math.max(50, player.itemEatenCount - 10);
      }
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));

      if (player.queue.length === 5) {
        player.boosting = false;
        return;
      }

      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 5) {
          const droppedSegment = player.queue[player.queue.length - 1];
          const droppedItem = {
            id: `dropped-${Date.now()}`,
            x: droppedSegment.x,
            y: droppedSegment.y,
            value: 6,
            color: player.color,
            owner: socket.id,
            radius: MAX_ITEM_RADIUS,
            dropTime: Date.now()
          };
          roomsData[roomId].items.push(droppedItem);
          io.to(roomId).emit("update_items", roomsData[roomId].items);
          player.queue.pop();
          if (player.itemEatenCount > 50) {
            player.itemEatenCount = Math.max(50, player.itemEatenCount - 10);
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
      }, 250);

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
        // Mise à jour du leaderboard global en envoyant le pseudo
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
      
      // Enregistrement de la position actuelle dans l'historique
      player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
      if (player.positionHistory.length > 5000) {
        player.positionHistory.shift();
      }
      
      // Mise à jour de la queue basée sur l'historique
      const tailSpacing = getHeadRadius(player) * 0.4;
      const desiredSegments = Math.floor(player.itemEatenCount / 10);
      const newQueue = [];
      for (let i = 0; i < desiredSegments; i++) {
        const targetDistance = (i + 1) * tailSpacing;
        const posAtDistance = getPositionAtDistance(player.positionHistory, targetDistance);
        newQueue.push(posAtDistance || { x: player.x, y: player.y });
      }
      player.queue = newQueue;
      
      // Mise à jour de la position de la tête
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      player.x += player.direction.x * speed;
      player.y += player.direction.y * speed;
      
      // Vérification des collisions avec les bordures
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
      
      // Collision avec les items
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
          const targetQueueLength = Math.floor(player.itemEatenCount / 10);
          const segmentsToAdd = targetQueueLength - oldQueueLength;
          for (let j = 0; j < segmentsToAdd; j++) {
            if (player.queue.length === 0) {
              player.queue.push({ x: player.x, y: player.y });
            } else {
              const lastSeg = player.queue[player.queue.length - 1];
              player.queue.push({ x: lastSeg.x, y: lastSeg.y });
            }
          }
          room.items.splice(i, 1);
          i--;
          if (room.items.length < MAX_ITEMS) {
            const newItem = {
              id: `item-${Date.now()}`,
              x: Math.random() * worldSize.width,
              y: Math.random() * worldSize.height,
              value: Math.floor(Math.random() * 5) + 1,
              color: itemColors[Math.floor(Math.random() * itemColors.length)],
              radius: randomItemRadius()
            };
            room.items.push(newItem);
          }
          io.to(roomId).emit("update_items", room.items);
          break;
        }
      }
    });
    
    // --- Calcul et émission du leaderboard pour la room ---
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

// --- Endpoint pour récupérer le leaderboard global ---
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
