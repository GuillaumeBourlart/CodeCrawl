import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import Stripe from "stripe";

// Variables d'environnement
const {
  SUPABASE_URL = "",
  SUPABASE_ANON_KEY = "",
  PORT = 3000,
  STRIPE_SECRET_KEY = "",
  STRIPE_WEBHOOK_SECRET = "",
} = process.env;
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_ANON_KEY:", SUPABASE_ANON_KEY ? "<non-empty>" : "<EMPTY>");

// Initialisation Supabase et Stripe
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
app.use(cors({ origin: "*" }));

// Pour les endpoints JSON classiques
app.use(express.json());

// --- Configuration du jeu ---
const itemColors = [
  "#FF5733",
  "#33FF57",
  "#3357FF",
  "#FF33A8",
  "#33FFF5",
  "#FFD133",
  "#8B5CF6",
];
const worldSize = { width: 4000, height: 4000 };

const MIN_ITEM_RADIUS = 4;
const MAX_ITEM_RADIUS = 10;
const BASE_SIZE = 20; // Taille de base d'un cercle
const MAX_ITEMS = 600;
const SPEED_NORMAL = 3.2;
const SPEED_BOOST = 6.4;
const BOUNDARY_MARGIN = 100;

const DEFAULT_ITEM_EATEN_COUNT = 18; // 6 segments par défaut
const BOOST_ITEM_COST = 3;
const BOOST_INTERVAL_MS = 250;

// --- Fonctions utilitaires et game logic ---

function clampPosition(x, y, margin = BOUNDARY_MARGIN) {
  return {
    x: Math.min(Math.max(x, margin), worldSize.width - margin),
    y: Math.min(Math.max(y, margin), worldSize.height - margin)
  };
}

async function getSkinDataFromDB(skin_id) {
  const { data, error } = await supabase
    .from("game_skins")
    .select("data, stripe_product_id")
    .eq("id", skin_id)
    .single();

  if (error || !data) {
    console.error("Erreur de récupération du skin :", error);
    return { colors: getDefaultSkinColors(), stripe_price_id: null };
  }
  // data.data contient l'objet JSON (avec colors)
  const skin = data.data;
  if (!skin || !skin.colors || skin.colors.length !== 20) {
    console.warn("Le skin récupéré ne contient pas 20 couleurs. Utilisation du skin par défaut.");
    return { colors: getDefaultSkinColors(), stripe_price_id: data.stripe_price_id };
  }
  return { colors: skin.colors, stripe_price_id: data.stripe_price_id };
}

function getDefaultSkinColors() {
  return [
    "#FF5733", "#33FF57", "#3357FF", "#FF33A8", "#33FFF5",
    "#FFD133", "#8B5CF6", "#FF0000", "#00FF00", "#0000FF",
    "#FFFF00", "#FF00FF", "#00FFFF", "#AAAAAA", "#BBBBBB",
    "#CCCCCC", "#DDDDDD", "#EEEEEE", "#999999", "#333333"
  ];
}

function getItemValue(radius) {
  return Math.round(1 + ((radius - MIN_ITEM_RADIUS) / (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS)) * 5);
}

function randomItemRadius() {
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}

function getHeadRadius(player) {
  return BASE_SIZE / 2 + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT) * 0.05;
}

function getSegmentRadius(player) {
  return BASE_SIZE / 2 + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT) * 0.05;
}

function getPlayerCircles(player) {
  const skinColors = player.skinColors || getDefaultSkinColors();
  const circles = [];
  circles.push({
    x: player.x,
    y: player.y,
    radius: getHeadRadius(player),
    color: skinColors[0]
  });
  player.queue.forEach(segment => {
    circles.push({
      x: segment.x,
      y: segment.y,
      radius: getSegmentRadius(player),
      color: segment.color
    });
  });
  return circles;
}

