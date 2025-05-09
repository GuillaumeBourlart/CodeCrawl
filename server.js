import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

//import { createAdapter } from "@socket.io/cluster-adapter";
//import { setupWorker } from "@socket.io/sticky";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const { SUPABASE_URL = "", SUPABASE_SERVICE_KEY = "", PORT = 3000 } = process.env;
console.log("SUPABASE_URL:", SUPABASE_URL);
console.log("SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "<non-empty>" : "<EMPTY>");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.use(cors({ origin: "*" }));
app.options("*", cors());
app.use(express.json());


const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ——— Sticky sessions & cluster-adapter ———
//io.adapter(createAdapter());    // diffuse les rooms entre workers
//setupWorker(io);                // rattache ce worker au Primary


const skinCache = {};
const scoreUpdates = {};  // clé : id du joueur, valeur : { pseudo, score }


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
const worldSize = { width: 4000, height: 4000 };
const cellSize = 400;  // Taille d'une cellule pour la grille spatiale

const MIN_ITEM_RADIUS = 4;
const MAX_ITEM_RADIUS = 10;
const BASE_SIZE = 20; // Taille de base d'un cercle
const MAX_ITEMS = 400;
const SPEED_NORMAL = 3.2;
const SPEED_BOOST = 6.4;
const BOUNDARY_MARGIN = 100;
const BOOST_ITEM_COST = 4;
const BOOST_INTERVAL_MS = 250;
const BOOST_DISTANCE_FACTOR = 1;
const SAMPLING_STEP = 1;
const VIEW_WIDTH = 1920;
const VIEW_HEIGHT = 1080;
const MAX_HISTORY_LENGTH = 1000;  // Limite pour la positionHistory

// Au lieu de DEFAULT_ITEM_EATEN_COUNT = 18 (6 segments * 3 items)
const ITEMS_PER_SEGMENT   = 4;    // 4 items pour gagner un segment
const INITIAL_SEGMENTS    = 10;   // on démarre avec 10 segments
const DEFAULT_ITEM_EATEN_COUNT = ITEMS_PER_SEGMENT * INITIAL_SEGMENTS; // = 40

const HEAD_GROWTH_FACTOR  = 0.02; // avant c'était 0.05

// --- Fonctions utilitaires ---
function clampPosition(x, y, margin = BOUNDARY_MARGIN) {
  return {
    x: Math.min(Math.max(x, margin), worldSize.width - margin),
    y: Math.min(Math.max(y, margin), worldSize.height - margin)
  };
}

function getCellCoordinates(x, y) {
  return {
    cellX: Math.floor(x / cellSize),
    cellY: Math.floor(y / cellSize)
  };
}

// Fonction pour supprimer les données d'un utilisateur
async function deleteUserAccount(userId) {
  try {
    // 1. Supprimer toutes les lignes dans "user_skins" où "id" est égal à l'utilisateur
    let { data: userSkinsData, error: userSkinsError } = await supabase
      .from("user_skins")
      .delete()
      .eq("user_id", userId);
    if (userSkinsError) {
      console.error("Erreur lors de la suppression dans user_skins:", userSkinsError);
      throw userSkinsError;
    }
    
    // 3. Supprimer la ligne dans "profiles" où "id" est égal à l'utilisateur
    let { data: profilesData, error: profilesError } = await supabase
      .from("profiles")
      .delete()
      .eq("id", userId);
    if (profilesError) {
      console.error("Erreur lors de la suppression dans profiles:", profilesError);
      throw profilesError;
    }
    
    console.log(`Toutes les données de l'utilisateur ${userId} ont été supprimées.`);
    return { success: true };
  } catch (err) {
    console.error("Erreur lors de la suppression du compte utilisateur:", err);
    return { success: false, error: err };
  }
}

function updateTail(player) {
  const colors = (player.skinColors?.length >= 20) 
    ? player.skinColors 
    : getDefaultSkinColors();
  const spacing = getHeadRadius(player) * 0.3;     // espacement désiré
  const targetCount = Math.max(
  INITIAL_SEGMENTS,
  Math.floor(player.itemEatenCount / ITEMS_PER_SEGMENT)
);

  
  const newQueue = [];
  // on part de la tête
  let prev = { x: player.x, y: player.y };

  for (let i = 0; i < targetCount; i++) {
    // récupère l’ancienne position de ce segment ou se caler sur prev
    const old = player.queue[i] || prev;
    const dx = prev.x - old.x;
    const dy = prev.y - old.y;
    const dist = Math.hypot(dx, dy) || spacing;
    // calcule l’unité de direction
    const ux = dx / dist;
    const uy = dy / dist;
    // positionne le segment exactement à “spacing” de prev
    const segX = prev.x - ux * spacing;
    const segY = prev.y - uy * spacing;
    newQueue.push({ x: segX, y: segY, color: colors[i % 20] });
    prev = { x: segX, y: segY };
  }

  player.queue = newQueue;
}


// Route PUT pour mettre à jour uniquement le pseudo et le default_skin_id
// On attend dans le body un objet JSON contenant { userId, pseudo, skin_id }
app.put("/updateProfile", async (req, res) => {
  const { userId, pseudo, skin_id } = req.body;

  // Vérifier que le userId est présent
  if (!userId) {
    return res.status(400).json({ success: false, message: "Le champ userId est requis" });
  }

  // Vérifier qu'au moins un des deux champs à mettre à jour est présent
  if (typeof pseudo === 'undefined' && typeof skin_id === 'undefined') {
    return res.status(400).json({ 
      success: false, 
      message: "Au moins un des champs 'pseudo' ou 'skin_id' est requis" 
    });
  }

  // Construire dynamiquement l'objet de mise à jour
  const allowedData = {};
  if (typeof pseudo !== 'undefined') {
    allowedData.pseudo = pseudo;
  }
  if (typeof skin_id !== 'undefined') {
    allowedData.default_skin_id = skin_id;
  }

  // Exécuter la mise à jour dans la table 'profiles'
  const { data, error } = await supabase
    .from("profiles")
    .update(allowedData)
    .eq("id", userId);

  if (error) {
    console.error("Erreur lors de la mise à jour du profil:", error);
    return res.status(500).json({ success: false, message: "Erreur lors de la mise à jour du profil", error });
  }

  console.log(`Profil mis à jour pour l'utilisateur ${userId}:`, allowedData);
  res.json({ success: true, data });
});

// Route DELETE pour la suppression du compte utilisateur
app.delete("/deleteAccount", async (req, res) => {
  // Pour la démonstration, on attend un userId dans le body de la requête (en production, utilisez une authentification)
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: "userId manquant" });
  }

  // Ici, pensez à vérifier que le userId correspond bien à l'utilisateur authentifié (votre logique d'authentification)
  
  const result = await deleteUserAccount(userId);
  if (result.success) {
    res.json({ success: true, message: "Compte supprimé avec succès" });
  } else {
    res.status(500).json({ success: false, message: "Erreur lors de la suppression du compte", error: result.error });
  }
});

