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
      authorization?: {
        isSystemRole: boolean;
        roleIds: string[];
        roleNames: string[];
        permissions: Set<string>;
      };
    }
  }
}

export type AuthenticatedRequest = Request;

export async function requireAuth(
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

    const user = await req.prisma.adminUser.findFirst({
      where: {
        id: payload.userId,
        organizationId: payload.organizationId,
        status: "active",
        deletedAt: null,
      },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: { include: { permission: true } },
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired session",
      });
    }

    req.user = payload;
    const activeRoles = user.roles
      .map((assignment) => assignment.role)
      .filter((role) => role.isActive && role.organizationId === payload.organizationId);
    req.authorization = {
      isSystemRole: activeRoles.some((role) => role.isSystemRole),
      roleIds: activeRoles.map((role) => role.id),
      roleNames: activeRoles.map((role) => role.name),
      permissions: new Set(
        activeRoles.flatMap((role) =>
          role.permissions.map((relation) => relation.permission.code),
        ),
      ),
    };
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}
