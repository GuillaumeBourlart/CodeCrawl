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
const DELAY_MS = 50;       // Décalage (ms) pour la mise à jour des segments
const SIM_INTERVAL = 10;   // Intervalle de simulation (ms)

// Vitesse en pixels par intervalle
const SPEED_NORMAL = 2;
const SPEED_BOOST = 4;

// Angle maximum autorisé pour un changement brusque (ici 30°)
const MAX_TURN_ANGLE = Math.PI / 6;

// --- Fonctions utilitaires ---

// Fonction pour faire tourner un vecteur de "angle" radians
function rotateVector(vector, angle) {
  return {
    x: vector.x * Math.cos(angle) - vector.y * Math.sin(angle),
    y: vector.x * Math.sin(angle) + vector.y * Math.cos(angle)
  };
}

// Limite la nouvelle direction pour éviter un demi-tour brutal
function clampDirection(current, desired, maxAngle) {
  // Normaliser la direction souhaitée
  const mag = Math.sqrt(desired.x * desired.x + desired.y * desired.y) || 1;
  const newDir = { x: desired.x / mag, y: desired.y / mag };
  // Calcul de l'angle entre current et newDir
  let dot = current.x * newDir.x + current.y * newDir.y;
  dot = Math.min(1, Math.max(-1, dot));
  const angle = Math.acos(dot);
  if (angle <= maxAngle) {
    return newDir;
  } else {
    // Déterminer le sens de rotation via le produit vectoriel
    const cross = current.x * newDir.y - current.y * newDir.x;
    const sign = cross >= 0 ? 1 : -1;
    // Retourne le vecteur obtenu en tournant current de maxAngle dans le sens adéquat
    return rotateVector(current, sign * maxAngle);
  }
}

// Renvoie la position différée dans l'historique selon le délai (en ms)
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

// Génère un tableau d'items aléatoires pour une room
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

// Retourne le nombre de segments attendus en fonction du nombre d'items mangés
function getExpectedSegments(itemEatenCount) {
  if (itemEatenCount < 5) return itemEatenCount;
  return 5 + Math.floor((itemEatenCount - 5) / 10);
}

// --- Données en mémoire ---
const roomsData = {};

// --- Fonctions de gestion de room ---
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

// --- Gestion des connexions ---
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

    // Initialiser le joueur avec position, historique, queue, direction, couleur, etc.
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
    io.to(roomId).emit('update_players', roomsData[roomId].players);
    io.to(roomId).emit('update_items', roomsData[roomId].items);

    // Le client change seulement la direction via "changeDirection" avec limitation d'arc
    socket.on('changeDirection', (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      player.direction = clampDirection(player.direction, { x, y }, MAX_TURN_ANGLE);
    });

    // Gestion du boost en continu
    // "boostStart" active le boost (tant que le client garde le clic) et "boostStop" l'arrête
    socket.on('boostStart', () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      // Ne peut pas booster si la queue est vide
      if (player.queue.length === 0) return;
      // Si déjà en boost, ne rien faire
      if (player.boosting) return;
      player.boosting = true;
      // Démarrer un intervalle qui retire un segment toutes les 500 ms
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 0) {
          player.queue.pop();
          player.length = BASE_SIZE * (1 + player.queue.length * 0.1);
          io.to(roomId).emit('update_players', roomsData[roomId].players);
        } else {
          // Arrêter le boost si la queue est vide
          clearInterval(player.boostInterval);
          player.boosting = false;
          io.to(roomId).emit('update_players', roomsData[roomId].players);
        }
      }, 500);
      io.to(roomId).emit('update_players', roomsData[roomId].players);
    });

    socket.on('boostStop', () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.boosting) {
        clearInterval(player.boostInterval);
        player.boosting = false;
        io.to(roomId).emit('update_players', roomsData[roomId].players);
      }
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

// Boucle de simulation pour le mouvement continu (toutes les SIM_INTERVAL ms)
setInterval(() => {
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];
    Object.entries(room.players).forEach(([id, player]) => {
      if (player.direction) {
        // Sauvegarder la position de la tête avant mise à jour
        const previousHead = { x: player.x, y: player.y };

        // Calculer la vitesse selon boost ou non
        const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
        player.x += player.direction.x * speed;
        player.y += player.direction.y * speed;

        // Ajouter la nouvelle position à l'historique (limité à 200 positions)
        player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
        if (player.positionHistory.length > 200) {
          player.positionHistory.shift();
        }

        // Calculer le délai fixe pour obtenir un espacement constant :
        // La distance désirée entre les cercles est égale à la taille du joueur.
        // On calcule fixedDelay pour que la distance parcourue pendant ce délai
        // soit égale à la taille actuelle (BASE_SIZE * (1 + queue.length * 0.1))
        const playerSize = BASE_SIZE * (1 + player.queue.length * 0.1);
        const fixedDelay = playerSize / (player.boosting ? SPEED_BOOST : SPEED_NORMAL) * SIM_INTERVAL;

        // Mise à jour de la queue : pour chaque segment, utiliser un décalage de (i+1)*fixedDelay
        for (let i = 0; i < player.queue.length; i++) {
          const delay = (i + 1) * fixedDelay;
          const delayedPos = getDelayedPosition(player.positionHistory, delay);
          if (delayedPos) {
            player.queue[i] = delayedPos;
          } else {
            player.queue[i] = { x: player.x, y: player.y };
          }
        }

        // Vérifier collision avec les parois
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
              const newSegmentPos = getDelayedPosition(player.positionHistory, (player.queue.length + 1) * fixedDelay)
                || { x: player.x, y: player.y };
              player.queue.push(newSegmentPos);
            }
            player.length = BASE_SIZE * (1 + player.queue.length * 0.1);
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
}, SIM_INTERVAL);

app.get('/', (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
