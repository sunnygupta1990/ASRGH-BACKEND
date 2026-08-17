// backened/src/routes/events.ts

import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";
import { PERMISSIONS, requirePermission } from "../auth/permissions";
import { requestAuditContext, withAudit } from "../services/audit.service";

const router = Router();

const eventSchema = z.object({
  title: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  category: z.string().trim().optional(),
  summary: z.string().trim().optional(),
  description: z.string().trim().optional(),
  venue: z.string().trim().optional(),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().nullable().optional(),
  publishedAt: z.string().datetime().nullable().optional(),
  coverMediaId: z.string().uuid().nullable().optional(),
  status: z.string().trim().default("published"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
}).strict();
const eventUpdateSchema = eventSchema.partial().extend({ status: z.string().trim().optional() });

async function validateEventMedia(req: AuthenticatedRequest, mediaId?: string | null) { if (!mediaId) return; const media = await req.prisma.mediaAsset.findFirst({ where: { id: mediaId, organizationId: req.user!.organizationId, deletedAt: null } }); if (!media) throw new Error("Cover media must belong to your organization"); }

router.get("/", requireAuth, requirePermission(PERMISSIONS.eventsRead), async (req: AuthenticatedRequest, res) => {
  const query = z.object({ search: z.string().trim().optional(), status: z.string().trim().optional(), category: z.string().trim().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
  const where: Prisma.EventWhereInput = { organizationId: req.user!.organizationId, deletedAt: null, ...(query.status ? { status: query.status } : {}), ...(query.category ? { category: query.category } : {}), ...(query.search ? { OR: [{ title: { contains: query.search, mode: "insensitive" } }, { slug: { contains: query.search, mode: "insensitive" } }, { summary: { contains: query.search, mode: "insensitive" } }, { description: { contains: query.search, mode: "insensitive" } }, { venue: { contains: query.search, mode: "insensitive" } }] } : {}) };
  const [events, total] = await Promise.all([
  req.prisma.event.findMany({
    where,
    include: {
      album: {
        include: {
          photos: {
            include: {
              mediaAsset: true,
            },
            orderBy: {
              displayOrder: "asc",
            },
          },
        },
      },
    },
    orderBy: {
      startAt: "desc",
    },
    skip: (query.page - 1) * query.pageSize, take: query.pageSize,
  }), req.prisma.event.count({ where })]);

  return res.json({
    success: true,
    data: events, pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
  });
});

router.get("/:id", requireAuth, requirePermission(PERMISSIONS.eventsRead), async (req, res) => {
  const event = await req.prisma.event.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId, deletedAt: null }, include: { coverMedia: true, album: { include: { coverMedia: true, photos: { include: { mediaAsset: true }, orderBy: { displayOrder: "asc" } } } } } });
  return event ? res.json({ success: true, data: event }) : res.status(404).json({ success: false, message: "Event not found" });
});

router.post("/", requireAuth, requirePermission(PERMISSIONS.eventsWrite), async (req: AuthenticatedRequest, res) => {
  try {
    const data = eventSchema.parse(req.body);
    await validateEventMedia(req, data.coverMediaId);

    const event = await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.event.create({
      data: {
        organizationId: req.user!.organizationId,
        title: data.title,
        slug: data.slug,
        category: data.category || null,
        summary: data.summary || null,
        description: data.description || null,
        venue: data.venue || null,
        startAt: data.startAt ? new Date(data.startAt) : null,
        endAt: data.endAt ? new Date(data.endAt) : null,
        publishedAt: data.publishedAt ? new Date(data.publishedAt) : null,
        coverMediaId: data.coverMediaId ?? null,
        status: data.status,
        metadata: data.metadata as Prisma.InputJsonValue | undefined,
        customFields: data.customFields as Prisma.InputJsonValue | undefined,
        album: {
          create: {
            organizationId: req.user!.organizationId,
            title: data.title,
          },
        },
      },
      include: {
        album: {
          include: {
            photos: true,
          },
        },
      },
      });
      return { result, event: { action: "EVENT_CREATE", entityType: "event", entityId: result.id, afterData: result } };
    });

    return res.status(201).json({
      success: true,
      data: event,
    });
  } catch (error) {
    console.error("EVENT_CREATE_ERROR:", error);

    return res.status(400).json({
      success: false,
      message: "Invalid event data",
    });
  }
});

router.put("/:id", requireAuth, requirePermission(PERMISSIONS.eventsWrite), async (req: AuthenticatedRequest, res) => {
  try {
    const data = eventUpdateSchema.parse(req.body);
    await validateEventMedia(req, data.coverMediaId);

    const existing = await req.prisma.event.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const existingCustomFields =
      existing.customFields && typeof existing.customFields === "object" &&
      !Array.isArray(existing.customFields)
        ? (existing.customFields as Record<string, unknown>)
        : {};
    const mergedCustomFields = data.customFields
      ? { ...existingCustomFields, ...data.customFields }
      : undefined;

    const event = await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.event.update({
      where: {
        id: existing.id,
      },
      data: {
        title: data.title,
        slug: data.slug,
        category: data.category,
        summary: data.summary,
        description: data.description,
        venue: data.venue,
        status: data.status,
        coverMediaId: data.coverMediaId,
        metadata: data.metadata as Prisma.InputJsonValue | undefined,
        customFields: mergedCustomFields as Prisma.InputJsonValue | undefined,
        startAt: data.startAt ? new Date(data.startAt) : undefined,
        endAt: data.endAt === null ? null : data.endAt ? new Date(data.endAt) : undefined,
        publishedAt: data.publishedAt === null ? null : data.publishedAt ? new Date(data.publishedAt) : undefined,
      },
      include: {
        album: {
          include: {
            photos: {
              include: {
                mediaAsset: true,
              },
              orderBy: {
                displayOrder: "asc",
              },
            },
          },
        },
      },
      });
      return { result, event: { action: "EVENT_UPDATE", entityType: "event", entityId: result.id, beforeData: existing, afterData: result } };
    });

    return res.json({
      success: true,
      data: event,
    });
  } catch (error) {
    console.error("EVENT_UPDATE_ERROR:", error);

    return res.status(400).json({
      success: false,
      message: "Invalid event data",
    });
  }
});

router.patch(
  "/:id/archive",
  requireAuth,
  requirePermission(PERMISSIONS.eventsWrite),
  async (req: AuthenticatedRequest, res) => {
    const existing = await req.prisma.event.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const event = await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.event.update({
      where: {
        id: existing.id,
      },
      data: {
        status: "archived",
      },
      });
      return { result, event: { action: "EVENT_ARCHIVE", entityType: "event", entityId: result.id, beforeData: existing, afterData: result } };
    });

    return res.json({
      success: true,
      data: event,
    });
  },
);

router.delete(
  "/:id",
  requireAuth,
  requirePermission(PERMISSIONS.eventsDelete),
  async (req: AuthenticatedRequest, res) => {
    const existing = await req.prisma.event.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const result = await tx.event.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: "deleted" },
      });
      return { result, event: { action: "EVENT_DELETE", entityType: "event", entityId: result.id, beforeData: existing, afterData: result } };
    });

    return res.json({ success: true });
  },
);

export default router;
