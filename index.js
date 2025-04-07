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
  "#8F33FF",
];
const worldSize = { width: 2000, height: 2000 };
const ITEM_RADIUS = 10;
const BASE_SIZE = 20; // Taille de base d'un cercle (et côté du carré pour la tête)
const MAX_ITEMS = 50; // Nombre maximum d'items autorisés
const DELAY_MS = 50;  // Valeur de base pour le calcul du delay

// Vitesse
const SPEED_NORMAL = 2;
const SPEED_BOOST = 4;

// === Fonctions de détection de collision ===

// Collision entre un rectangle et un cercle
function rectCircleColliding(rectX, rectY, rectW, rectH, circleX, circleY, circleR) {
  const closestX = Math.max(rectX, Math.min(circleX, rectX + rectW));
  const closestY = Math.max(rectY, Math.min(circleY, rectY + rectH));
  const dx = circleX - closestX;
  const dy = circleY - closestY;
  return (dx * dx + dy * dy) <= (circleR * circleR);
}

// Collision entre deux rectangles
function rectRectColliding(x1, y1, w1, h1, x2, y2, w2, h2) {
  return !(
    x2 > x1 + w1 ||
    x2 + w2 < x1 ||
    y2 > y1 + h1 ||
    y2 + h2 < y1
  );
}

// Prépare l'état des joueurs à envoyer aux clients
function getPlayersForUpdate(players) {
  const result = {};
  for (const [id, player] of Object.entries(players)) {
    result[id] = {
      x: player.x,
      y: player.y,
      direction: player.direction,
      boosting: player.boosting,
      color: player.color,
      length: BASE_SIZE,
      queue: player.queue,
      itemEatenCount: player.itemEatenCount,
    };
  }
  return result;
}

// Convertit la queue d'un joueur en items et met à jour les clients
function dropQueueItems(player, roomId) {
  player.queue.forEach((segment) => {
    const droppedItem = {
      id: `dropped-${Date.now()}-${Math.random()}`,
      x: segment.x,
      y: segment.y,
      value: 0,
      color: player.color,
      dropTime: Date.now(),
    };
    roomsData[roomId].items.push(droppedItem);
  });
  io.to(roomId).emit("update_items", roomsData[roomId].items);
}

// Génère des items aléatoires pour une room
function generateRandomItems(count, worldSize) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: `item-${i}-${Date.now()}`,
      x: Math.random() * worldSize.width,
      y: Math.random() * worldSize.height,
      value: Math.floor(Math.random() * 5) + 1,
      color: itemColors[Math.floor(Math.random() * itemColors.length)],
    });
  }
  return items;
}

// Retourne la position différée dans l'historique selon le délai (ms)
function getDelayedPosition(positionHistory, delay) {
  const targetTime = Date.now() - delay;
  if (!positionHistory || positionHistory.length === 0) return null;
  for (let i = positionHistory.length - 1; i >= 0; i--) {
    if (positionHistory[i].time <= targetTime) {
      return { x: positionHistory[i].x, y: positionHistory[i].y };
    }
  }
  return { x: positionHistory[0].x, y: positionHistory[0].y };
}

// Retourne le nombre de segments attendus en fonction des items mangés
function getExpectedSegments(itemEatenCount) {
  if (itemEatenCount < 5) return itemEatenCount;
  return 5 + Math.floor((itemEatenCount - 5) / 3);
}

