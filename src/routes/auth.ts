// backened/src/routes/auth.ts

import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";

const router = Router();

const loginSchema = z.object({
  identifier: z.string().trim().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(1),
}).refine((value) => Boolean(value.identifier || value.email), {
  message: "Identifier or email is required",
});

router.post("/login", async (req, res) => {
  try {
    const prisma = req.prisma;
    const data = loginSchema.parse(req.body);
    const identifier = data.identifier ?? data.email!;
    const password = data.password;
    const normalizedEmail = identifier.trim().toLowerCase();
    const normalizedEmployeeId = identifier.trim().toUpperCase();

    const user = await prisma.adminUser.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { employeeId: normalizedEmployeeId },
        ],
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
        message: "Invalid user ID or password",
      });
    }

    if (user.status === "blocked") {
      return res.status(403).json({
        success: false,
        message: "This account is blocked. Contact the Super Admin.",
      });
    }

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "This account is not active.",
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      const failedLoginAttempts = user.failedLoginAttempts + 1;
      const shouldBlock = failedLoginAttempts >= 3;
      const failedAt = new Date();

      await prisma.adminUser.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts,
          lastFailedLoginAt: failedAt,
          blockedAt: shouldBlock ? failedAt : null,
          status: shouldBlock ? "blocked" : "active",
        },
      });

      return res.status(shouldBlock ? 403 : 401).json({
        success: false,
        message: shouldBlock
          ? "Account blocked after 3 unsuccessful login attempts. Contact the Super Admin."
          : "Invalid user ID or password",
        failedAttempts: failedLoginAttempts,
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        organizationId: user.organizationId,
      },
      process.env.JWT_SECRET!,
      {
        expiresIn: "8h",
      },
    );

    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
        lastFailedLoginAt: null,
        blockedAt: null,
      },
    });

    const activeRoles = user.roles
      .map(({ role }) => role)
      .filter(
        (role) =>
          role.isActive &&
          role.organizationId === user.organizationId,
      );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        employeeId: user.employeeId,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        lastLoginAt: new Date().toISOString(),
        roleId: activeRoles[0]?.id ?? null,
        roleName: activeRoles[0]?.name ?? "No active role",
        roles: activeRoles.map((role) => ({
          id: role.id,
          name: role.name,
          isSystemRole: role.isSystemRole,
        })),
        permissions: [
          ...new Set(
            activeRoles.flatMap((role) =>
              role.permissions.map(({ permission }) => permission.code),
            ),
          ),
        ],
        isSystemRole: activeRoles.some((role) => role.isSystemRole),
      },
    });
  } catch {
    return res.status(400).json({
      success: false,
      message: "Invalid login request",
    });
  }
});

export default router;