function getPlayersForUpdate(players) {
  const result = {};
  Object.entries(players).forEach(([id, player]) => {
    result[id] = {
      x: player.x,
      y: player.y,
      direction: player.direction,
      boosting: player.boosting,
      pseudo: player.pseudo,
      length: BASE_SIZE,
      queue: player.queue,
      itemEatenCount: player.itemEatenCount,
      skin_id: player.skin_id || null,
      color: player.color,
      skinColors: player.skinColors
    };
  });
  return result;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getPositionAtDistance(positionHistory, targetDistance) {
  let totalDistance = 0;
  for (let i = positionHistory.length - 1; i > 0; i--) {
    const curr = positionHistory[i];
    const prev = positionHistory[i - 1];
    const segmentDistance = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    totalDistance += segmentDistance;
    if (totalDistance >= targetDistance) {
      const overshoot = totalDistance - targetDistance;
      const fraction = overshoot / segmentDistance;
      return {
        x: curr.x * (1 - fraction) + prev.x * fraction,
        y: curr.y * (1 - fraction) + prev.y * fraction
      };
    }
  }
  return { x: positionHistory[0].x, y: positionHistory[0].y };
}

function circlesCollide(circ1, circ2) {
  return Math.hypot(circ1.x - circ2.x, circ1.y - circ2.y) < (circ1.radius + circ2.radius);
}

function dropQueueItems(player, roomId) {
  player.queue.forEach((segment, index) => {
    if (index % 3 === 0) {
      const r = randomItemRadius();
      const value = getItemValue(r);
      const pos = clampPosition(segment.x, segment.y);
      const droppedItem = {
        id: `dropped-${Date.now()}-${Math.random()}`,
        x: pos.x,
        y: pos.y,
        value: value,
        color: segment.color,
        radius: r,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
    }
  });
  io.to(roomId).emit("update_items", roomsData[roomId].items);
}

function generateRandomItems(count, worldSize) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = randomItemRadius();
    const value = getItemValue(r);
    items.push({
      id: `item-${i}-${Date.now()}`,
      x: BOUNDARY_MARGIN + Math.random() * (worldSize.width - 2 * BOUNDARY_MARGIN),
      y: BOUNDARY_MARGIN + Math.random() * (worldSize.height - 2 * BOUNDARY_MARGIN),
      value: value,
      color: itemColors[Math.floor(Math.random() * itemColors.length)],
      radius: r
    });
  }
  return items;
}

const roomsData = {};

async function updateGlobalLeaderboard(playerId, score, pseudo) {
  const { data, error } = await supabase
    .from("global_leaderboard")
    .upsert([{ id: playerId, pseudo, score }]);
  if (error) {
    console.error("Erreur lors de la mise à jour du leaderboard global:", error);
    return;
  }
  const { data: leaderboardData, error: selectError } = await supabase
    .from("global_leaderboard")
    .select("score")
    .order("score", { ascending: false })
    .limit(10);
  if (selectError) {
    console.error("Erreur lors de la récupération du leaderboard:", selectError);
    return;
  }
  // Optionnel : nettoyer si besoin
}

// --- Endpoints Stripe ---

// Endpoint pour créer une session de paiement
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { skin_id, user_id } = req.body; // Attendu dans le body
    if (!skin_id || !user_id) {
      return res.status(400).json({ error: "skin_id and user_id are required." });
    }
    // Récupérer le stripe_price_id depuis la table game_skins via Supabase
    const { data: gameSkin, error } = await supabase
      .from("game_skins")
      .select("data, stripe_price_id")
      .eq("id", skin_id)
      .single();

    if (error || !gameSkin) {
      return res.status(404).json({ error: "Skin not found." });
    }

    if (!gameSkin.stripe_price_id) {
      return res.status(400).json({ error: "No Stripe price set for this skin." });
    }

    // Créer la session de paiement Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: gameSkin.stripe_price_id,
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://votre-site.com/payment-success", // à adapter
      cancel_url: "https://votre-site.com/payment-canceled",  // à adapter
      metadata: {
        user_id,
        skin_id,
      },
    });
    return res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Erreur /create-checkout-session :", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint Webhook Stripe (utilise express.raw)
app.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gérez l'événement checkout.session.completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { user_id, skin_id } = session.metadata;
      // Mettre à jour la table user_skins dans Supabase pour enregistrer l'achat du skin
      supabase
        .from("user_skins")
        .insert({
          user_id,
          skin_id,
          purchased_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) {
            console.error("Erreur insertion dans user_skins :", error);
          } else {
            console.log(`Skin ${skin_id} acheté par ${user_id} enregistré.`);
          }
        });
    }
    res.json({ received: true });
  }
);

