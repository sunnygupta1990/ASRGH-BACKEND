// backened/src/server.ts

import "dotenv/config";
import express from "express";
import photosRouter from "./routes/photos";
import { createApp } from "./app";

const app = createApp(photosRouter);
const PORT = Number(process.env.PORT) || 4000;

app.use("/media/images", express.static("storage/images"));
app.use("/media/thumbnails", express.static("storage/thumbnails"));

app.listen(PORT, () => {
  console.log(`ASRGH API running on http://localhost:${PORT}`);
});
