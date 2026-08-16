// backened/src/middleware/requireAuth.ts

import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AppPrisma } from "../config/prisma";

declare global {
  namespace Express {
    interface Request {
      prisma: AppPrisma;
      user?: {
        userId: string;
        organizationId: string;
      };
    }
  }
}

export type AuthenticatedRequest = Request;

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const token = authorization.slice(7);

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET!,
    ) as {
      userId: string;
      organizationId: string;
    };

    req.user = payload;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}