async function getSkinDataFromDB(skin_id) {
  if (skinCache[skin_id]) return skinCache[skin_id];
  const { data, error } = await supabase
    .from("game_skins")
    .select("data")
    .eq("id", skin_id)
    .single();
  if (error || !data) {
    console.error("Erreur de récupération du skin :", error);
    return getDefaultSkinColors();
  }
  const skin = data.data;
  if (!skin || !skin.colors || skin.colors.length !== 20) {
    console.warn("Le skin récupéré ne contient pas 20 couleurs. Utilisation du skin par défaut.");
    return getDefaultSkinColors();
  }
  // Stocker dans le cache
  skinCache[skin_id] = skin.colors;
  return skin.colors;
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
  return Math.round(
    1 + ((radius - MIN_ITEM_RADIUS) / (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS)) * 5
  );
}

function randomItemRadius() {
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}

function getHeadRadius(player) {
  return BASE_SIZE / 2
    + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT)
      * HEAD_GROWTH_FACTOR;
}

function getSegmentRadius(player) {
  return BASE_SIZE / 2
    + Math.max(0, player.itemEatenCount - DEFAULT_ITEM_EATEN_COUNT)
      * HEAD_GROWTH_FACTOR;
}


function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Rééchantillonnage complet de la trajectoire
function resamplePath(positionHistory, step) {
  if (positionHistory.length === 0) return [];
  const resampled = [];
  let prev = positionHistory[0];
  resampled.push({ x: prev.x, y: prev.y });
  for (let i = 1; i < positionHistory.length; i++) {
    const curr = positionHistory[i];
    let d = distance(prev, curr);
    while (d >= step) {
      const ratio = step / d;
      const newX = prev.x + ratio * (curr.x - prev.x);
      const newY = prev.y + ratio * (curr.y - prev.y);
      resampled.push({ x: newX, y: newY });
      prev = { x: newX, y: newY };
      d = distance(prev, curr);
    }
    prev = curr;
  }
  return resampled;
}

