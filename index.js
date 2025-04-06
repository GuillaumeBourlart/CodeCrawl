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
const DELAY_MS = 50;       // Décalage par défaut (ms) pour la mise à jour des segments

// Vitesse (normal et boost)
const SPEED_NORMAL = 2;
const SPEED_BOOST = 4;

// -- Fonction utilitaire pour "nettoyer" les joueurs avant envoi au client
function getPlayersForUpdate(players) {
  const result = {};
  for (const [id, player] of Object.entries(players)) {
    result[id] = {
      x: player.x,
      y: player.y,
      direction: player.direction,
      boosting: player.boosting,
      color: player.color,
      length: player.length,
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

// Retourne la position différée dans l'historique selon le délai (en ms)
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
  return 5 + Math.floor((itemEatenCount - 5) / 10);
}

// Rooms en mémoire
// Chaque room stocke ses joueurs et ses items
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

    // Initialiser le joueur avec position aléatoire, queue et historique vides, direction aléatoire, couleur aléatoire, etc.
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
      itemEatenCount: 0,
      lastQueueUpdateTime: 0
    };

    socket.join(roomId);
    socket.emit('joined_room', { roomId });
    // Utiliser getPlayersForUpdate pour ne pas envoyer de champs problématiques
    io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    io.to(roomId).emit('update_items', roomsData[roomId].items);

    // Le client change seulement la direction via "changeDirection"
    socket.on('changeDirection', (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag = Math.sqrt(x * x + y * y) || 1;
      player.direction = { x: x / mag, y: y / mag };
    });

    // Gestion du boost via "boostStart" et "boostStop"
    socket.on('boostStart', () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.queue.length === 0) return; // Ne peut pas booster sans segments
      if (player.boosting) return;
      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 0) {
          // Retirer le dernier segment (celui le plus éloigné)
          player.queue.pop();
          player.length = BASE_SIZE * (1 + player.queue.length * 0.1);
          io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
          io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
        }
      }, 500);
      io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on('boostStop', () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.boosting) {
        clearInterval(player.boostInterval);
        player.boosting = false;
        io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
      }
    });

    socket.on('player_eliminated', (data) => {
      console.log(`Player ${socket.id} éliminé par ${data.eliminatedBy}`);
      delete roomsData[roomId].players[socket.id];
      io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on('disconnect', async () => {
      console.log('Déconnexion:', socket.id);
      if (roomsData[roomId]?.players[socket.id]) {
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
      io.to(roomId).emit('update_players', getPlayersForUpdate(roomsData[roomId].players));
    });
  })();
});

// Boucle de simulation pour le mouvement continu (toutes les 10 ms)
setInterval(() => {
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];
    Object.entries(room.players).forEach(([id, player]) => {
      if (!player.direction) return;

      // Sauvegarder la position actuelle dans l'historique
      player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
      if (player.positionHistory.length > 200) {
        player.positionHistory.shift();
      }

      // Calculer la vitesse (boost ou normal)
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      player.x += player.direction.x * speed;
      player.y += player.direction.y * speed;

      // Pour le calcul de l'espacement, on calcule un "fixedDelay"
      // La distance désirée entre les centres doit être égale à la taille du joueur
      const playerSize = BASE_SIZE * (1 + player.queue.length * 0.1);
      const fixedDelay = (playerSize / speed) * 10; // ms

      // Mise à jour de la queue : pour chaque segment, récupérer la position différée
      for (let i = 0; i < player.queue.length; i++) {
        const delay = (i + 1) * fixedDelay;
        const delayedPos = getDelayedPosition(player.positionHistory, delay);
        if (delayedPos) {
          player.queue[i] = delayedPos;
        } else {
          // Si pas trouvé, on cale la position sur la tête
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
          const expectedSegments = getExpectedSegments(player.itemEatenCount);
          if (player.queue.length < expectedSegments) {
            const newSegmentPos = getDelayedPosition(
              player.positionHistory,
              (player.queue.length + 1) * fixedDelay
            ) || { x: player.x, y: player.y };
            player.queue.push(newSegmentPos);
          }
          player.length = BASE_SIZE * (1 + player.queue.length * 0.1);
          room.items.splice(i, 1);
          i--;

          // Générez un nouvel item pour garder un total constant
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
    });

    // Envoyer l'état des joueurs « nettoyé » à tous
    io.to(roomId).emit('update_players', getPlayersForUpdate(room.players));
  });
}, 10);

app.get('/', (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
