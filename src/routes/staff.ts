// backened/src/routes/staff.ts

import { NextFunction, Request, Response, Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth, AuthenticatedRequest } from "../middleware/requireAuth";
import { PERMISSIONS, requirePermission } from "../auth/permissions";
import { requestAuditContext, withAudit } from "../services/audit.service";

const router = Router();

const STAFF_PERMISSION_GROUPS = {
  members: ["members.read", "members.write", "members.delete"],
  events: ["events.read", "events.write", "events.delete"],
  circular: ["announcements.read", "announcements.write", "announcements.delete"],
  helpdesk: ["contacts.read", "contacts.write"],
  notifications: ["notifications.read", "notifications.write"],
  socialWelfare: ["social_work.read", "social_work.write", "social_work.delete"],
} as const;

const allStaffPermissions = Object.values(STAFF_PERMISSION_GROUPS).flat();

const staffSchema = z.object({
  employeeId: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200).optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  addressLine1: z.string().trim().max(250).nullable().optional(),
  addressLine2: z.string().trim().max(250).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().max(100).nullable().optional(),
  designation: z.string().trim().max(150).nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  access: z.object({
    members: z.boolean().default(false),
    events: z.boolean().default(false),
    circular: z.boolean().default(false),
    helpdesk: z.boolean().default(false),
    notifications: z.boolean().default(false),
    socialWelfare: z.boolean().default(false),
  }).default({
    members: false,
    events: false,
    circular: false,
    helpdesk: false,
    notifications: false,
    socialWelfare: false,
  }),
}).strict();

function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.authorization?.isSystemRole) {
    return res.status(403).json({
      success: false,
      message: "Super Admin access required",
    });
  }

  return next();
}

function getPermissionCodes(access: z.infer<typeof staffSchema>["access"]) {
  const codes = new Set<string>(["dashboard.read"]);

  for (const [key, enabled] of Object.entries(access)) {
    if (!enabled) {
      continue;
    }

    const group = STAFF_PERMISSION_GROUPS[
      key as keyof typeof STAFF_PERMISSION_GROUPS
    ];

    for (const permission of group) {
      codes.add(permission);
    }
  }

  return [...codes];
}

function getAccessFromPermissions(permissionCodes: string[]) {
  const permissions = new Set(permissionCodes);

  return {
    members: STAFF_PERMISSION_GROUPS.members.some((code) => permissions.has(code)),
    events: STAFF_PERMISSION_GROUPS.events.some((code) => permissions.has(code)),
    circular: STAFF_PERMISSION_GROUPS.circular.some((code) => permissions.has(code)),
    helpdesk: STAFF_PERMISSION_GROUPS.helpdesk.some((code) => permissions.has(code)),
    notifications: STAFF_PERMISSION_GROUPS.notifications.some((code) => permissions.has(code)),
    socialWelfare: STAFF_PERMISSION_GROUPS.socialWelfare.some((code) => permissions.has(code)),
  };
}

function sanitizeUser(user: any) {
  const role = user.roles?.find(
    (assignment: any) => !assignment.role.isSystemRole,
  )?.role;

  const permissionCodes: string[] = [
    ...new Set<string>(
      (user.roles ?? []).flatMap((assignment: any) =>
        assignment.role.permissions.map(
          (permission: any) => permission.permission.code as string,
        ),
      ),
    ),
  ];

  return {
    id: user.id,
    employeeId: user.employeeId,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    dateOfBirth: user.dateOfBirth,
    addressLine1: user.addressLine1,
    addressLine2: user.addressLine2,
    city: user.city,
    state: user.state,
    country: user.country,
    designation: user.designation,
    status: user.status,
    failedLoginAttempts: user.failedLoginAttempts,
    lastFailedLoginAt: user.lastFailedLoginAt,
    blockedAt: user.blockedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    role: role
      ? {
          id: role.id,
          code: role.code,
          name: role.name,
        }
      : null,
    permissions: permissionCodes,
    access: getAccessFromPermissions(permissionCodes),
  };
}

async function getStaffById(req: AuthenticatedRequest, id: string) {
  return req.prisma.adminUser.findFirst({
    where: {
      id,
      organizationId: req.user!.organizationId,
      deletedAt: null,
    },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: { permission: true },
              },
            },
          },
        },
      },
    },
  });
}