function getPositionAtDistance(positionHistory, targetDistance) {
  let totalDistance = 0;
  for (let i = positionHistory.length - 1; i > 0; i--) {
    const curr = positionHistory[i];
    const prev = positionHistory[i - 1];
    const segmentDistance = distance(curr, prev);
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
  return distance(circ1, circ2) < (circ1.radius + circ2.radius);
}

// Gestion des items : drops / génération
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
  const { error } = await supabase
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
    .limit(1000);
  if (selectError) {
    console.error("Erreur lors de la récupération du leaderboard pour le nettoyage:", selectError);
    return;
  }
  if (leaderboardData.length === 1000) {
    const threshold = leaderboardData[leaderboardData.length - 1].score;
    const { error: deleteError } = await supabase
      .from("global_leaderboard")
      .delete()
      .lt("score", threshold);
    if (deleteError) {
      console.error("Erreur lors du nettoyage du leaderboard global:", deleteError);
    }
  }
}

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
  let room = (existingRooms && existingRooms.length > 0) ? existingRooms[0] : null;
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

  // 1) on récupère, sans erreur si aucune ligne
  const { data, error } = await supabase
    .from("rooms")
    .select("current_players")
    .eq("id", roomId)
    .maybeSingle();      // ← passe de .single() à .maybeSingle()

  if (error) {
    console.error("Erreur lecture room (leaveRoom):", error);
    return;
  }
  if (!data) {
    // pas de ligne, la room a déjà été supprimée → on sort
    return;
  }

  const newCount = Math.max(0, data.current_players - 1);

  if (newCount === 0) {
    // 2a) plus personne, on supprime la row
    await supabase
      .from("rooms")
      .delete()
      .eq("id", roomId);
  } else {
    // 2b) on décrémente simplement
    await supabase
      .from("rooms")
      .update({ current_players: newCount })
      .eq("id", roomId);
  }
}

// Filtrage des entités visibles pour l'envoi aux clients
function getVisibleItemsForPlayer(player, allItems) {
  const halfW = VIEW_WIDTH / 2;
  const halfH = VIEW_HEIGHT / 2;
  const minX = player.x - halfW;
  const maxX = player.x + halfW;
  const minY = player.y - halfH;
  const maxY = player.y + halfH;
  return allItems.filter(item =>
    item.x >= minX && item.x <= maxX &&
    item.y >= minY && item.y <= maxY
  );
}

function getVisiblePlayersForPlayer(player, allPlayers) {
  const halfW = VIEW_WIDTH / 2;
  const halfH = VIEW_HEIGHT / 2;
  const minX = player.x - halfW;
  const maxX = player.x + halfW;
  const minY = player.y - halfH;
  const maxY = player.y + halfH;
  const result = {};
  Object.entries(allPlayers).forEach(([pid, otherPlayer]) => {
    if (otherPlayer.isSpectator) return;
    const headIsVisible =
      otherPlayer.x >= minX && otherPlayer.x <= maxX &&
      otherPlayer.y >= minY && otherPlayer.y <= maxY;
    const filteredQueue = otherPlayer.queue.filter(seg =>
      seg.x >= minX && seg.x <= maxX &&
      seg.y >= minY && seg.y <= maxY
    );
    if (headIsVisible || filteredQueue.length > 0) {
      result[pid] = {
        x: otherPlayer.x,
        y: otherPlayer.y,
        pseudo: otherPlayer.pseudo,
        color: otherPlayer.color,
        itemEatenCount: otherPlayer.itemEatenCount,
        boosting: otherPlayer.boosting,
        direction: otherPlayer.direction,
        skin_id: otherPlayer.skin_id,
        headVisible: headIsVisible,
        queue: filteredQueue,
      };
    }
  });
  return result;
}

