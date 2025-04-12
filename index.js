// -----------------------------------------------
// Boucle de mise à jour du jeu : collisions, trajectoire & queue
// Avec resampling complet (solution ultime côté serveur)
// -----------------------------------------------
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
        // collision tête / queue
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
      const p = room.players[id];
      if (!p) return;
      dropQueueItems(p, roomId);
      updateGlobalLeaderboard(id, p.itemEatenCount, p.pseudo || "Anonyme");
      p.isSpectator = true;
      p.queue = [];
      p.positionHistory = [];
    });

    // Mise à jour des joueurs : trajectoire et queue
    Object.entries(room.players).forEach(([id, player]) => {
      if (player.isSpectator) return;
      if (!player.direction) return;

      // --- Mise à jour de la trajectoire de la tête ---
      // On définit ici la position précédente avant déplacement.
      const prevPos = (player.positionHistory.length > 0)
        ? player.positionHistory[player.positionHistory.length - 1]
        : { x: player.x, y: player.y };

      // Calcul de la nouvelle position de la tête
      const speed = player.boosting ? SPEED_BOOST : SPEED_NORMAL;
      const newX = player.x + player.direction.x * speed;
      const newY = player.y + player.direction.y * speed;

      // Calcul de la distance parcourue depuis le dernier point enregistré
      const distThisFrame = distance(prevPos, { x: newX, y: newY });

      // Commencer par ajouter la position précédente (si l'historique est vide)
      if (player.positionHistory.length === 0) {
        player.positionHistory.push({ x: prevPos.x, y: prevPos.y });
      }

      // --- Insertion de points intermédiaires via subdivision uniforme ---
      const factor = Math.ceil(distThisFrame / SAMPLING_STEP);
      if (factor > 1) {
        for (let i = 1; i < factor; i++) {
          const ratio = i / factor;
          const subX = prevPos.x + ratio * (newX - prevPos.x);
          const subY = prevPos.y + ratio * (newY - prevPos.y);
          player.positionHistory.push({ x: subX, y: subY });
        }
      }

      // Ajout de la position finale
      player.positionHistory.push({ x: newX, y: newY });
      // Mise à jour de la position de la tête
      player.x = newX;
      player.y = newY;
      if (player.positionHistory.length > 5000) {
        player.positionHistory.shift();
      }

      // Optionnel : log pour debug (attention aux volumes de log)
      // console.log(`Player ${id} - uniformized trajectory:`, resamplePath(player.positionHistory, SAMPLING_STEP));

      // --- Reconstruction de la queue ---
      // On resample toute la trajectoire pour obtenir un chemin uniformisé.
      const uniformHistory = resamplePath(player.positionHistory, SAMPLING_STEP);
      const skinColors = player.skinColors || getDefaultSkinColors();
      const colors = (Array.isArray(skinColors) && skinColors.length >= 20)
        ? skinColors
        : getDefaultSkinColors();
      const tailSpacing = getHeadRadius(player) * 0.2;
      const desiredSegments = Math.max(6, Math.floor(player.itemEatenCount / 3));
      const newQueue = [];
      for (let i = 0; i < desiredSegments; i++) {
        const targetDistance = (i + 1) * tailSpacing;
        const posAtDistance = getPositionAtDistance(uniformHistory, targetDistance);
        const segmentColor = colors[i % 20];
        newQueue.push({ x: posAtDistance.x, y: posAtDistance.y, color: segmentColor });
      }
      player.queue = newQueue;
      player.color = colors[0];

      // Vérification de la sortie du monde
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

      // --- Collision avec items ---
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

    // Envoi individuel des entités visibles
    for (const pid of Object.keys(room.players)) {
      const viewingPlayer = room.players[pid];
      const visibleItems = getVisibleItemsForPlayer(viewingPlayer, room.items);
      const visiblePlayers = getVisiblePlayersForPlayer(viewingPlayer, room.players);
      io.to(pid).emit("update_entities", {
        players: visiblePlayers,
        items: visibleItems,
        leaderboard: top10
      });
    }
  });
}, 16);

// Routes HTTP
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