async function updateStaffRole(
  tx: any,
  organizationId: string,
  staffId: string,
  employeeId: string,
  displayName: string,
  permissionCodes: string[],
) {
  const roleCode = `staff-${staffId}`;

  let role = await tx.role.findFirst({
    where: {
      organizationId,
      code: roleCode,
    },
  });

  if (!role) {
    role = await tx.role.create({
      data: {
        organizationId,
        code: roleCode,
        name: `${displayName} Staff`,
        description: `Staff access for ${employeeId}`,
        isSystemRole: false,
        isActive: true,
      },
    });
  } else {
    role = await tx.role.update({
      where: { id: role.id },
      data: {
        name: `${displayName} Staff`,
        isActive: true,
      },
    });
  }

  await tx.rolePermission.deleteMany({
    where: { roleId: role.id },
  });

  const permissions = await tx.permission.findMany({
    where: { code: { in: permissionCodes } },
  });

  if (permissions.length !== new Set(permissionCodes).size) {
    throw new Error("One or more requested permissions are unavailable");
  }

  await tx.rolePermission.createMany({
    data: permissions.map((permission: any) => ({
      roleId: role.id,
      permissionId: permission.id,
    })),
  });

  await tx.adminUserRole.deleteMany({
    where: {
      adminUserId: staffId,
      role: { isSystemRole: false },
    },
  });

  await tx.adminUserRole.create({
    data: {
      adminUserId: staffId,
      roleId: role.id,
    },
  });

  return role;
}

router.get(
  "/",
  requireAuth,
  requirePermission(PERMISSIONS.adminUsersRead),
  requireSuperAdmin,
  async (req: AuthenticatedRequest, res) => {
    const staff = await req.prisma.adminUser.findMany({
      where: {
        organizationId: req.user!.organizationId,
        deletedAt: null,
        roles: {
          some: {
            role: {
              isSystemRole: false,
              code: { startsWith: "staff-" },
            },
          },
        },
      },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
      orderBy: { displayName: "asc" },
    });

    return res.json({
      success: true,
      data: staff.map(sanitizeUser),
    });
  },
);

router.post(
  "/",
  requireAuth,
  requirePermission(PERMISSIONS.adminUsersWrite),
  requireSuperAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = staffSchema.parse(req.body);

      if (!data.password) {
        return res.status(400).json({
          success: false,
          message: "Password is required when creating staff",
        });
      }

      const employeeId = data.employeeId.trim().toUpperCase();
      const email = data.email.toLowerCase();

      const duplicate = await req.prisma.adminUser.findFirst({
        where: {
          organizationId: req.user!.organizationId,
          deletedAt: null,
          OR: [
            { employeeId },
            { email },
          ],
        },
      });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message:
            duplicate.employeeId?.toLowerCase() === employeeId.toLowerCase()
              ? "Employee ID already exists"
              : "Email already exists",
        });
      }

      const permissionCodes = getPermissionCodes(data.access);
      const passwordHash = await bcrypt.hash(data.password, 12);

      const result = await withAudit(
        req.prisma,
        requestAuditContext(req),
        async (tx) => {
          const user = await tx.adminUser.create({
            data: {
              organizationId: req.user!.organizationId,
              employeeId,
              email,
              passwordHash,
              displayName: data.displayName,
              dateOfBirth: data.dateOfBirth
                ? new Date(`${data.dateOfBirth}T00:00:00.000Z`)
                : null,
              phone: data.phone ?? null,
              addressLine1: data.addressLine1 ?? null,
              addressLine2: data.addressLine2 ?? null,
              city: data.city ?? null,
              state: data.state ?? null,
              country: data.country ?? null,
              designation: data.designation ?? null,
              status: "active",
            },
          });

          await updateStaffRole(
            tx,
            req.user!.organizationId,
            user.id,
            employeeId,
            data.displayName,
            permissionCodes,
          );

          const complete = await tx.adminUser.findUnique({
            where: { id: user.id },
            include: {
              roles: {
                include: {
                  role: {
                    include: {
                      permissions: {
                        include: { permission: true },
                      },
                    },
                  },
                },
              },
            },
          });

          return {
            result: complete,
            event: {
              action: "STAFF_CREATE",
              entityType: "admin_user",
              entityId: user.id,
              afterData: sanitizeUser(complete),
            },
          };
        },
      );

      return res.status(201).json({
        success: true,
        data: sanitizeUser(result),
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : "Unable to create staff",
      });
    }
  },
);

