// backened/src/routes/adminPortal.ts

import { Router } from "express";
import { z } from "zod";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";
import { PERMISSIONS, requirePermission } from "../auth/permissions";
import { requestAuditContext, withAudit } from "../services/audit.service";
import { updateSettingsBundle } from "../services/adminOperations.service";
import {
  createAnnouncement,
  createNotification,
  createSocialWorkItem,
  getAdminPortalState,
  updateAnnouncement,
  updateContact,
  updateSocialWorkItem,
} from "../services/adminPortal.service";

const router = Router();

const jsonObjectSchema = z.record(z.string(), z.unknown());
const socialWorkSchema = z.object({ title: z.string().trim().min(1), slug: z.string().trim().min(1), categoryId: z.string().uuid().nullable().optional(), summary: z.string().nullable().optional(), description: z.string().nullable().optional(), startDate: z.string().date().nullable().optional(), endDate: z.string().date().nullable().optional(), status: z.string().trim().min(1).optional(), displayOrder: z.number().int().optional(), publishedAt: z.string().datetime().nullable().optional(), coverMediaId: z.string().uuid().nullable().optional(), metadata: jsonObjectSchema.optional(), customFields: jsonObjectSchema.optional() }).strict();
const announcementSchema = z.object({ title: z.string().trim().min(1), slug: z.string().trim().min(1), summary: z.string().nullable().optional(), body: z.string().min(1), status: z.enum(["draft", "scheduled", "published", "archived"]).optional(), publishedAt: z.string().datetime().nullable().optional(), expiresAt: z.string().datetime().nullable().optional(), coverMediaId: z.string().uuid().nullable().optional(), metadata: jsonObjectSchema.optional(), customFields: jsonObjectSchema.optional() }).strict();

router.get(
  "/state",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const state = await getAdminPortalState(
        req.prisma,
        req.user!.organizationId,
        req.user!.userId,
        req.authorization!,
      );

      return res.json({ success: true, data: state });
    } catch (error) {
      console.error("ADMIN_PORTAL_STATE_ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Unable to load admin portal data",
      });
    }
  },
);

router.put(
  "/ui-state",
  requireAuth,
  requirePermission(PERMISSIONS.settingsWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const state = jsonObjectSchema.parse(req.body);

      await updateSettingsBundle(req.prisma, requestAuditContext(req), undefined, state);

      return res.json({ success: true });
    } catch (error) {
      console.error("ADMIN_UI_STATE_SAVE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid admin UI state",
      });
    }
  },
);

router.put(
  "/organization",
  requireAuth,
  requirePermission(PERMISSIONS.settingsWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = z
        .object({
          name: z.string().trim().min(1).optional(),
          legalName: z.string().trim().optional(),
          email: z.string().email().optional().or(z.literal("")),
          phone: z.string().trim().optional(),
          addressLine1: z.string().trim().optional(),
          addressLine2: z.string().trim().optional(),
          city: z.string().trim().optional(),
          state: z.string().trim().optional(),
          postalCode: z.string().trim().optional(),
          country: z.string().trim().optional(),
          websiteUrl: z.string().url().optional().or(z.literal("")),
          settings: jsonObjectSchema.optional(),
        }).strict()
        .parse(req.body);

      const result = await updateSettingsBundle(req.prisma, requestAuditContext(req), data, undefined);
      const organization = result.organization;

      return res.json({ success: true, data: organization });
    } catch (error) {
      console.error("ORGANIZATION_SETTINGS_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid organization settings",
      });
    }
  },
);

router.post(
  "/social-work",
  requireAuth,
  requirePermission(PERMISSIONS.socialWorkWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = socialWorkSchema.parse(req.body);

      const item = await createSocialWorkItem(
        req.prisma,
        requestAuditContext(req),
        data,
      );

      return res.status(201).json({ success: true, data: item });
    } catch (error) {
      console.error("SOCIAL_WORK_CREATE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid social work activity",
      });
    }
  },
);

router.put(
  "/social-work/:id",
  requireAuth,
  requirePermission(PERMISSIONS.socialWorkWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = socialWorkSchema.partial().parse(req.body);
      const item = await updateSocialWorkItem(
        req.prisma,
        requestAuditContext(req),
        String(req.params.id),
        data,
      );

      if (!item) {
        return res.status(404).json({
          success: false,
          message: "Social work activity not found",
        });
      }

      return res.json({ success: true, data: item });
    } catch (error) {
      console.error("SOCIAL_WORK_UPDATE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid social work activity",
      });
    }
  },
);

