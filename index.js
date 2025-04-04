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
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

// Rooms en mémoire (démonstration)
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

    if (!roomsData[roomId]) {
      roomsData[roomId] = { players: {} };
    }

    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: 10
    };

    socket.join(roomId);
    socket.emit('joined_room', { roomId });
    io.to(roomId).emit('update_players', roomsData[roomId].players);

    socket.on('move', (data) => {
      let player = roomsData[roomId].players[socket.id];
      if (!player) return;
      player.x = data.x;
      player.y = data.y;
      // TODO: collisions
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
