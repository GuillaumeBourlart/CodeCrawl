import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL = '',
  SUPABASE_ANON_KEY = '',
  PORT = 3000
} = process.env;

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
const QUEUE_UPDATE_INTERVAL = 50; // Intervalle de mise à jour de la queue en ms

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

// Retourne le nombre de segments attendus selon le nombre d'items mangés
function getExpectedSegments(itemEatenCount) {
  if (itemEatenCount < 5) return itemEatenCount;
  return 5 + Math.floor((itemEatenCount - 5) / 10);
}

// Rooms en mémoire : chaque room stocke ses joueurs et ses items.
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
  const { data, error } = await supabase
    .from('rooms')
    .select('current_players')
    .eq('id', roomId)
    .single();
  if (!data || error) {
    console.error('Erreur lecture room:', error);
    return;
  }
  const newCount = Math.max(0, data.current_players - 1);
  await supabase.from('rooms').update({ current_players: newCount }).eq('id', roomId);
}

// Lorsqu'un joueur boost, la vitesse est plus élevée (par exemple 4 vs 2)
const SPEED_NORMAL = 2;
const SPEED_BOOST = 4;

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

    // Initialisation du joueur avec :
    // - position aléatoire
    // - queue et historique vides
    // - direction par défaut aléatoire (normalisée)
    // - couleur aléatoire
    // - compteur d'items mangés à 0
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
        // Sauvegarder la position de la tête avant mise à jour
        const previousHead = { x: player.x, y: player.y };

        // Mettre à jour la position du joueur selon sa direction et sa vitesse
        const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
        player.x += player.direction.x * speed;
        player.y += player.direction.y * speed;

        // Ajouter la nouvelle position à l'historique
        player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
        if (player.positionHistory.length > 200) {
          player.positionHistory.shift();
        }

        // Mise à jour de la queue :
        // Toutes les 50 ms, on met à jour la position de chaque segment :
        // Le premier segment prend la position de la tête avant mise à jour,
        // et chaque segment suivant prend la position précédemment détenue par son prédécesseur.
        if (Date.now() - (player.lastQueueUpdateTime || 0) >= QUEUE_UPDATE_INTERVAL) {
          const newQueue = [];
          if (player.queue.length > 0) {
            newQueue[0] = previousHead; // Le premier segment suit la tête
            for (let i = 1; i < player.queue.length; i++) {
              newQueue[i] = player.queue[i - 1]; // Chaque segment suit le segment précédent
            }
          }
          // On met à jour la queue seulement si elle existe (sinon, rien à faire)
          if (newQueue.length > 0) {
            player.queue = newQueue;
            player.lastQueueUpdateTime = Date.now();
          }
        }

        // Vérifier collision avec les parois
        if (player.x < 0 || player.x > worldSize.width || player.y < 0 || player.y > worldSize.height) {
          io.to(roomId).emit("player_eliminated", { eliminatedBy: "boundary" });
          delete room.players[id];
          return;
        }

        // Vérifier collision avec les items (hitbox circulaire)
        const playerSize = BASE_SIZE * (1 + (player.queue.length * 0.1));
        const playerRadius = playerSize / 2;
        for (let i = 0; i < room.items.length; i++) {
          const item = room.items[i];
          const dist = Math.hypot(player.x - item.x, player.y - item.y);
          if (dist < (playerRadius + ITEM_RADIUS)) {
            // Le joueur mange l'item
            player.itemEatenCount = (player.itemEatenCount || 0) + 1;
            // Règle d'ajout de segments :
            // - Si la queue contient moins de 5 segments, ajouter un segment pour chaque item mangé.
            // - Sinon, ajouter un segment tous les 10 items mangés.
            const expectedSegments = player.itemEatenCount < 5
              ? player.itemEatenCount
              : 5 + Math.floor((player.itemEatenCount - 5) / 10);
            if (player.queue.length < expectedSegments) {
              // Pour le nouveau segment, on prend la position différée correspondant au délai (ici 50ms)
              const newSegmentPos = getDelayedPosition(player.positionHistory, QUEUE_UPDATE_INTERVAL)
                || { x: player.x, y: player.y };
              player.queue.push(newSegmentPos);
            }
            // Ajuster la taille du joueur
            player.length = BASE_SIZE * (1 + player.queue.length * 0.1);
            // Supprimer l'item et générer un nouvel item
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