router.patch(
  "/:id",
  requireAuth,
  requirePermission(PERMISSIONS.adminUsersWrite),
  requireSuperAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = staffSchema.partial().parse(req.body);
      const before = await getStaffById(req, String(req.params.id));

      if (!before) {
        return res.status(404).json({
          success: false,
          message: "Staff member not found",
        });
      }

      if (
        before.roles.some(({ role }) => role.isSystemRole)
      ) {
        return res.status(403).json({
          success: false,
          message: "System administrators cannot be edited here",
        });
      }

      const employeeId = data.employeeId?.trim().toUpperCase() ?? before.employeeId;

      if (!employeeId) {
        return res.status(400).json({
          success: false,
          message: "Employee ID is required",
        });
      }

      const email = data.email?.toLowerCase() ?? before.email;

      const duplicate = await req.prisma.adminUser.findFirst({
        where: {
          organizationId: req.user!.organizationId,
          deletedAt: null,
          id: { not: before.id },
          OR: [{ employeeId }, { email }],
        },
      });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message:
            duplicate.employeeId?.toLowerCase() === employeeId.toLowerCase()
              ? "Employee ID already exists"
              : "Email already exists",
        });
      }

      const permissionCodes = data.access
        ? getPermissionCodes(data.access)
        : null;

      const result = await withAudit(
        req.prisma,
        requestAuditContext(req),
        async (tx) => {
          const updated = await tx.adminUser.update({
            where: { id: before.id },
            data: {
              employeeId,
              email,
              displayName: data.displayName,
              dateOfBirth:
                data.dateOfBirth !== undefined
                  ? data.dateOfBirth
                    ? new Date(`${data.dateOfBirth}T00:00:00.000Z`)
                    : null
                  : undefined,
              phone: data.phone,
              addressLine1: data.addressLine1,
              addressLine2: data.addressLine2,
              city: data.city,
              state: data.state,
              country: data.country,
              designation: data.designation,
              status: data.status,
              ...(data.password
                ? { passwordHash: await bcrypt.hash(data.password, 12) }
                : {}),
              ...(data.password
                ? {
                    failedLoginAttempts: 0,
                    lastFailedLoginAt: null,
                    blockedAt: null,
                  }
                : {}),
            },
          });

          if (permissionCodes) {
            await updateStaffRole(
              tx,
              req.user!.organizationId,
              updated.id,
              employeeId,
              updated.displayName,
              permissionCodes,
            );
          }

          const complete = await tx.adminUser.findUnique({
            where: { id: updated.id },
            include: {
              roles: {
                include: {
                  role: {
                    include: {
                      permissions: {
                        include: { permission: true },
                      },
                    },
                  },
                },
              },
            },
          });

          return {
            result: complete,
            event: {
              action: "STAFF_UPDATE",
              entityType: "admin_user",
              entityId: updated.id,
              beforeData: sanitizeUser(before),
              afterData: sanitizeUser(complete),
            },
          };
        },
      );

      return res.json({
        success: true,
        data: sanitizeUser(result),
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message:
          error instanceof Error ? error.message : "Unable to update staff",
      });
    }
  },
);

router.post(
  "/:id/release",
  requireAuth,
  requirePermission(PERMISSIONS.adminUsersWrite),
  requireSuperAdmin,
  async (req: AuthenticatedRequest, res) => {
    const before = await getStaffById(req, String(req.params.id));

    if (!before) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    if (before.status !== "blocked") {
      return res.status(400).json({
        success: false,
        message: "Staff account is not blocked",
      });
    }

    const result = await withAudit(
      req.prisma,
      requestAuditContext(req),
      async (tx) => {
        const updated = await tx.adminUser.update({
          where: { id: before.id },
          data: {
            status: "active",
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            blockedAt: null,
          },
          include: {
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: { permission: true },
                    },
                  },
                },
              },
            },
          },
        });

        return {
          result: updated,
          event: {
            action: "STAFF_RELEASE",
            entityType: "admin_user",
            entityId: updated.id,
            beforeData: sanitizeUser(before),
            afterData: sanitizeUser(updated),
          },
        };
      },
    );

    return res.json({
      success: true,
      data: sanitizeUser(result),
    });
  },
);

router.post(
  "/:id/reset-password",
  requireAuth,
  requirePermission(PERMISSIONS.adminUsersWrite),
  requireSuperAdmin,
  async (req: AuthenticatedRequest, res) => {
    const data = z.object({
      password: z.string().min(8).max(200),
    }).parse(req.body);

    const before = await getStaffById(req, String(req.params.id));

    if (!before) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const result = await withAudit(
      req.prisma,
      requestAuditContext(req),
      async (tx) => {
        const updated = await tx.adminUser.update({
          where: { id: before.id },
          data: {
            passwordHash,
            status: before.status,
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            blockedAt: null,
          },
          include: {
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: { permission: true },
                    },
                  },
                },
              },
            },
          },
        });

        return {
          result: updated,
          event: {
            action: "STAFF_PASSWORD_RESET",
            entityType: "admin_user",
            entityId: updated.id,
            afterData: {
              id: updated.id,
              employeeId: updated.employeeId,
            },
          },
        };
      },
    );

    return res.json({
      success: true,
      data: sanitizeUser(result),
    });
  },
);

router.delete(
  "/:id",
  requireAuth,
  requirePermission(PERMISSIONS.adminUsersWrite),
  requireSuperAdmin,
  async (req: AuthenticatedRequest, res) => {
    const before = await getStaffById(req, String(req.params.id));

    if (!before) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    if (before.roles.some(({ role }) => role.isSystemRole)) {
      return res.status(403).json({
        success: false,
        message: "System administrators cannot be deleted here",
      });
    }

    await withAudit(
      req.prisma,
      requestAuditContext(req),
      async (tx) => {
        const result = await tx.adminUser.update({
          where: { id: before.id },
          data: {
            status: "archived",
            deletedAt: new Date(),
          },
        });

        return {
          result,
          event: {
            action: "STAFF_DELETE",
            entityType: "admin_user",
            entityId: result.id,
            beforeData: sanitizeUser(before),
            afterData: { id: result.id, status: result.status },
          },
        };
      },
    );

    return res.json({ success: true });
  },
);

export default router;