// Rooms en mémoire
const roomsData = {};

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
        items: generateRandomItems(MAX_ITEMS, worldSize),
      };
      console.log(`Initialisation de la room ${roomId} avec ${MAX_ITEMS} items.`);
    }
    // Initialiser le joueur avec une direction initiale
    const defaultDirection = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    const mag = Math.sqrt(defaultDirection.x ** 2 + defaultDirection.y ** 2) || 1;
    defaultDirection.x /= mag;
    defaultDirection.y /= mag;
    const playerColors = [
      "#FF0000",
      "#00FF00",
      "#0000FF",
      "#FFFF00",
      "#FF00FF",
      "#00FFFF",
      "#8B5CF6",
      "#D946EF",
      "#F97316",
      "#0EA5E9",
    ];
    const randomColor =
      playerColors[Math.floor(Math.random() * playerColors.length)];
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      queue: [],
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      color: randomColor,
      itemEatenCount: 0,
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);

    socket.join(roomId);
    socket.emit("joined_room", { roomId });
    io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    io.to(roomId).emit("update_items", roomsData[roomId].items);

    // Changement de direction
    socket.on("changeDirection", (data) => {
      console.log(`changeDirection reçu de ${socket.id}:`, data);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag = Math.sqrt(x * x + y * y) || 1;
      let newDir = { x: x / mag, y: y / mag };
      // Limiter le changement de direction en tournant d'au maximum 15° (Math.PI/12)
      const currentDir = player.direction;
      const dot = currentDir.x * newDir.x + currentDir.y * newDir.y;
      const clampedDot = Math.min(Math.max(dot, -1), 1);
      const angleDiff = Math.acos(clampedDot);
      const maxAngle = Math.PI / 12;
      if (angleDiff > maxAngle) {
        const cross = currentDir.x * newDir.y - currentDir.y * newDir.x;
        const sign = cross >= 0 ? 1 : -1;
        function rotateVector(vec, angle) {
          return {
            x: vec.x * Math.cos(angle) - vec.y * Math.sin(angle),
            y: vec.x * Math.sin(angle) + vec.y * Math.cos(angle),
          };
        }
        newDir = rotateVector(currentDir, sign * maxAngle);
      }
      player.direction = newDir;
      console.log(`Nouvelle direction pour ${socket.id}:`, newDir);
    });

    // Boost start
    socket.on("boostStart", () => {
      console.log(`boostStart déclenché par ${socket.id}`);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.queue.length === 0) {
        console.log(`boostStart impossible pour ${socket.id} car la queue est vide.`);
        return;
      }
      if (player.boosting) return;

      // Retirer immédiatement un segment et le transformer en item
      const droppedSegment = player.queue.pop();
      const droppedItem = {
        id: `dropped-${Date.now()}`,
        x: droppedSegment.x,
        y: droppedSegment.y,
        value: 0,
        color: player.color,
        owner: socket.id,
        dropTime: Date.now(),
      };
      roomsData[roomId].items.push(droppedItem);
      io.to(roomId).emit("update_items", roomsData[roomId].items);
      player.length = BASE_SIZE * (1 + player.queue.length * 0.001);
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));

      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 0) {
          const droppedSegment = player.queue[player.queue.length - 1];
          const droppedItem = {
            id: `dropped-${Date.now()}`,
            x: droppedSegment.x,
            y: droppedSegment.y,
            value: 0,
            color: player.color,
            owner: socket.id,
            dropTime: Date.now(),
          };
          roomsData[roomId].items.push(droppedItem);
          console.log(`Segment retiré de ${socket.id} et transformé en item:`, droppedItem);
          io.to(roomId).emit("update_items", roomsData[roomId].items);
          player.queue.pop();
          player.length = BASE_SIZE * (1 + player.queue.length * 0.001);
          io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
          console.log(`Fin du boost pour ${socket.id} car la queue est vide.`);
          io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
        }
      }, 500);
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    // Boost stop
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

    // Player eliminated event (côté client)
    socket.on("player_eliminated", (data) => {
      console.log(`Player ${socket.id} éliminé par ${data.eliminatedBy}`);
      const player = roomsData[roomId].players[socket.id];
      if (player) {
        dropQueueItems(player, roomId);
      }
      delete roomsData[roomId].players[socket.id];
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    // Disconnect
    socket.on("disconnect", async (reason) => {
      console.log(`Déconnexion du socket ${socket.id}. Raison: ${reason}`);
      if (roomsData[roomId]?.players[socket.id]) {
        console.log(`Suppression du joueur ${socket.id} de la room ${roomId}`);
        const player = roomsData[roomId].players[socket.id];
        dropQueueItems(player, roomId);
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });
  })();
});

