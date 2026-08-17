// backened/src/app.ts

import express, { Router } from "express";
import cors from "cors";
import helmet from "helmet";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
import membersRouter from "./routes/members";
import eventsRouter from "./routes/events";
import adminPortalRouter from "./routes/adminPortal";
import publicRouter from "./routes/public";
import adminOperationsRouter from "./routes/adminOperations";
import managementRouter from "./routes/management";
import { AppPrisma } from "./config/prisma";

export type PrismaProvider = () => AppPrisma;

export function createApp(
  getPrisma: PrismaProvider,
  photosRouter: Router,
) {
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

  // Bulk import rows are revalidated server-side and capped by the import route.
  app.use(express.json({ limit: "5mb" }));

  app.use((req, _res, next) => {
    (req as RequestWithPrisma).prisma = getPrisma();
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      success: true,
      message: "ASRGH API is running",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/admin/portal", adminPortalRouter);
  app.use("/api/admin/operations", adminOperationsRouter);
  app.use("/api/admin/management", managementRouter);
  app.use("/api/members", membersRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/public", publicRouter);
  app.use("/api", photosRouter);

  return app;
}

interface RequestWithPrisma extends express.Request {
  prisma: AppPrisma;
}