router.patch(
  "/social-work/:id/archive",
  requireAuth,
  requirePermission(PERMISSIONS.socialWorkWrite),
  async (req: AuthenticatedRequest, res) => {
    const item = await updateSocialWorkItem(
      req.prisma,
      requestAuditContext(req),
      String(req.params.id),
      { status: "archived" },
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Social work activity not found",
      });
    }

    return res.json({ success: true, data: item });
  },
);

router.delete(
  "/social-work/:id",
  requireAuth,
  requirePermission(PERMISSIONS.socialWorkDelete),
  async (req: AuthenticatedRequest, res) => {
    const item = await req.prisma.socialWorkItem.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Social work activity not found",
      });
    }

    await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const result = await tx.socialWorkItem.update({
      where: { id: item.id },
      data: {
        deletedAt: new Date(),
        status: "deleted",
      },
    }); return { result, event: { action: "SOCIAL_WORK_DELETE", entityType: "social_work", entityId: item.id, beforeData: item, afterData: result } }; });

    return res.json({ success: true });
  },
);

router.post(
  "/announcements",
  requireAuth,
  requirePermission(PERMISSIONS.announcementsWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = announcementSchema.parse(req.body);

      const announcement = await createAnnouncement(
        req.prisma,
        requestAuditContext(req),
        data,
      );

      return res.status(201).json({
        success: true,
        data: announcement,
      });
    } catch (error) {
      console.error("ANNOUNCEMENT_CREATE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid announcement",
      });
    }
  },
);

router.put(
  "/announcements/:id",
  requireAuth,
  requirePermission(PERMISSIONS.announcementsWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = announcementSchema.partial().parse(req.body);
      const announcement = await updateAnnouncement(
        req.prisma,
        requestAuditContext(req),
        String(req.params.id),
        data,
      );

      if (!announcement) {
        return res.status(404).json({
          success: false,
          message: "Announcement not found",
        });
      }

      return res.json({ success: true, data: announcement });
    } catch (error) {
      console.error("ANNOUNCEMENT_UPDATE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid announcement",
      });
    }
  },
);

router.patch(
  "/announcements/:id/archive",
  requireAuth,
  requirePermission(PERMISSIONS.announcementsWrite),
  async (req: AuthenticatedRequest, res) => {
    const announcement = await updateAnnouncement(
      req.prisma,
      requestAuditContext(req),
      String(req.params.id),
      { status: "archived" },
    );

    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found",
      });
    }

    return res.json({ success: true, data: announcement });
  },
);

router.delete(
  "/announcements/:id",
  requireAuth,
  requirePermission(PERMISSIONS.announcementsDelete),
  async (req: AuthenticatedRequest, res) => {
    const announcement = await req.prisma.announcement.findFirst({
      where: {
        id: String(req.params.id),
        organizationId: req.user!.organizationId,
        deletedAt: null,
      },
    });

    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found",
      });
    }

    await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const result = await tx.announcement.update({
      where: { id: announcement.id },
      data: {
        deletedAt: new Date(),
        status: "deleted",
      },
    }); return { result, event: { action: "ANNOUNCEMENT_DELETE", entityType: "announcement", entityId: announcement.id, beforeData: announcement, afterData: result } }; });

    return res.json({ success: true });
  },
);

router.patch(
  "/contacts/:id",
  requireAuth,
  requirePermission(PERMISSIONS.contactsWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = z
        .object({
          status: z.enum(["new", "assigned", "in_progress", "resolved", "closed"]).optional(),
          assignedTo: z.string().uuid().nullable().optional(),
          notes: z.string().optional(),
        })
        .parse(req.body);

      const contact = await updateContact(
        req.prisma,
        requestAuditContext(req),
        String(req.params.id),
        data,
      );

      if (!contact) {
        return res.status(404).json({
          success: false,
          message: "Contact request not found",
        });
      }
      return res.json({ success: true, data: contact });
    } catch (error) {
      console.error("CONTACT_UPDATE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid contact update",
      });
    }
  },
);

router.post(
  "/notifications",
  requireAuth,
  requirePermission(PERMISSIONS.notificationsWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const data = z
        .object({
          type: z.string().min(1),
          title: z.string().trim().min(1),
          message: z.string().min(1),
          linkUrl: z.string().url().optional().or(z.literal("")),
          metadata: jsonObjectSchema.optional(),
          adminUserId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body);

      const notification = await createNotification(
        req.prisma,
        requestAuditContext(req),
        data,
      );

      return res.status(201).json({
        success: true,
        data: notification,
      });
    } catch (error) {
      console.error("NOTIFICATION_CREATE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid notification",
      });
    }
  },
);

export default router;
