import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";

const router = Router();

const memberSchema = z.object({
  memberCode: z.string().trim().min(1).optional(),
  firstName: z.string().trim().min(1),
  middleName: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  displayName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().email().optional().or(z.literal("")),
  addressLine1: z.string().trim().optional(),
  addressLine2: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  postalCode: z.string().trim().optional(),
  membershipStatus: z.string().trim().default("active"),
  joinedOn: z.string().optional(),
  notes: z.string().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

const memberUpdateSchema = memberSchema.partial();

function toPrismaCustomFields(
  value: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  if (!value) return undefined;
  return value as Prisma.InputJsonValue;
}

router.get("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  const members = await prisma.member.findMany({
    where: {
      organizationId: req.user!.organizationId,
      deletedAt: null,
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  return res.json({ success: true, data: members });
});

router.post("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const data = memberSchema.parse(req.body);

    const member = await prisma.member.create({
      data: {
        organizationId: req.user!.organizationId,
        memberCode: data.memberCode,
        firstName: data.firstName,
        middleName: data.middleName || null,
        lastName: data.lastName || null,
        displayName: data.displayName || null,
        phone: data.phone || null,
        email: data.email || null,
        addressLine1: data.addressLine1 || null,
        addressLine2: data.addressLine2 || null,
        city: data.city || null,
        state: data.state || null,
        postalCode: data.postalCode || null,
        membershipStatus: data.membershipStatus,
        joinedOn: data.joinedOn ? new Date(data.joinedOn) : null,
        notes: data.notes || null,
        customFields: toPrismaCustomFields(data.customFields),
      },
    });

    return res.status(201).json({ success: true, data: member });
  } catch (error) {
    console.error("Create member failed", error);
    return res.status(400).json({
      success: false,
      message: "Invalid member data or duplicate member code",
    });
  }
});

router.put("/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const data = memberUpdateSchema.parse(req.body);

    const existing = await prisma.member.findFirst({
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

    const existingCustomFields =
      existing.customFields &&
      typeof existing.customFields === "object" &&
      !Array.isArray(existing.customFields)
        ? (existing.customFields as Record<string, unknown>)
        : {};

    const mergedCustomFields = data.customFields
      ? { ...existingCustomFields, ...data.customFields }
      : undefined;

    const member = await prisma.member.update({
      where: { id: existing.id },
      data: {
        memberCode: data.memberCode,
        firstName: data.firstName,
        middleName: data.middleName,
        lastName: data.lastName,
        displayName: data.displayName,
        phone: data.phone,
        email: data.email === "" ? null : data.email,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        membershipStatus: data.membershipStatus,
        joinedOn: data.joinedOn ? new Date(data.joinedOn) : undefined,
        notes: data.notes,
        customFields: toPrismaCustomFields(mergedCustomFields),
      },
    });

    return res.json({ success: true, data: member });
  } catch (error) {
    console.error("Update member failed", error);
    return res.status(400).json({
      success: false,
      message: "Invalid member data or duplicate member code",
    });
  }
});

router.patch("/:id/archive", requireAuth, async (req: AuthenticatedRequest, res) => {
  const existing = await prisma.member.findFirst({
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

  const member = await prisma.member.update({
    where: { id: existing.id },
    data: { membershipStatus: "archived" },
  });

  return res.json({ success: true, data: member });
});


router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const existing = await prisma.member.findFirst({
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

  await prisma.member.update({
    where: { id: existing.id },
    data: {
      deletedAt: new Date(),
      membershipStatus: "deleted",
    },
  });

  return res.json({ success: true });
});

export default router;

