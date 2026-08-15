// backened/src/app.ts

import express, { Router } from "express";
import cors from "cors";
import helmet from "helmet";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
import membersRouter from "./routes/members";
import eventsRouter from "./routes/events";

export function createApp(photosRouter: Router) {
  const app = express();

  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  app.use(
    helmet({
      crossOriginResourcePolicy: {
        policy: "cross-origin",
      },
    }),
  );

  const allowedOrigins = (
    process.env.CORS_ORIGINS ?? "http://localhost:5173"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error("Origin not allowed by CORS"));
      },
    }),
  );

  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      success: true,
      message: "ASRGH API is running",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/members", membersRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api", photosRouter);

  return app;
}
