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
const ITEM_RADIUS = 10; // rayon de l'item
const BASE_SIZE = 20;   // taille de base du joueur
const DELAY_MS = 200;   // délai en millisecondes par segment

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
// Pour chaque room, on stocke :
// - players: chaque joueur possède {x,y, length, queue, positionHistory}
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
  let room = (existingRooms && existingRooms.length > 0)
    ? existingRooms[0]
    : null;
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
  await supabase
    .from('rooms')
    .update({ current_players: room.current_players + 1 })
    .eq('id', room.id);
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
  await supabase
    .from('rooms')
    .update({ current_players: newCount })
    .eq('id', roomId);
}

// Fonction utilitaire pour récupérer la position d'un joueur avec un délai donné (en ms)
// On parcourt la positionHistory pour trouver la position la plus proche du timestamp requis.
function getDelayedPosition(positionHistory, delay) {
  const targetTime = Date.now() - delay;
  // Si aucune historique, renvoie null
  if (!positionHistory || positionHistory.length === 0) return null;
  // On parcourt la liste depuis la fin (positions les plus récentes)
  for (let i = positionHistory.length - 1; i >= 0; i--) {
    if (positionHistory[i].time <= targetTime) {
      return { x: positionHistory[i].x, y: positionHistory[i].y };
    }
  }
  // Si aucune position n'est suffisamment ancienne, renvoie la plus ancienne
  return { x: positionHistory[0].x, y: positionHistory[0].y };
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

    // Initialise la room si nécessaire
    if (!roomsData[roomId]) {
      roomsData[roomId] = {
        players: {},
        items: generateRandomItems(50, worldSize)
      };
    }

    // Initialiser le joueur avec une queue vide et un historique de positions vide
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      queue: [],           // Queue initialement vide
      positionHistory: []  // Historique des positions (objets {x, y, time})
    };

    socket.join(roomId);
    socket.emit('joined_room', { roomId });
    io.to(roomId).emit('update_players', roomsData[roomId].players);
    io.to(roomId).emit('update_items', roomsData[roomId].items);

    // Gestion du mouvement
    socket.on('move', (data) => {
      let player = roomsData[roomId].players[socket.id];
      if (!player) return;
      
      // Ajoute la position actuelle à l'historique avec timestamp
      player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
      // Pour éviter que l'historique ne devienne trop grand, on garde seulement les 100 dernières positions
      if (player.positionHistory.length > 100) {
        player.positionHistory.shift();
      }
      
      // Sauvegarder l'ancienne position (pour le calcul de la queue)
      const oldHead = { x: player.x, y: player.y };

      // Mettre à jour la tête
      player.x = data.x;
      player.y = data.y;

      // Mettre à jour la queue pour chaque élément avec un délai
      // Pour le i-ème élément, on souhaite une position d'il y a (i+1)*DELAY_MS ms
      if (player.queue) {
        for (let i = 0; i < player.queue.length; i++) {
          const delay = (i + 1) * DELAY_MS;
          const delayedPos = getDelayedPosition(player.positionHistory, delay);
          if (delayedPos) {
            player.queue[i] = delayedPos;
          }
        }
      }
      
      // Vérifier la collision avec chaque item (collision sur toute la hitbox)
      // On considère le joueur comme un cercle de rayon = (playerSize / 2)
      const playerSize = BASE_SIZE * (1 + (player.queue.length * 0.1));
      const playerRadius = playerSize / 2;
      for (let i = 0; i < roomsData[roomId].items.length; i++) {
        const item = roomsData[roomId].items[i];
        // Supposons que l'item a un rayon fixe
        const itemRadius = 10;
        const dist = Math.hypot(player.x - item.x, player.y - item.y);
        if (dist < (playerRadius + itemRadius)) {
          // Collision : le joueur mange l'item
          // On ajoute un nouvel élément dans la queue : on prend la position dans l'historique correspondant à DELAY_MS ms
          const newSegmentPos = getDelayedPosition(player.positionHistory, DELAY_MS) || { x: player.x, y: player.y };
          player.queue.push(newSegmentPos);
          // Met à jour la taille
          player.length = BASE_SIZE * (1 + player.queue.length * 0.01);
          // Retirer l'item
          roomsData[roomId].items.splice(i, 1);
          i--;
          // Créer un nouvel item aléatoire
          const newItem = {
            id: `item-${Date.now()}`,
            x: Math.random() * worldSize.width,
            y: Math.random() * worldSize.height,
            value: Math.floor(Math.random() * 5) + 1,
            color: itemColors[Math.floor(Math.random() * itemColors.length)]
          };
          roomsData[roomId].items.push(newItem);
          io.to(roomId).emit('update_items', roomsData[roomId].items);
          break;
        }
      }
      io.to(roomId).emit('update_players', roomsData[roomId].players);
    });

    // Gestion du boost : active pendant 3 secondes
    socket.on('boost', () => {
      let player = roomsData[roomId].players[socket.id];
      if (!player) return;
      player.boosting = true;
      io.to(roomId).emit('update_players', roomsData[roomId].players);
      setTimeout(() => {
        player.boosting = false;
        io.to(roomId).emit('update_players', roomsData[roomId].players);
      }, 3000);
    });

    // Gestion d'une éventuelle élimination
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

app.get('/', (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