// --------------------------------------------------------------
// Gestion de la connexion Socket.IO
io.on("connection", (socket) => {
  console.log("Nouveau client connecté:", socket.id);

  // répond à un ping_test et renvoie tout de suite un ACK
socket.on("ping_test", (_data, ack) => {
  // ack() envoie la réponse immédiatement
  ack();
});

  
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
    roomsData[roomId].players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      length: BASE_SIZE,
      positionHistory: [],
      direction: defaultDirection,
      boosting: false,
      color: null,
      pseudo: null,
      isSpectator: false,
      skin_id: null,
      itemEatenCount: DEFAULT_ITEM_EATEN_COUNT,
      queue: Array(INITIAL_SEGMENTS)
  .fill(null)
  .map(() => ({ x: Math.random() * 800, y: Math.random() * 600 }))
    };
    console.log(`Initialisation du joueur ${socket.id} dans la room ${roomId}`);
    socket.join(roomId);
    socket.emit("joined_room", { roomId });
    
    // Événement pour définir les infos du joueur
    socket.on("setPlayerInfo", async (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (player && data.pseudo && data.skin_id) {
        player.pseudo = data.pseudo;
        player.skin_id = data.skin_id;
        const skinColors = await getSkinDataFromDB(player.skin_id);
        player.skinColors = skinColors;
        player.color = skinColors[0];
      }
      console.log(`Infos définies pour ${socket.id}:`, data);
    });
    
    // Changement de direction
    socket.on("changeDirection", (data) => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      const { x, y } = data.direction;
      const mag2 = Math.sqrt(x * x + y * y) || 1;
      let newDir = { x: x / mag2, y: y / mag2 };
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
    });
    
    // Boost
    socket.on("boostStart", () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.queue.length <= 6) return;
      if (player.boosting) return;
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
      if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
        player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
      }
      if (player.queue.length <= 6) {
        player.boosting = false;
        return;
      }
      player.boosting = true;
      player.boostInterval = setInterval(() => {
        if (player.queue.length > 6) {
          const lastSeg = player.queue[player.queue.length - 1];
          const pos2 = clampPosition(lastSeg.x, lastSeg.y);
          const r2 = randomItemRadius();
          const value2 = getItemValue(r2);
          const droppedItem2 = {
            id: `dropped-${Date.now()}`,
            x: pos2.x,
            y: pos2.y,
            value: value2,
            color: lastSeg.color,
            owner: socket.id,
            radius: r2,
            dropTime: Date.now()
          };
          roomsData[roomId].items.push(droppedItem2);
          player.queue.pop();
          if (player.itemEatenCount > DEFAULT_ITEM_EATEN_COUNT) {
            player.itemEatenCount = Math.max(DEFAULT_ITEM_EATEN_COUNT, player.itemEatenCount - BOOST_ITEM_COST);
          } else {
            clearInterval(player.boostInterval);
            player.boosting = false;
          }
        } else {
          clearInterval(player.boostInterval);
          player.boosting = false;
        }
      }, BOOST_INTERVAL_MS);
    });
    
    socket.on("boostStop", () => {
      const player = roomsData[roomId].players[socket.id];
      if (!player) return;
      if (player.boosting) {
        clearInterval(player.boostInterval);
        player.boosting = false;
      }
    });
    
    // Déconnexion
    socket.on("disconnect", async () => {
      const player = roomsData[roomId]?.players[socket.id];
      if (player) {
        if (player.boostInterval) {
          clearInterval(player.boostInterval);
          player.boostInterval = null;
        }
        dropQueueItems(player, roomId);
        scoreUpdates[socket.id] = {
          pseudo: player.pseudo || "Anonyme",
          score: player.itemEatenCount
        };
        delete roomsData[roomId].players[socket.id];
        // si plus aucun joueur dans la room en mémoire
if (roomsData[roomId] && Object.keys(roomsData[roomId].players).length === 0) {
  delete roomsData[roomId];
  // et, si vous voulez vider la table SQL aussi :
  await supabase.from("rooms").delete().eq("id", roomId);
}

      }
      await leaveRoom(roomId);
    });
    
  })();
});