// --- Boucle de simulation ---
setInterval(() => {
  Object.keys(roomsData).forEach((roomId) => {
    const room = roomsData[roomId];

    // Collision frontale entre joueurs (en utilisant la hitbox rectangulaire pour la tête)
    const playerIds = Object.keys(room.players);
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const id1 = playerIds[i];
        const id2 = playerIds[j];
        const player1 = room.players[id1];
        const player2 = room.players[id2];
        if (!player1 || !player2) continue;
        // Définir les rectangles de hitbox pour les têtes
        const rect1 = { x: player1.x - BASE_SIZE / 2, y: player1.y - BASE_SIZE / 2, size: BASE_SIZE };
        const rect2 = { x: player2.x - BASE_SIZE / 2, y: player2.y - BASE_SIZE / 2, size: BASE_SIZE };
        if (rectRectColliding(rect1.x, rect1.y, rect1.size, rect1.size, rect2.x, rect2.y, rect2.size, rect2.size)) {
          console.log(`Collision entre ${id1} et ${id2}. Élimination mutuelle.`);
          io.to(id1).emit("player_eliminated", { eliminatedBy: "collision frontale" });
          io.to(id2).emit("player_eliminated", { eliminatedBy: "collision frontale" });
          delete room.players[id1];
          delete room.players[id2];
        }
      }
    }

    // Mise à jour de chaque joueur
    Object.entries(room.players).forEach(([id, player]) => {
      if (!player.direction) return;

      // Enregistrer la position actuelle dans l'historique
      player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
      if (player.positionHistory.length > 10000) {
        player.positionHistory.shift();
      }

      // Mise à jour progressive de la direction (rotation vers targetDirection si applicable)
      if (player.targetDirection) {
        const currentDir = player.direction;
        const targetDir = player.targetDirection;
        const dot = currentDir.x * targetDir.x + currentDir.y * targetDir.y;
        const angleDiff = Math.acos(Math.min(Math.max(dot, -1), 1));
        const stepAngle = Math.PI / 6; // 30° par tick
        if (angleDiff > 0.001) {
          while (angleDiff >= stepAngle) {
            const cross = currentDir.x * targetDir.y - currentDir.y * targetDir.x;
            const sign = cross >= 0 ? 1 : -1;
            const cosA = Math.cos(stepAngle);
            const sinA = Math.sin(stepAngle);
            player.direction = {
              x: player.direction.x * cosA - player.direction.y * sinA * sign,
              y: player.direction.x * sinA * sign + player.direction.y * cosA,
            };
            const newDot = player.direction.x * targetDir.x + player.direction.y * targetDir.y;
            const newAngleDiff = Math.acos(Math.min(Math.max(newDot, -1), 1));
            if (newAngleDiff < stepAngle) {
              player.direction = targetDir;
              break;
            }
          }
        }
      }

      // Mise à jour de la position de la tête
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      player.x += player.direction.x * speed;
      player.y += player.direction.y * speed;

      // Vérifier la collision avec les bordures en considérant la hitbox entière de la tête (carré)
      if (
        player.x - BASE_SIZE / 2 < 0 ||
        player.x + BASE_SIZE / 2 > worldSize.width ||
        player.y - BASE_SIZE / 2 < 0 ||
        player.y + BASE_SIZE / 2 > worldSize.height
      ) {
        console.log(`Le joueur ${id} a touché une paroi. Élimination.`);
        io.to(id).emit("player_eliminated", { eliminatedBy: "boundary" });
        dropQueueItems(player, roomId);
        delete room.players[id];
        return;
      }

      // Collision avec les items : utiliser la détection rectangle-cercle pour la tête
      const haloMargin = BASE_SIZE * 0.1;
      room.items.forEach((item, idx) => {
        if (item.owner && item.owner === id) {
          if (Date.now() - item.dropTime < 10000) return;
        }
        if (
          rectCircleColliding(
            player.x - BASE_SIZE / 2,
            player.y - BASE_SIZE / 2,
            BASE_SIZE,
            BASE_SIZE,
            item.x,
            item.y,
            ITEM_RADIUS + haloMargin
          )
        ) {
          player.itemEatenCount = (player.itemEatenCount || 0) + 1;
          if (player.queue.length < getExpectedSegments(player.itemEatenCount)) {
            if (player.queue.length === 0) {
              player.queue.push({ x: player.x, y: player.y });
            } else {
              const lastSeg = player.queue[player.queue.length - 1];
              player.queue.push({ x: lastSeg.x, y: lastSeg.y });
            }
          }
          room.items.splice(idx, 1);
          if (room.items.length < MAX_ITEMS) {
            const newItem = {
              id: `item-${Date.now()}`,
              x: Math.random() * worldSize.width,
              y: Math.random() * worldSize.height,
              value: Math.floor(Math.random() * 5) + 1,
              color: itemColors[Math.floor(Math.random() * itemColors.length)],
            };
            room.items.push(newItem);
          }
          io.to(roomId).emit("update_items", room.items);
        }
      });
    });
    io.to(roomId).emit("update_players", getPlayersForUpdate(room.players));
  });
}, 10);

app.get("/", (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
