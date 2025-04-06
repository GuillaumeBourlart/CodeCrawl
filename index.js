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

const itemColors = ['#FF5733', '#33FF57', '#3357FF', '#FF33A8', '#33FFF5', '#FFD133', '#8F33FF'];
const worldSize = { width: 2000, height: 2000 };
const ITEM_RADIUS = 10;    // Rayon fixe de l'item
const BASE_SIZE = 20;      // Taille de base du joueur
const DEFAULT_DELAY_MS = 200;  // Délai par défaut pour la mise à jour des segments (en ms)

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

// Rooms en mémoire
// Chaque room stocke :
// - players: { x, y, length, queue, positionHistory, direction, boosting, lastBoostTime, itemEatenCount, color }
// - items: tableau d'items
const roomsData = {};

async function findOrCreateRoom() {
  let { data: existingRooms, error } = await supabase
    .from('rooms')
    .select('*')
    .lt('current_players', 25)
    .order('current_players', { ascending: true })
    .limit(1);
  if (error) {
    console.error('Erreur Supabase:', error);
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
  await supabase.from('rooms').update({ current_players: room.current_players + 1 }).eq('id', room.id);
  return room;
}

async function leaveRoom(roomId) {
  if (!roomId) return;
  const { data, error } = await supabase.from('rooms').select('current_players').eq('id', roomId).single();
  if (!data || error) {
    console.error('Erreur lecture room:', error);
    return;
  }
  const newCount = Math.max(0, data.current_players - 1);
  await supabase.from('rooms').update({ current_players: newCount }).eq('id', roomId);
}

// Retourne la position différée dans l'historique en fonction du délai (ms)
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

// Retourne le nombre de segments attendus en fonction du nombre d'items mangés
function getExpectedSegments(itemEatenCount) {
  if (itemEatenCount < 5) return itemEatenCount;
  return 5 + Math.floor((itemEatenCount - 5) / 10);
}

io.on('connection', (socket) => {
  console.log('Nouveau client connecté:', socket.id);
  (async () => {
    const room = await findOrCreateRoom();
    if (!room) {
      socket.emit('no_room_available');
      socket.disconnect();
      return;
    }
    const roomId = room.id;
    console.log(`Le joueur ${socket.id} rejoint la room ${roomId}`);

    if (!roomsData[roomId]) {
      roomsData[roomId] = {
        players: {},
        items: generateRandomItems(50, worldSize)
      };
    }

    // Initialiser le joueur avec position aléatoire, queue et historique vides, direction aléatoire, couleur aléatoire et compteur d'items à 0
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
      queue: [],
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      color: randomColor,
      itemEatenCount: 0
    };

    socket.join(roomId);
    socket.emit('joined_room', { roomId });
    io.to(roomId).emit('update_players', roomsData[roomId].players);
    io.to(roomId).emit('update_items', roomsData[roomId].items);

    // Le client change seulement la direction via "changeDirection"
    socket.on('changeDirection', (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag = Math.sqrt(x * x + y * y) || 1;
      player.direction = { x: x / mag, y: y / mag };
    });

    // Gestion du boost avec cooldown de 7 sec
    socket.on('boost', () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const now = Date.now();
      if (player.lastBoostTime && now < player.lastBoostTime + 7000) return;
      player.lastBoostTime = now;
      player.boosting = true;
      io.to(roomId).emit('update_players', roomsData[roomId].players);
      setTimeout(() => {
        player.boosting = false;
        io.to(roomId).emit('update_players', roomsData[roomId].players);
      }, 3000);
    });

    socket.on('player_eliminated', (data) => {
      console.log(`Player ${socket.id} éliminé par ${data.eliminatedBy}`);
      delete roomsData[roomId].players[socket.id];
      io.to(roomId).emit('update_players', roomsData[roomId].players);
    });

    socket.on('disconnect', async () => {
      console.log('Déconnexion:', socket.id);
      if (roomsData[roomId]?.players[socket.id]) {
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
      io.to(roomId).emit('update_players', roomsData[roomId].players);
    });
  })();
});

// Boucle de simulation pour le mouvement continu (toutes les 10 ms)
setInterval(() => {
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];
    Object.entries(room.players).forEach(([id, player]) => {
      if (player.direction) {
        // Détermination de la vitesse : boost => 4, sinon 2
        const speed = player.boosting ? 4 : 2;
        player.x += player.direction.x * speed;
        player.y += player.direction.y * speed;

        // Ajouter la nouvelle position à l'historique
        player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
        if (player.positionHistory.length > 200) {
          player.positionHistory.shift();
        }

        // Calculer la "taille" actuelle du joueur (diamètre du cercle)
        const playerSize = BASE_SIZE * (1 + player.queue.length * 0.1);
        // Calculer le délai nécessaire pour que le joueur parcoure une distance égale à sa taille
        // La distance par intervalle est "speed" (pixels tous les 10ms), donc le délai T en ms est:
        // T = (playerSize / speed) * 10
        const T = (playerSize / speed) * 10;
        // Si le joueur booste, on divise T par 2 pour mettre à jour deux fois plus vite
        const currentDelay = player.boosting ? T / 2 : T;

        // Mise à jour de la queue
        // Pour chaque segment existant, on veut que la distance entre son centre et le centre du segment précédent soit égale à playerSize
        // Ainsi, pour le i-ème segment, on cherche dans l'historique la position datant de (i+1) * currentDelay ms
        for (let i = 0; i < player.queue.length; i++) {
          const delay = (i + 1) * currentDelay;
          const delayedPos = getDelayedPosition(player.positionHistory, delay);
          if (delayedPos) {
            player.queue[i] = delayedPos;
          } else {
            player.queue[i] = { x: player.x, y: player.y };
          }
        }

        // Vérifier collisions avec les parois
        if (player.x < 0 || player.x > worldSize.width || player.y < 0 || player.y > worldSize.height) {
          io.to(roomId).emit("player_eliminated", { eliminatedBy: "boundary" });
          delete room.players[id];
          return;
        }

        // Vérifier collision avec les items (hitbox circulaire)
        const playerRadius = playerSize / 2;
        for (let i = 0; i < room.items.length; i++) {
          const item = room.items[i];
          const dist = Math.hypot(player.x - item.x, player.y - item.y);
          if (dist < (playerRadius + ITEM_RADIUS)) {
            // Le joueur mange l'item
            player.itemEatenCount = (player.itemEatenCount || 0) + 1;
            // Calcul du nombre de segments attendus
            const expectedSegments = getExpectedSegments(player.itemEatenCount);
            // Ajout d'un segment si la queue n'a pas atteint le nombre attendu
            if (player.queue.length < expectedSegments) {
              const newSegmentPos = getDelayedPosition(player.positionHistory, (player.queue.length + 1) * currentDelay)
                || { x: player.x, y: player.y };
              player.queue.push(newSegmentPos);
            }
            // Ajuster la taille du joueur
            player.length = BASE_SIZE * (1 + player.queue.length * 0.1);
            // Supprimer l'item et en générer un nouveau
            room.items.splice(i, 1);
            i--;
            const newItem = {
              id: `item-${Date.now()}`,
              x: Math.random() * worldSize.width,
              y: Math.random() * worldSize.height,
              value: Math.floor(Math.random() * 5) + 1,
              color: itemColors[Math.floor(Math.random() * itemColors.length)]
            };
            room.items.push(newItem);
            io.to(roomId).emit('update_items', room.items);
            break;
          }
        }
      }
    });
    io.to(roomId).emit('update_players', room.players);
  });
}, 10);

app.get('/', (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
