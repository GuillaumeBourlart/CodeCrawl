import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL = '', SUPABASE_ANON_KEY = '', PORT = 3000 } = process.env;
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_ANON_KEY:", SUPABASE_ANON_KEY ? "<non-empty>" : "<EMPTY>");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// --- Configuration ---
const itemColors = ['#FF5733', '#33FF57', '#3357FF', '#FF33A8', '#33FFF5', '#FFD133', '#8F33FF'];
const worldSize = { width: 2000, height: 2000 };
const ITEM_RADIUS = 10;
const BASE_SIZE = 20; // Taille constante pour le joueur et l'espacement entre segments
const MAX_ITEMS = 50; // Nombre maximum d'items autorisés

// Vitesse
const SPEED_NORMAL = 2;
const SPEED_BOOST = 4;

// Pour la gestion des joueurs à renvoyer au client
function getPlayersForUpdate(players) {
  const result = {};
  for (const [id, player] of Object.entries(players)) {
    result[id] = {
      x: player.x,
      y: player.y,
      direction: player.direction,
      boosting: player.boosting,
      color: player.color,
      // La taille reste constante (BASE_SIZE)
      length: BASE_SIZE,
      queue: player.queue,
      itemEatenCount: player.itemEatenCount
    };
  }
  return result;
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
      color: itemColors[Math.floor(Math.random() * itemColors.length)]
    });
  }
  return items;
}

// Ici, on n'utilise plus l'historique pour les segments.
  
// Rooms en mémoire
const roomsData = {};

async function findOrCreateRoom() {
  let { data: existingRooms, error } = await supabase
    .from('rooms')
    .select('*')
    .lt('current_players', 25)
    .order('current_players', { ascending: true })
    .limit(1);
  if (error) {
    console.error('Erreur Supabase (findOrCreateRoom):', error);
    return null;
  }
  let room = (existingRooms && existingRooms.length > 0) ? existingRooms[0] : null;
  if (!room) {
    const { data: newRoomData, error: newRoomError } = await supabase
      .from('rooms')
      .insert([{ name: 'New Room' }])
      .select()
      .single();
    if (newRoomError) {
      console.error('Erreur création room:', newRoomError);
      return null;
    }
    room = newRoomData;
  }
  console.log(`Room trouvée/créée: ${room.id} avec ${room.current_players} joueurs.`);
  await supabase.from('rooms').update({ current_players: room.current_players + 1 }).eq('id', room.id);
  return room;
}

async function leaveRoom(roomId) {
  if (!roomId) return;
  const { data, error } = await supabase.from('rooms').select('current_players').eq('id', roomId).single();
  if (!data || error) {
    console.error('Erreur lecture room (leaveRoom):', error);
    return;
  }
  const newCount = Math.max(0, data.current_players - 1);
  console.log(`Mise à jour du nombre de joueurs pour la room ${roomId}: ${newCount}`);
  await supabase.from('rooms').update({ current_players: newCount }).eq('id', roomId);
}

io.on('connection', (socket) => {
  console.log('Nouveau client connecté:', socket.id);

  (async () => {
    const room = await findOrCreateRoom();
    if (!room) {
      console.error(`Aucune room disponible pour ${socket.id}`);
      socket.emit('no_room_available');
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

    // Initialiser le joueur
    const defaultDirection = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    const mag = Math.sqrt(defaultDirection.x ** 2 + defaultDirection.y ** 2) || 1;
    defaultDirection.x /= mag;
    defaultDirection.y /= mag;
    const playerColors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#8B5CF6', '#D946EF', '#F97316', '#0EA5E9'];
    const randomColor = playerColors[Math.floor(Math.random() * playerColors.length)];
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      queue: [], // Initialement vide
      // On n'utilise plus positionHistory pour le suivi
      direction: defaultDirection,
      boosting: false,
      color: randomColor,
      itemEatenCount: 0
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);

    socket.join(roomId);
    socket.emit('joined_room', { roomId });
    io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    io.to(roomId).emit('update_items', roomsData[roomId].items);

    // Changement de direction
    socket.on('changeDirection', (data) => {
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
      const maxAngle = Math.PI / 6;
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

    // Boost start
    socket.on('boostStart', () => {
      console.log(`boostStart déclenché par ${socket.id}`);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.queue.length === 0) {
        console.log(`boostStart impossible pour ${socket.id} car la queue est vide.`);
        return;
      }
      if (player.boosting) return;
      player.boosting = true;
      // Pendant le boost, on utilise toujours la même méthode de mise à jour (contrainte de distance fixe)
      // Le boost n'influence plus l'espacement
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 0) {
          // On transforme le dernier segment en item
          const droppedSegment = player.queue[player.queue.length - 1];
          const droppedItem = {
            id: `dropped-${Date.now()}`,
            x: droppedSegment.x,
            y: droppedSegment.y,
            value: 0,
            color: player.color
          };
          roomsData[roomId].items.push(droppedItem);
          console.log(`Segment retiré de ${socket.id} et transformé en item:`, droppedItem);
          io.to(roomId).emit('update_items', roomsData[roomId].items);
          player.queue.pop();
          io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
          console.log(`Fin du boost pour ${socket.id} car la queue est vide.`);
          io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
        }
      }, 500);
      io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    });

    // Boost stop
    socket.on('boostStop', () => {
      console.log(`boostStop déclenché par ${socket.id}`);
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.boosting) {
        clearInterval(player.boostInterval);
        player.boosting = false;
        console.log(`Boost arrêté pour ${socket.id}`);
        io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
      }
    });

    // Player eliminated event (côté client)
    socket.on('player_eliminated', (data) => {
      console.log(`Player ${socket.id} éliminé par ${data.eliminatedBy}`);
      delete roomsData[roomId].players[socket.id];
      io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    });

    // Disconnect
    socket.on('disconnect', async (reason) => {
      console.log(`Déconnexion du socket ${socket.id}. Raison: ${reason}`);
      if (roomsData[roomId]?.players[socket.id]) {
        console.log(`Suppression du joueur ${socket.id} de la room ${roomId}`);
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
      io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    });
  })();
});

