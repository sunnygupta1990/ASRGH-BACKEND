// backened/src/routes/members.ts

import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";
import { PERMISSIONS, requirePermission } from "../auth/permissions";
import { requestAuditContext, withAudit } from "../services/audit.service";
import { classifiedCustomFields } from "../services/memberClassification.service";

const router = Router();
const memberEmailSchema = z.string().email().or(z.literal(""));

const memberSchema = z.object({
  memberCode: z.string().trim().min(1).optional(),
  firstName: z.string().trim().min(1),
  middleName: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  displayName: z.string().trim().optional(),
  gender: z.string().trim().optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  phone: z.string().trim().optional(),
  email: memberEmailSchema.optional(),
  addressLine1: z.string().trim().optional(),
  addressLine2: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  postalCode: z.string().trim().optional(),
  country: z.string().trim().min(1).optional(),
  membershipStatus: z.enum(["active", "archived"]).default("active"),
  joinedOn: z.string().date().nullable().optional(),
  notes: z.string().optional(),
  profileMediaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
}).strict();

const memberUpdateSchema = memberSchema.partial().extend({
  email: z.string().optional(),
  membershipStatus: z.enum(["active", "archived"]).optional(),
});

function memberValidationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "member"}: ${issue.message}`)
    .join("; ");
}

function toPrismaCustomFields(
  value: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  if (!value) {
    return undefined;
  }

  return value as Prisma.InputJsonValue;
}

router.get("/", requireAuth, requirePermission(PERMISSIONS.membersRead), async (req: AuthenticatedRequest, res) => {
  const query = z.object({ search: z.string().trim().optional(), status: z.string().trim().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
  const where: Prisma.MemberWhereInput = {
    organizationId: req.user!.organizationId, deletedAt: null,
    ...(query.status ? { membershipStatus: query.status } : {}),
    ...(query.search ? { OR: [{ memberCode: { contains: query.search, mode: "insensitive" } }, { firstName: { contains: query.search, mode: "insensitive" } }, { middleName: { contains: query.search, mode: "insensitive" } }, { lastName: { contains: query.search, mode: "insensitive" } }, { displayName: { contains: query.search, mode: "insensitive" } }, { phone: { contains: query.search } }, { email: { contains: query.search, mode: "insensitive" } }, { city: { contains: query.search, mode: "insensitive" } }, { state: { contains: query.search, mode: "insensitive" } }] } : {}),
  };
  const [members, total] = await Promise.all([
  req.prisma.member.findMany({
    where,
    include: { profileMedia: true, assignments: { include: { position: true, term: true }, orderBy: { displayOrder: "asc" } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    skip: (query.page - 1) * query.pageSize, take: query.pageSize,
  }), req.prisma.member.count({ where })]);

  return res.json({
    success: true,
    data: members, pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
  });
});

router.get("/:id", requireAuth, requirePermission(PERMISSIONS.membersRead), async (req, res) => {
  const member = await req.prisma.member.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId, deletedAt: null }, include: { profileMedia: true, assignments: { include: { position: true, term: true }, orderBy: { displayOrder: "asc" } } } });
  return member ? res.json({ success: true, data: member }) : res.status(404).json({ success: false, message: "Member not found" });
});

router.post("/", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req: AuthenticatedRequest, res) => {
  try {
    const data = memberSchema.parse(req.body);

    if (data.memberCode) {
      const duplicate = await req.prisma.member.findFirst({
        where: {
          organizationId: req.user!.organizationId,
          memberCode: data.memberCode,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Member code "${data.memberCode}" is already in use.`,
        });
      }
    }

    if (data.profileMediaId) { const media = await req.prisma.mediaAsset.findFirst({ where: { id: data.profileMediaId, organizationId: req.user!.organizationId, deletedAt: null } }); if (!media) return res.status(400).json({ success: false, message: "Profile media must belong to your organization" }); }

    const member = await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.member.create({
      data: {
        organizationId: req.user!.organizationId,
        memberCode: data.memberCode,
        firstName: data.firstName,
        middleName: data.middleName || null,
        lastName: data.lastName || null,
        displayName: data.displayName || null,
        gender: data.gender || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        phone: data.phone || null,
        email: data.email || null,
        addressLine1: data.addressLine1 || null,
        addressLine2: data.addressLine2 || null,
        city: data.city || null,
        state: data.state || null,
        postalCode: data.postalCode || null,
        country: data.country || "India",
        membershipStatus: data.membershipStatus,
        joinedOn: data.joinedOn ? new Date(data.joinedOn) : null,
        notes: data.notes || null,
        profileMediaId: data.profileMediaId ?? null,
        metadata: toPrismaCustomFields(data.metadata),
        customFields: toPrismaCustomFields(classifiedCustomFields(data.memberCode, data.customFields)),
      },
      include: { profileMedia: true, assignments: { include: { position: true, term: true } } },
      });
      return { result, event: { action: "MEMBER_CREATE", entityType: "member", entityId: result.id, afterData: result } };
    });

    return res.status(201).json({
      success: true,
      data: member,
    });
  } catch (error) {
    console.error("Create member failed", error);

    return res.status(400).json({
      success: false,
      message: error instanceof z.ZodError
        ? memberValidationMessage(error)
        : "Unable to create member",
    });
  }
});