// Intervalle de mise à jour groupée du leaderboard
setInterval(async () => {
  //console.time("leaderboardUpdate");
  const updates = Object.entries(scoreUpdates).map(([id, data]) => ({ id, ...data }));
  if (updates.length > 0) {
    const { error } = await supabase.from("global_leaderboard").upsert(updates);
    if (error) {
      console.error("Erreur lors de la mise à jour groupée du leaderboard:", error);
    }
    Object.keys(scoreUpdates).forEach(key => delete scoreUpdates[key]);
  }
  //console.timeEnd("leaderboardUpdate");
}, 10000);  // Toutes les 10 000ms (10 secondes)

// --------------------------------------------------------------
// Boucle principale de mise à jour du jeu : collisions, trajectoire & queue
setInterval(() => {
 //console.time("gameLoop");
  Object.keys(roomsData).forEach(roomId => {
    const room = roomsData[roomId];
    const playerIds = Object.keys(room.players);
    
    // --- Regroupement des joueurs dans une grille spatiale ---
    const grid = {};
    playerIds.forEach(pid => {
      const player = room.players[pid];
      if (!player) return;
      const { cellX, cellY } = getCellCoordinates(player.x, player.y);
      const key = `${cellX}-${cellY}`;
      if (!grid[key]) grid[key] = [];
      grid[key].push({ id: pid, player });
    });
    
    // --- Détection de collisions grâce à la grille ---
    const directions = [
      { dx: 0, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
      { dx: 1, dy: 1 },
      { dx: -1, dy: -1 },
      { dx: 1, dy: -1 },
      { dx: -1, dy: 1 }
    ];
    const playersToEliminate = new Set();
    
    // Pour chaque cellule de la grille, comparer les joueurs dans la cellule et ses voisines
    Object.keys(grid).forEach(cellKey => {
      const [cellX, cellY] = cellKey.split("-").map(Number);
      let nearbyPlayers = [];
      directions.forEach(({ dx, dy }) => {
        const neighborKey = `${cellX + dx}-${cellY + dy}`;
        if (grid[neighborKey]) {
          nearbyPlayers = nearbyPlayers.concat(grid[neighborKey]);
        }
      });
      // Tester les collisions entre chaque paire dans nearbyPlayers
      for (let i = 0; i < nearbyPlayers.length; i++) {
        for (let j = i + 1; j < nearbyPlayers.length; j++) {
          const p1 = nearbyPlayers[i].player;
          const p2 = nearbyPlayers[j].player;
          if (p1.isSpectator || p2.isSpectator) continue;
          const id1 = nearbyPlayers[i].id;
          const id2 = nearbyPlayers[j].id;
          const head1 = { x: p1.x, y: p1.y, radius: getHeadRadius(p1) };
          const head2 = { x: p2.x, y: p2.y, radius: getHeadRadius(p2) };
          if (circlesCollide(head1, head2)) {
            playersToEliminate.add(id1);
            playersToEliminate.add(id2);
            continue;
          }
          // Tête de p1 vs queue de p2
          for (const segment of p2.queue) {
            const segmentCircle = { x: segment.x, y: segment.y, radius: getSegmentRadius(p2) };
            if (circlesCollide(head1, segmentCircle)) {
              playersToEliminate.add(id1);
              break;
            }
          }
          // Tête de p2 vs queue de p1
          for (const segment of p1.queue) {
            const segmentCircle = { x: segment.x, y: segment.y, radius: getSegmentRadius(p1) };
            if (circlesCollide(head2, segmentCircle)) {
              playersToEliminate.add(id2);
              break;
            }
          }
        }
      }
    });
    
    // Traitement des joueurs à éliminer suite aux collisions
    playersToEliminate.forEach(id => {
      io.to(id).emit("player_eliminated", { eliminatedBy: "collision" });
      const p = room.players[id];
      if (!p) return;
      dropQueueItems(p, roomId);
      scoreUpdates[id] = {
        pseudo: p.pseudo || "Anonyme",
        score: p.itemEatenCount
      };
      p.isSpectator = true;
      p.queue = [];
      p.positionHistory = [];
    });
    
    // --- Mise à jour de la trajectoire et reconstruction de la queue ---
    Object.entries(room.players).forEach(([id, player]) => {
      if (player.isSpectator || !player.direction) return;
      
      // 1) Ajout de la position actuelle dans la positionHistory
      player.positionHistory.push({ x: player.x, y: player.y });
      if (player.positionHistory.length > MAX_HISTORY_LENGTH) {
        player.positionHistory.shift();
      }
      
      // 2) Calcul de la nouvelle position de la tête
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      const newX = player.x + player.direction.x * speed;
      const newY = player.y + player.direction.y * speed;
      
      // 3) Ajout de la nouvelle position dans la positionHistory et mise à jour des coordonnées
      player.positionHistory.push({ x: newX, y: newY });
      if (player.positionHistory.length > MAX_HISTORY_LENGTH) {
        player.positionHistory.shift();
      }
      player.x = newX;
      player.y = newY;
      
      // 4) Rééchantillonnage de la trajectoire pour obtenir un chemin uniformisé
      //const uniformHistory = resamplePath(player.positionHistory, SAMPLING_STEP);
      // 4) Recalcule la queue à distance fixe
      updateTail(player);
      
      // // 5) Reconstruction de la queue
      // const skinColors = player.skinColors || getDefaultSkinColors();
      // const colors = (Array.isArray(skinColors) && skinColors.length >= 20)
      //   ? skinColors
      //   : getDefaultSkinColors();
      // const tailSpacing = getHeadRadius(player) * 0.2;
      // const desiredSegments = Math.max(6, Math.floor(player.itemEatenCount / 3));
      // const newQueue = [];
      // for (let i = 0; i < desiredSegments; i++) {
      //   const targetDistance = (i + 1) * tailSpacing;
      //   //const posAtDistance = getPositionAtDistance(uniformHistory, targetDistance);
      //   const posAtDistance = getPositionAtDistance(player.positionHistory, targetDistance);

      //   const segmentColor = colors[i % 20];
      //   newQueue.push({ x: posAtDistance.x, y: posAtDistance.y, color: segmentColor });
      // }
      // player.queue = newQueue;
      // player.color = colors[0];
      
      // 6) Vérification de la sortie du monde (frontières)
      const headRadius = getHeadRadius(player);
      if (
        (player.x - headRadius < 0) ||
        (player.x + headRadius > worldSize.width) ||
        (player.y - headRadius < 0) ||
        (player.y + headRadius > worldSize.height)
      ) {
        io.to(id).emit("player_eliminated", { eliminatedBy: "boundary" });
        dropQueueItems(player, roomId);
        updateGlobalLeaderboard(id, player.itemEatenCount, player.pseudo || "Anonyme");
        player.isSpectator = true;
        player.queue = [];
        player.positionHistory = [];
        return;
      }
      
      // 7) Collision avec les items
      const headCircle = { x: player.x, y: player.y, radius: headRadius };
      for (let i = 0; i < room.items.length; i++) {
        const item = room.items[i];
        if (item.owner && item.owner === id) {
          if (Date.now() - item.dropTime < 500) continue;
        }
        const itemCircle = { x: item.x, y: item.y, radius: item.radius };
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
          break;
        }
      }
    });
    
    // Classement local (top 10)
    const sortedPlayers = Object.entries(room.players)
      .sort(([, a], [, b]) => b.itemEatenCount - a.itemEatenCount);
    const top10 = sortedPlayers.slice(0, 10).map(([id, player]) => ({
      id,
      pseudo: player.pseudo || "Anonyme",
      score: player.itemEatenCount,
      color: player.color
    }));
    
    // Envoi des entités visibles à chaque joueur
    for (const pid of Object.keys(room.players)) {
      const viewingPlayer = room.players[pid];
      const visibleItems = getVisibleItemsForPlayer(viewingPlayer, room.items);
      const visiblePlayers = getVisiblePlayersForPlayer(viewingPlayer, room.players);
      const now = Date.now();
      io.to(pid).emit("update_entities", {
        players: visiblePlayers,
        items: visibleItems,
        leaderboard: top10,
        serverTs: now
      });
      
    }
  });
   //console.timeEnd("gameLoop");
}, 16);

// Routes HTTP de base
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
  console.log(`Serveur worker ${process.pid} à l’écoute sur le port ${PORT}`);
});
