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

const worldSize = { width: 2000, height: 2000 };

// Génère des items aléatoires pour une room
function generateRandomItems(count, worldSize) {
  const items = [];
  const itemColors = ['#FF5733', '#33FF57', '#3357FF', '#FF33A8', '#33FFF5', '#FFD133', '#8F33FF'];
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

    // Initialise la structure de la room si nécessaire
    if (!roomsData[roomId]) {
      roomsData[roomId] = {
        players: {},
        items: generateRandomItems(50, worldSize)
      };
    }

    // Ajoute le joueur dans la room
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: 20,
      segments: [] // queue vide initialement
    };

    socket.join(roomId);
    socket.emit('joined_room', { roomId });
    io.to(roomId).emit('update_players', roomsData[roomId].players);
    io.to(roomId).emit('update_items', roomsData[roomId].items);

    // Gestion du mouvement et vérification de collision avec les items
    socket.on('move', (data) => {
      let player = roomsData[roomId].players[socket.id];
      if (!player) return;
      player.x = data.x;
      player.y = data.y;
      // Vérifier collision avec chaque item
      if (roomsData[roomId].items) {
        for (let i = 0; i < roomsData[roomId].items.length; i++) {
          const item = roomsData[roomId].items[i];
          const dist = Math.hypot(player.x - item.x, player.y - item.y);
          if (dist < 20) { // Seuil de collision
            // Le joueur mange l'item : ajouter un segment

            // S’il y a déjà des segments, on récupère la position du dernier segment.
// Sinon, on récupère la position actuelle du joueur.
const tailPos = (player.segments.length > 0)
  ? player.segments[player.segments.length - 1]
  : { x: player.x, y: player.y };

// On ajoute le nouveau segment à la position du "bout de la queue"
player.segments.push({ x: tailPos.x, y: tailPos.y });

            // Recalcule la taille : taille de base * (1 + nombre_de_segments * 0.1)
            const baseSize = 20;
            player.length = baseSize * (1 + player.segments.length * 0.1);
            // Retire l'item
            roomsData[roomId].items.splice(i, 1);
            i--;
            // On crée un nouvel item aléatoire
const newItem = {
  id: `item-${Date.now()}`,
  x: Math.random() * worldSize.width,
  y: Math.random() * worldSize.height,
  value: Math.floor(Math.random() * 5) + 1,
  color: itemColors[Math.floor(Math.random() * itemColors.length)]
};

// On l'ajoute au tableau
roomsData[roomId].items.push(newItem);

// On notifie les clients
io.to(roomId).emit('update_items', roomsData[roomId].items);
            // Notifie tous les clients que les items ont changé
            
            break;
          }
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