router.put("/:id", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req: AuthenticatedRequest, res) => {
  try {
    const data = memberUpdateSchema.parse(req.body);
    if (data.profileMediaId) { const media = await req.prisma.mediaAsset.findFirst({ where: { id: data.profileMediaId, organizationId: req.user!.organizationId, deletedAt: null } }); if (!media) return res.status(400).json({ success: false, message: "Profile media must belong to your organization" }); }

    const existing = await req.prisma.member.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    if (data.email !== undefined && data.email !== existing.email) {
      const emailResult = memberEmailSchema.safeParse(data.email);
      if (!emailResult.success) {
        return res.status(400).json({
          success: false,
          message: `email: ${emailResult.error.issues[0]?.message ?? "Invalid email address"}`,
        });
      }
    }

    if (data.memberCode && data.memberCode !== existing.memberCode) {
      const duplicate = await req.prisma.member.findFirst({
        where: {
          organizationId: req.user!.organizationId,
          memberCode: data.memberCode,
          deletedAt: null,
          NOT: { id: existing.id },
        },
        select: { id: true },
      });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Member code "${data.memberCode}" is already in use.`,
        });
      }
    }

    const existingCustomFields =
      existing.customFields &&
      typeof existing.customFields === "object" &&
      !Array.isArray(existing.customFields)
        ? (existing.customFields as Record<string, unknown>)
        : {};

    const mergedCustomFields = data.customFields
      ? { ...existingCustomFields, ...data.customFields }
      : existingCustomFields;
    const finalMemberCode = data.memberCode ?? existing.memberCode;

    const member = await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.member.update({
      where: {
        id: existing.id,
      },
      data: {
        memberCode: data.memberCode,
        firstName: data.firstName,
        middleName: data.middleName,
        lastName: data.lastName,
        displayName: data.displayName,
        gender: data.gender === "" ? null : data.gender,
        dateOfBirth: data.dateOfBirth === null || data.dateOfBirth === "" ? null : data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        phone: data.phone,
        email: data.email === "" ? null : data.email,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        country: data.country,
        membershipStatus: data.membershipStatus,
        joinedOn: data.joinedOn === null || data.joinedOn === "" ? null : data.joinedOn ? new Date(data.joinedOn) : undefined,
        notes: data.notes,
        profileMediaId: data.profileMediaId,
        metadata: toPrismaCustomFields(data.metadata),
        customFields: toPrismaCustomFields(classifiedCustomFields(finalMemberCode, mergedCustomFields)),
      },
      include: { profileMedia: true, assignments: { include: { position: true, term: true } } },
      });
      return { result, event: { action: "MEMBER_UPDATE", entityType: "member", entityId: result.id, beforeData: existing, afterData: result } };
    });

    return res.json({
      success: true,
      data: member,
    });
  } catch (error) {
    console.error("Update member failed", error);

    return res.status(400).json({
      success: false,
      message: error instanceof z.ZodError
        ? memberValidationMessage(error)
        : "Unable to update member",
    });
  }
});

router.patch(
  "/:id/archive",
  requireAuth,
  requirePermission(PERMISSIONS.membersWrite),
  async (req: AuthenticatedRequest, res) => {
    const existing = await req.prisma.member.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    const member = await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.member.update({
      where: {
        id: existing.id,
      },
      data: {
        membershipStatus: "archived",
      },
      include: { profileMedia: true, assignments: { include: { position: true, term: true } } },
      });
      return { result, event: { action: "MEMBER_ARCHIVE", entityType: "member", entityId: result.id, beforeData: existing, afterData: result } };
    });

    return res.json({
      success: true,
      data: member,
    });
  },
);

router.delete(
  "/:id",
  requireAuth,
  requirePermission(PERMISSIONS.membersDelete),
  async (req: AuthenticatedRequest, res) => {
    const existing = await req.prisma.member.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.member.update({
      where: {
        id: existing.id,
      },
      data: {
        deletedAt: new Date(),
        membershipStatus: "deleted",
      },
      });
      return { result, event: { action: "MEMBER_DELETE", entityType: "member", entityId: result.id, beforeData: existing, afterData: result } };
    });

    return res.json({
      success: true,
    });
  },
);

export default router;
