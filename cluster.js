// cluster.js
import cluster from "cluster";
import { createServer } from "http";
import os from "os";

// charge les variables depuis .env
import dotenv from "dotenv";

// sticky-sessions & cluster-adapter
import { setupMaster, setupWorker } from "@socket.io/sticky";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";

dotenv.config();
const PORT = process.env.PORT || 3000;
const numCPUs = os.cpus().length;

if (cluster.isPrimary) {
  console.log(`🔧 Primary ${process.pid} is running`);

  // 1) Création d’un HTTP server "nu"
  const httpServer = createServer();

  // 2) Activation du sticky‐load‐balancing
  //    route chaque session Socket.IO (sid) vers le même worker
  setupMaster(httpServer, {
    loadBalancingMethod: "least-connection", // ou "round-robin"/"random"
  });  // :contentReference[oaicite:0]{index=0}

  // 3) Pour que createAdapter() fonctionne entre workers
  setupPrimary();  // :contentReference[oaicite:1]{index=1}

  // 4) On écoute sur le port une seule fois, c’est le Primary qui accepte les TCP
  httpServer.listen(PORT, () => {
    console.log(`✅ Primary listening on port ${PORT}`);
  });

  // 5) Fork des workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // 6) Auto‐relaunch
  cluster.on("exit", (worker) => {
    console.log(`⚠️ Worker ${worker.process.pid} died, forking a new one`);
    cluster.fork();
  });

} else {
  console.log(`🚀 Worker ${process.pid} started`);
  // Le worker importe / démarre votre serveur Socket.IO
  import("./server.js")
    .then(() => console.log(`Worker ${process.pid} ready`))
    .catch((err) => {
      console.error("Failed to start server in worker:", err);
      process.exit(1);
    });
}

