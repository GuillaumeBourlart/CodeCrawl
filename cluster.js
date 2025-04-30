import dotenv from "dotenv";
dotenv.config();

import cluster from "cluster";
import os from "os";

if (cluster.isMaster) {
  const cpuCount = os.cpus().length;
  console.log(`Master ${process.pid} forking ${cpuCount} workers`);
  for (let i = 0; i < cpuCount; i++) {
    cluster.fork();
  }
  // relance un worker mort
  cluster.on("exit", (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died, forking new one`);
    cluster.fork();
  });
} else {
  import("./server.js")
    .then(() => console.log(`Worker ${process.pid} started server`))
    .catch(err => {
      console.error("Impossible de démarrer le serveur dans le worker :", err);
      process.exit(1);
    });
}