// --- Le reste de votre code existant (logique de game server) ---

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
    
    const defaultDirection = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    const mag = Math.sqrt(defaultDirection.x ** 2 + defaultDirection.y ** 2) || 1;
    defaultDirection.x /= mag;
    defaultDirection.y /= mag;
    
    // Initialisation du joueur – 6 segments par défaut, itemEatenCount = DEFAULT_ITEM_EATEN_COUNT.
    // Le client devra envoyer via "setPlayerInfo" un pseudo et un skin_id non nul.
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      color: null,
      pseudo: null,
      skin_id: null,
      itemEatenCount: DEFAULT_ITEM_EATEN_COUNT,
      queue: Array(6).fill({ x: Math.random() * 800, y: Math.random() * 600 })
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);
    socket.join(roomId);
    socket.emit("joined_room", { roomId });
    io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    io.to(roomId).emit("update_items", roomsData[roomId].items);

    socket.on("setPlayerInfo", async (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (player && data.pseudo && data.skin_id) {
        player.pseudo = data.pseudo;
        player.skin_id = data.skin_id;
        // Récupération du skin depuis Supabase
        const { colors } = await getSkinDataFromDB(player.skin_id);
        player.skinColors = colors; // Tableau de 20 couleurs
        // La tête utilise la couleur 0 du pattern
        player.color = colors[0];
      }
      console.log(`Infos définies pour ${socket.id}:`, data);
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on("changeDirection", (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag = Math.sqrt(x * x + y * y) || 1;
      let newDir = { x: x / mag, y: y / mag };
      const currentDir = player.direction;
      const dot = currentDir.x * newDir.x + currentDir.y * newDir.y;
      const clampedDot = Math.min(Math.max(dot, -1), 1);
      const angleDiff = Math.acos(clampedDot);
      const maxAngle = Math.PI / 9;
      if (angleDiff > maxAngle) {
        const cross = currentDir.x * newDir.y - currentDir.y * newDir.x;
        const sign = cross >= 0 ? 1 : -1;
        newDir = {
          x: currentDir.x * Math.cos(sign * maxAngle) - currentDir.y * Math.sin(sign * maxAngle),
          y: currentDir.x * Math.sin(sign * maxAngle) + currentDir.y * Math.cos(sign * maxAngle)
        };
      }
      player.direction = newDir;
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on("boostStart", () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.queue.length <= 6) return;
      if (player.boosting) return;

      // Retirer immédiatement un segment en conservant sa couleur.
      const droppedSegment = player.queue.pop();
      const r = randomItemRadius();
      const value = getItemValue(r);
      const pos = clampPosition(droppedSegment.x, droppedSegment.y);
      const droppedItem = {
        id: `dropped-${Date.now()}`,
        x: pos.x,
        y: pos.y,
        value: value,
        color: droppedSegment.color,
        owner: socket.id,
        radius: r,
        dropTime: Date.now()
      };
      roomsData[roomId].items.push(droppedItem);
      io.to(roomId).emit("update_items", roomsData[roomId].items);

      if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
        player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
      }
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));

      if (player.queue.length <= 6) {
        player.boosting = false;
        return;
      }

      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 6) {
          const droppedSegment = player.queue[player.queue.length - 1];
          const pos = clampPosition(droppedSegment.x, droppedSegment.y);
          const r = randomItemRadius();
          const value = getItemValue(r);
          const droppedItem = {
            id: `dropped-${Date.now()}`,
            x: pos.x,
            y: pos.y,
            value: value,
            color: droppedSegment.color,
            owner: socket.id,
            radius: r,
            dropTime: Date.now()
          };
          roomsData[roomId].items.push(droppedItem);
          io.to(roomId).emit("update_items", roomsData[roomId].items);
          player.queue.pop();
          if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
            player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
          } else {
            clearInterval(player.boostInterval);
            player.boosting = false;
          }
          io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
          io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
        }
      }, BOOST_INTERVAL_MS);

      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on("boostStop", () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.boosting) {
        clearInterval(player.boostInterval);
        player.boosting = false;
        io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
      }
    });

    socket.on("player_eliminated", (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (player) {
        dropQueueItems(player, roomId);
        updateGlobalLeaderboard(socket.id, player.itemEatenCount, player.pseudo || "Anonyme");
      }
      delete roomsData[roomId].players[socket.id];
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });

    socket.on("disconnect", async (reason) => {
      if (roomsData[roomId]?.players[socket.id]) {
        const player = roomsData[roomId].players[socket.id];
        dropQueueItems(player, roomId);
        updateGlobalLeaderboard(socket.id, player.itemEatenCount, player.pseudo || "Anonyme");
        delete roomsData[roomId].players[socket.id];
      }
      await leaveRoom(roomId);
      io.to(roomId).emit("update_players", getPlayersForUpdate(roomsData[roomId].players));
    });
  })();
});

