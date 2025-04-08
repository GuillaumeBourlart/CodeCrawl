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
const worldSize = { width: 2000, height: 2000 };

const MIN_ITEM_RADIUS = 4;
const MAX_ITEM_RADIUS = 10;

const BASE_SIZE = 20; // Base size de la tête (cercle)
const MAX_ITEMS = 50;

// Vitesse constantes (le déplacement de la tête reste constant quel que soit la longueur)
const SPEED_NORMAL = 3.2;
const SPEED_BOOST = 6.4;

// --- Fonctions utilitaires ---

// Retourne un rayon aléatoire pour un item
function randomItemRadius() {
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}

// Calcul du rayon de la tête (augmente avec player.itemEatenCount)
function getHeadRadius(player) {
  return BASE_SIZE / 2 + player.itemEatenCount * 0.1 * 1.2;
}

// Calcul du rayon pour un segment de la queue
function getSegmentRadius(player) {
  return BASE_SIZE / 2 + player.itemEatenCount * 0.1;
}

// Retourne la liste des cercles constituant le serpent (tête et segments)
function getPlayerCircles(player) {
  const circles = [];
  circles.push({
    x: player.x,
    y: player.y,
    radius: getHeadRadius(player)
  });
  player.queue.forEach((segment) => {
    circles.push({
      x: segment.x,
      y: segment.y,
      radius: getSegmentRadius(player)
    });
  });
  return circles;
}

// Prépare l'état des joueurs à envoyer aux clients (rendu, etc.)
function getPlayersForUpdate(players) {
  const result = {};
  Object.entries(players).forEach(([id, player]) => {
    result[id] = {
      x: player.x,
      y: player.y,
      direction: player.direction,
      boosting: player.boosting,
      color: player.color,
      length: BASE_SIZE, // Ce champ n’est pas utilisé pour la physique
      queue: player.queue,
      itemEatenCount: player.itemEatenCount
    };
  });
  return result;
}

// Distance entre deux points
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Retourne la distance cumulée sur un historique de positions
function getCumulativeDistance(history) {
  let total = 0;
  for (let i = 1; i < history.length; i++) {
    total += distance(history[i], history[i - 1]);
  }
  return total;
}

// Conserve uniquement les points nécessaires dans positionHistory pour couvrir la distance requise + une marge
function trimPositionHistory(player, requiredDistance, margin = 50) {
  let cumulative = 0;
  let startIndex = 0;
  for (let i = 1; i < player.positionHistory.length; i++) {
    cumulative += distance(player.positionHistory[i], player.positionHistory[i - 1]);
    if (cumulative >= requiredDistance + margin) {
      startIndex = i - 1;
      break;
    }
  }
  if (startIndex > 0) {
    player.positionHistory = player.positionHistory.slice(startIndex);
  }
}

// Interpole la position dans l'historique à une distance targetDistance du dernier point (parcours arrière)
function getPositionAtDistance(positionHistory, targetDistance) {
  let totalDistance = 0;
  for (let i = positionHistory.length - 1; i > 0; i--) {
    const curr = positionHistory[i];
    const prev = positionHistory[i - 1];
    const segDist = distance(curr, prev);
    totalDistance += segDist;
    if (totalDistance >= targetDistance) {
      const overshoot = totalDistance - targetDistance;
      const fraction = overshoot / segDist;
      return {
        x: curr.x * (1 - fraction) + prev.x * fraction,
        y: curr.y * (1 - fraction) + prev.y * fraction
      };
    }
  }
  return positionHistory[0];
}

// (updateItemsEaten est géré manuellement désormais pour ne pas écraser la valeur)
function updateItemsEaten(player) {
  // Ne rien faire ici pour éviter d'écraser player.itemEatenCount,
  // qui est incrémenté ou décrémenté lors des collisions ou boosts.
  // Si vous le souhaitez, vous pouvez le laisser vide.
}

// Détection de collision entre deux cercles
function circlesCollide(circ1, circ2) {
  return distance(circ1, circ2) < (circ1.radius + circ2.radius);
}

// Convertir la queue en items (souvent lors d'une élimination)
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

// Génère des items aléatoires dans la room
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

// Rooms en mémoire
const roomsData = {};

// Fonctions pour créer et quitter une room via Supabase
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

// ----------------------
// Socket connection
// ----------------------
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
    // Initialisation du joueur
    const defaultDirection = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    const mag = Math.sqrt(defaultDirection.x ** 2 + defaultDirection.y ** 2) || 1;
    defaultDirection.x /= mag;
    defaultDirection.y /= mag;
    const playerColors = [
      "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF",
      "#00FFFF", "#8B5CF6", "#D946EF", "#F97316", "#0EA5E9"
    ];
    const randomColor = playerColors[Math.floor(Math.random() * playerColors.length)];
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      queue: [],
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      color: randomColor,
      itemEatenCount: 0
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);
    socket.join(roomId);
    socket.emit("joined_room", { roomId });
    io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    io.to(roomId).emit("update_items", roomsData[roomId].items);

    // Gestion des changements de direction
    socket.on("changeDirection", (data) => {
      console.log(`changeDirection reçu de ${socket.id}:`, data);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag = Math.sqrt(x * x + y * y) || 1;
      let newDir = { x: x / mag, y: y / mag };
      // Limiter le changement de direction
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

    // Gestion du boost
    socket.on("boostStart", () => {
      console.log(`boostStart déclenché par ${socket.id}`);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.queue.length === 0) {
        console.log(`boostStart impossible pour ${socket.id} car la queue est vide.`);
        return;
      }
      if (player.boosting) return;
      // Lors du boost, on retire immédiatement un segment et on le transforme en item
      const droppedSegment = player.queue.pop();
      const droppedItem = {
        id: `dropped-${Date.now()}`,
        x: droppedSegment.x,
        y: droppedSegment.y,
        value: 1,
        color: player.color,
        owner: socket.id,
        radius: MIN_ITEM_RADIUS,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
      io.to(roomId).emit("update_items", roomsData[roomId].items);
      // On ne touche pas à player.length ici
      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 0) {
          const droppedSegment = player.queue[player.queue.length - 1];
          const droppedItem = {
            id: `dropped-${Date.now()}`,
            x: droppedSegment.x,
            y: droppedSegment.y,
            value: 1,
            color: player.color,
            owner: socket.id,
            radius: MIN_ITEM_RADIUS,
            dropTime: Date.now()
          };
          roomsData[roomId].items.push(droppedItem);
          console.log(`Segment retiré de ${socket.id} transformé en item:`, droppedItem);
          io.to(roomId).emit("update_items", roomsData[roomId].items);
          player.queue.pop();
          if (player.itemEatenCount > 0) {
            player.itemEatenCount--;
          }
          io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
          console.log(`Fin du boost pour ${socket.id} car la queue est vide.`);
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
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });
  })();
});

