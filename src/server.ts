// backened/src/server.ts

import "dotenv/config";
import express from "express";
import photosRouter from "./routes/photos";
import { createApp } from "./app";
import { createPrismaClient, disconnectPrisma } from "./config/prisma";

const app = createApp(
  createPrismaClient,
  photosRouter,
);

const PORT = Number(process.env.PORT) || 4000;

app.use("/media/images", express.static("storage/images"));
app.use("/media/thumbnails", express.static("storage/thumbnails"));

app.listen(PORT, () => {
  console.log(`ASRGH API running on http://localhost:${PORT}`);
});

const shutdown = async () => {
  await disconnectPrisma();
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});