// Boucle de mise à jour du jeu : recalcul de la queue et application du pattern de skin (20 couleurs)
setInterval(() => {
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];
    const playerIds = Object.keys(room.players);
    const playersToEliminate = new Set();

    // Collision entre joueurs
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const id1 = playerIds[i], id2 = playerIds[j];
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
        updateGlobalLeaderboard(id, room.players[id].itemEatenCount, room.players[id].pseudo || "Anonyme");
        delete room.players[id];
      }
    });

    // Mise à jour de la queue pour chaque joueur
    Object.entries(room.players).forEach(([id, player]) => {
      if (!player.direction) return;
      player.positionHistory.push({ x: player.x, y: player.y, time: Date.now() });
      if (player.positionHistory.length > 5000) {
        player.positionHistory.shift();
      }
      const skinColors = player.skinColors || getDefaultSkinColors();
      const colors = (Array.isArray(skinColors) && skinColors.length >= 20)
        ? skinColors
        : getDefaultSkinColors();
      const tailSpacing = getHeadRadius(player) * 0.2;
      const desiredSegments = Math.max(6, Math.floor(player.itemEatenCount / 3));
      const newQueue = [];
      for (let i = 0; i < desiredSegments; i++) {
        const targetDistance = (i + 1) * tailSpacing;
        const posAtDistance = getPositionAtDistance(player.positionHistory, targetDistance);
        // Cycle sur les 20 couleurs (la tête étant colors[0])
        const segmentColor = colors[i % 20];
        newQueue.push({ x: posAtDistance.x, y: posAtDistance.y, color: segmentColor });
      }
      player.queue = newQueue;
      player.color = colors[0];

      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      player.x += player.direction.x * speed;
      player.y += player.direction.y * speed;
      const circles = getPlayerCircles(player);
      for (const c of circles) {
        if (
          c.x - c.radius < 0 ||
          c.x + c.radius > worldSize.width ||
          c.y - c.radius < 0 ||
          c.y + c.radius > worldSize.height
        ) {
          io.to(id).emit("player_eliminated", { eliminatedBy: "boundary" });
          dropQueueItems(player, roomId);
          updateGlobalLeaderboard(id, player.itemEatenCount, player.pseudo || "Anonyme");
          delete room.players[id];
          return;
        }
      }
      const headCircle = { x: player.x, y: player.y, radius: getHeadRadius(player) };
      for (let i = 0; i < room.items.length; i++) {
        const item = room.items[i];
        const itemCircle = { x: item.x, y: item.y, radius: item.radius };
        if (item.owner && item.owner === id) {
          if (Date.now() - item.dropTime < 500) continue;
        }
        if (circlesCollide(headCircle, itemCircle)) {
          const oldQueueLength = player.queue.length;
          player.itemEatenCount += item.value;
          const targetQueueLength = Math.max(6, Math.floor(player.itemEatenCount / 3));
          const segmentsToAdd = targetQueueLength - oldQueueLength;
          for (let j = 0; j < segmentsToAdd; j++) {
            if (player.queue.length === 0) {
              player.queue.push({ x: player.x, y: player.y, color: colors[1] });
            } else {
              const lastSeg = player.queue[player.queue.length - 1];
              player.queue.push({ x: lastSeg.x, y: lastSeg.y, color: lastSeg.color });
            }
          }
          room.items.splice(i, 1);
          i--;
          if (room.items.length < MAX_ITEMS) {
            const r = randomItemRadius();
            const value = getItemValue(r);
            const newItem = {
              id: `item-${Date.now()}`,
              x: BOUNDARY_MARGIN + Math.random() * (worldSize.width - 2 * BOUNDARY_MARGIN),
              y: BOUNDARY_MARGIN + Math.random() * (worldSize.height - 2 * BOUNDARY_MARGIN),
              value: value,
              color: itemColors[Math.floor(Math.random() * itemColors.length)],
              radius: r
            };
            room.items.push(newItem);
          }
          io.to(roomId).emit("update_items", room.items);
          break;
        }
      }
    });

    const sortedPlayers = Object.entries(room.players)
      .sort(([, a], [, b]) => b.itemEatenCount - a.itemEatenCount);
    const top10 = sortedPlayers.slice(0, 10).map(([id, player]) => ({
      id,
      pseudo: player.pseudo || "Anonyme",
      score: player.itemEatenCount,
      color: player.color
    }));
    io.to(roomId).emit("update_room_leaderboard", top10);
    io.to(roomId).emit("update_players", getPlayersForUpdate(room.players));
  });
}, 16);

app.get("/", (req, res) => {
  res.send("Hello from the Snake.io-like server!");
});

app.get("/globalLeaderboard", async (req, res) => {
  const { data, error } = await supabase
    .from("global_leaderboard")
    .select("*")
    .order("score", { ascending: false })
    .limit(10);
  if (error) {
    console.error("Erreur lors de la récupération du leaderboard global :", error);
    return res.status(500).send(error);
  }
  res.json(data);
});

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