// Boucle de simulation (intervalle de 16ms ~ 60FPS)
setInterval(() => {
  Object.keys(roomsData).forEach((roomId) => {
    const room = roomsData[roomId];
    const playerIds = Object.keys(room.players);

    // Gestion des collisions entre joueurs
    const playersToEliminate = new Set();
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const id1 = playerIds[i];
        const id2 = playerIds[j];
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
        delete room.players[id];
      }
    });

    // Mise à jour de chaque joueur
    Object.entries(room.players).forEach(([id, player]) => {
      if (!player.direction) return;

      // Enregistrement adaptatif de la position de la tête
      const currentHeadPos = { x: player.x, y: player.y };
      const lastPos = player.positionHistory.length > 0 ?
                      player.positionHistory[player.positionHistory.length - 1] :
                      null;
      // N'ajouter un point que si la distance depuis le dernier point >= (tailSpacing/2)
      const tailSpacing = getHeadRadius(player) * 0.4;
      if (!lastPos || distance(currentHeadPos, lastPos) >= tailSpacing / 2) {
        player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
      }
      
      // Garder dans positionHistory seulement ce qui est nécessaire pour couvrir la queue
      const requiredDistance = tailSpacing * (player.queue.length + 1);
      trimPositionHistory(player, requiredDistance, 50);

      // Rotation progressive vers targetDirection si défini
      if (player.targetDirection) {
        const currentDir = player.direction;
        const targetDir = player.targetDirection;
        const dot = currentDir.x * targetDir.x + currentDir.y * targetDir.y;
        const angleDiff = Math.acos(Math.min(Math.max(dot, -1), 1));
        const stepAngle = Math.PI / 6;
        if (angleDiff > 0.001) {
          while (angleDiff >= stepAngle) {
            const cross = currentDir.x * targetDir.y - currentDir.y * targetDir.x;
            const sign = cross >= 0 ? 1 : -1;
            const cosA = Math.cos(stepAngle);
            const sinA = Math.sin(stepAngle);
            player.direction = {
              x: player.direction.x * cosA - player.direction.y * sinA * sign,
              y: player.direction.x * sinA * sign + player.direction.y * cosA
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

      // Mise à jour de la position de la tête (vitesse constante)
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      player.x += player.direction.x * speed;
      player.y += player.direction.y * speed;

      // Mise à jour des segments de la queue par interpolation sur positionHistory
      for (let i = 0; i < player.queue.length; i++) {
        const targetDistance = (i + 1) * tailSpacing;
        const posAtDistance = getPositionAtDistance(player.positionHistory, targetDistance);
        if (posAtDistance) {
          player.queue[i] = posAtDistance;
        } else {
          player.queue[i] = { x: player.x, y: player.y };
        }
      }

      // Vérification des collisions avec les bordures
      const circles = getPlayerCircles(player);
      for (const c of circles) {
        if (
          c.x - c.radius < 0 ||
          c.x + c.radius > worldSize.width ||
          c.y - c.radius < 0 ||
          c.y + c.radius > worldSize.height
        ) {
          console.log(`Le joueur ${id} a touché une paroi avec un cercle. Élimination.`);
          io.to(id).emit("player_eliminated", { eliminatedBy: "boundary" });
          dropQueueItems(player, roomId);
          delete room.players[id];
          return;
        }
      }

      // Collision avec les items (basée sur la tête)
      const headCircle = { x: player.x, y: player.y, radius: getHeadRadius(player) };
      for (let i = 0; i < room.items.length; i++) {
        const item = room.items[i];
        const itemCircle = { x: item.x, y: item.y, radius: item.radius };
        if (item.owner && item.owner === id) {
          if (Date.now() - item.dropTime < 10000) continue;
        }
        if (circlesCollide(headCircle, itemCircle)) {
          // Ajoute autant de segments que la "value" de l'item
          const segmentsToAdd = item.value;
          for (let j = 0; j < segmentsToAdd; j++) {
            if (player.queue.length === 0) {
              player.queue.push({ x: player.x, y: player.y });
            } else {
              const lastSeg = player.queue[player.queue.length - 1];
              player.queue.push({ x: lastSeg.x, y: lastSeg.y });
            }
          }
          player.itemEatenCount += item.value;
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
    io.to(roomId).emit("update_players", getPlayersForUpdate(room.players));
  });
}, 16);

app.get("/", (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
