// backened/src/server.ts

import "dotenv/config";
import express from "express";
import photosRouter from "./routes/photos";
import { createApp } from "./app";
import { createPrismaClient, disconnectPrisma } from "./config/prisma";
import { getOracleObject, isOracleObjectNotFound } from "./services/oracleObjectStorage.service";

const app = createApp(
  createPrismaClient,
  photosRouter,
);

const PORT = Number(process.env.PORT) || 4000;

app.use("/media", async (req, res, next) => {
  const objectName = decodeURIComponent(req.path).replace(/^\/+/, "");
  if (!objectName) {
    next();
    return;
  }

  try {
    const object = await getOracleObject(objectName);

    if (object.contentType) {
      res.setHeader("Content-Type", object.contentType);
    }
    if (object.contentLength !== undefined) {
      res.setHeader("Content-Length", String(object.contentLength));
    }
    if (object.eTag) {
      res.setHeader("ETag", object.eTag);
    }
    if (object.lastModified) {
      res.setHeader("Last-Modified", object.lastModified.toUTCString());
    }
    res.setHeader("Cache-Control", "public, max-age=3600");

    object.body.on("error", next);
    object.body.pipe(res);
  } catch (error) {
    if (isOracleObjectNotFound(error)) {
      next();
      return;
    }

    console.error("ORACLE_MEDIA_READ_ERROR:", error);
    next(error);
  }
});

// Transitional fallback for files that were written locally before Oracle Object Storage was enabled.
app.use("/media/images", express.static("storage/images"));
app.use("/media/thumbnails", express.static("storage/thumbnails"));
app.use("/media/profiles", express.static("storage/profiles"));

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