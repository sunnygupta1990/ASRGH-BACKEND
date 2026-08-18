// backened/src/routes/admin.ts

import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";
import { PERMISSIONS, requirePermission } from "../auth/permissions";

const router = Router();

router.get(
  "/me",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = await req.prisma.adminUser.findUnique({
      where: { id: req.user!.userId },
      include: {
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Admin user not found",
      });
    }

    const activeRoles = user.roles
      .map(({ role }) => role)
      .filter((role) => role.isActive && role.organizationId === req.user!.organizationId);

    return res.json({
      success: true,
      user: {
        id: user.id,
        employeeId: user.employeeId,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        lastLoginAt: user.lastLoginAt,
        roleId: activeRoles[0]?.id ?? null,
        roleName: activeRoles[0]?.name ?? "No active role",
        roles: activeRoles.map((role) => ({ id: role.id, name: role.name, isSystemRole: role.isSystemRole })),
        permissions: [...new Set(activeRoles.flatMap((role) => role.permissions.map(({ permission }) => permission.code)))],
        isSystemRole: activeRoles.some((role) => role.isSystemRole),
      },
    });
  },
);

router.get(
  "/permissions",
  requireAuth,
  requirePermission(PERMISSIONS.dashboardRead),
  (req, res) => res.json({
    success: true,
    data: {
      isSystemRole: req.authorization!.isSystemRole,
      roleIds: req.authorization!.roleIds,
      roleNames: req.authorization!.roleNames,
      permissions: [...req.authorization!.permissions],
    },
  }),
);

export default router;
