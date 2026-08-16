// backened/src/routes/events.ts

import { Router } from "express";
import { z } from "zod";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";

const router = Router();

const eventSchema = z.object({
  title: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  category: z.string().trim().optional(),
  summary: z.string().trim().optional(),
  description: z.string().trim().optional(),
  venue: z.string().trim().optional(),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
  status: z.string().trim().default("published"),
});

router.get("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  const events = await req.prisma.event.findMany({
    where: {
      organizationId: req.user!.organizationId,
      deletedAt: null,
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
    orderBy: {
      startAt: "desc",
    },
  });

  return res.json({
    success: true,
    data: events,
  });
});

router.post("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const data = eventSchema.parse(req.body);

    const event = await req.prisma.event.create({
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
        status: data.status,
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

router.put("/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const data = eventSchema.partial().parse(req.body);

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

    const event = await req.prisma.event.update({
      where: {
        id: existing.id,
      },
      data: {
        ...data,
        startAt: data.startAt ? new Date(data.startAt) : undefined,
        endAt: data.endAt ? new Date(data.endAt) : undefined,
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

    const event = await req.prisma.event.update({
      where: {
        id: existing.id,
      },
      data: {
        status: "archived",
      },
    });

    return res.json({
      success: true,
      data: event,
    });
  },
);

export default router;