// Boucle de simulation (toutes les 10 ms)
setInterval(() => {
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];

    // Détection de collision frontale entre joueurs
    const playerIds = Object.keys(room.players);
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const id1 = playerIds[i];
        const id2 = playerIds[j];
        const player1 = room.players[id1];
        const player2 = room.players[id2];
        if (!player1 || !player2) continue;
        const dx = player1.x - player2.x;
        const dy = player1.y - player2.y;
        const distance = Math.hypot(dx, dy);
        if (distance < BASE_SIZE) { // Si les têtes se touchent
          const dot = player1.direction.x * player2.direction.x + player1.direction.y * player2.direction.y;
          if (dot < -0.8) {
            console.log(`Collision frontale détectée entre ${id1} et ${id2}. Élimination mutuelle.`);
            io.to(id1).emit("player_eliminated", { eliminatedBy: "collision frontale" });
            io.to(id2).emit("player_eliminated", { eliminatedBy: "collision frontale" });
            delete room.players[id1];
            delete room.players[id2];
          }
        }
      }
    }

    // Mise à jour de chaque joueur
    Object.entries(room.players).forEach(([id, player]) => {
      if (!player.direction) return;

      // Mettre à jour la tête
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      player.x += player.direction.x * speed;
      player.y += player.direction.y * speed;

      // Mise à jour de la queue par contrainte de distance fixe
      // On veut que chaque segment reste exactement à BASE_SIZE derrière le segment précédent.
      const spacing = BASE_SIZE;
      for (let i = 0; i < player.queue.length; i++) {
        const leader = i === 0 ? { x: player.x, y: player.y } : player.queue[i - 1];
        const seg = player.queue[i];
        const dx = seg.x - leader.x;
        const dy = seg.y - leader.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0) {
          seg.x = leader.x;
          seg.y = leader.y;
        } else {
          seg.x = leader.x + (dx / dist) * spacing;
          seg.y = leader.y + (dy / dist) * spacing;
        }
      }

      // Collision avec les parois
      if (player.x < 0 || player.x > worldSize.width || player.y < 0 || player.y > worldSize.height) {
        console.log(`Le joueur ${id} a touché une paroi. Élimination.`);
        io.to(id).emit("player_eliminated", { eliminatedBy: "boundary" });
        delete room.players[id];
        return;
      }

      // Collision avec les items
      const haloMargin = BASE_SIZE * 0.1;
      const playerRadius = BASE_SIZE / 2;
      for (let i = 0; i < room.items.length; i++) {
        const item = room.items[i];
        const dist = Math.hypot(player.x - item.x, player.y - item.y);
        if (dist < (playerRadius + ITEM_RADIUS + haloMargin)) {
          player.itemEatenCount = (player.itemEatenCount || 0) + 1;
          // Ajout d'un nouveau segment à la fin de la queue, initialisé à la position du dernier segment
          if (player.queue.length === 0) {
            // Si la queue est vide, le premier segment prend la position de la tête
            player.queue.push({ x: player.x, y: player.y });
          } else {
            const lastSeg = player.queue[player.queue.length - 1];
            player.queue.push({ x: lastSeg.x, y: lastSeg.y });
          }
          // Retirer l'item mangé
          room.items.splice(i, 1);
          i--;
          // Respawn d'un nouvel item si nécessaire
          if (room.items.length < MAX_ITEMS) {
            const newItem = {
              id: `item-${Date.now()}`,
              x: Math.random() * worldSize.width,
              y: Math.random() * worldSize.height,
              value: Math.floor(Math.random() * 5) + 1,
              color: itemColors[Math.floor(Math.random() * itemColors.length)]
            };
            room.items.push(newItem);
          }
          io.to(roomId).emit('update_items', room.items);
          break;
        }
      }
    });
    io.to(roomId).emit('update_players', getPlayersForUpdate(room.players));
  });
}, 10);

app.get('/', (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
