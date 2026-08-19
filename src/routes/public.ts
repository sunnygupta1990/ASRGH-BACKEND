// backened/src/routes/public.ts

import { Request, Router } from "express";
import { z } from "zod";
import {
  getPublicEvents,
  getPublicMembers,
  getPublicAnnouncements,
  getPublicSocialWork,
  PublicOrganizationResolutionError,
  resolvePublicOrganization,
} from "../services/publicContent.service";

const router = Router();

async function getOrganization(req: Request) {
  return resolvePublicOrganization(
    req.prisma,
    req.get("origin"),
    req.get("referer"),
  );
}

router.get("/content", async (req, res) => {
  try {
    const organization = await getOrganization(req);
    const [events, members, websiteSetting, announcements, socialWork] = await Promise.all([
      getPublicEvents(req.prisma, organization.id),
      getPublicMembers(req.prisma, organization.id),
      req.prisma.websiteSetting.findUnique({ where: { organizationId: organization.id } }),
      getPublicAnnouncements(req.prisma, organization.id),
      getPublicSocialWork(req.prisma, organization.id),
    ]);
    return res.json({
      success: true,
      data: {
        events,
        members,
        settings: { organization, websiteSetting },
        announcements,
        socialWork,
      },
    });
  } catch (error) {
    if (error instanceof PublicOrganizationResolutionError) return res.status(error.status).json({ success: false, message: error.message });
    console.error("PUBLIC_CONTENT_ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to load public website content" });
  }
});

router.get("/events", async (req, res) => {
  try {
    const organization = await getOrganization(req);
    const data = await getPublicEvents(
      req.prisma,
      organization.id,
    );

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    if (error instanceof PublicOrganizationResolutionError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
      });
    }

    console.error("PUBLIC_EVENTS_ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load public events",
    });
  }
});

router.get("/members", async (req, res) => {
  try {
    const organization = await getOrganization(req);
    const data = await getPublicMembers(
      req.prisma,
      organization.id,
    );

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    if (error instanceof PublicOrganizationResolutionError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
      });
    }

    console.error("PUBLIC_MEMBERS_ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load public members",
    });
  }
});

router.get("/settings", async (req, res) => {
  try {
    const organization = await getOrganization(req);
    const websiteSetting = await req.prisma.websiteSetting.findUnique({ where: { organizationId: organization.id } });
    return res.json({ success: true, data: { organization, websiteSetting } });
  } catch (error) {
    if (error instanceof PublicOrganizationResolutionError) return res.status(error.status).json({ success: false, message: error.message });
    return res.status(500).json({ success: false, message: "Unable to load public settings" });
  }
});

router.get("/announcements", async (req, res) => {
  try {
    const organization = await getOrganization(req);
    const data = await getPublicAnnouncements(req.prisma, organization.id);
    return res.json({ success: true, data });
  } catch (error) {
    if (error instanceof PublicOrganizationResolutionError) return res.status(error.status).json({ success: false, message: error.message });
    console.error("PUBLIC_ANNOUNCEMENTS_ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to load public announcements" });
  }
});

router.get("/social-work", async (req, res) => {
  try {
    const organization = await getOrganization(req);
    const data = await getPublicSocialWork(req.prisma, organization.id);
    return res.json({ success: true, data });
  } catch (error) {
    if (error instanceof PublicOrganizationResolutionError) return res.status(error.status).json({ success: false, message: error.message });
    console.error("PUBLIC_SOCIAL_WORK_ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to load public social work" });
  }
});

router.post("/contacts", async (req, res) => {
  try {
    const organization = await getOrganization(req);
    const data = z.object({
      name: z.string().trim().min(1).max(200),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().trim().min(1).max(50),
      subject: z.string().trim().max(250).optional(),
      message: z.string().trim().min(1),
      category: z.string().trim().max(100).optional(),
    }).parse(req.body);
    const contact = await req.prisma.contactRequest.create({
      data: {
        organizationId: organization.id,
        name: data.name,
        email: data.email || null,
        phone: data.phone,
        subject: data.subject || null,
        message: data.message,
        metadata: data.category ? { category: data.category } : {},
      },
    });
    return res.status(201).json({ success: true, data: contact });
  } catch (error) {
    if (error instanceof PublicOrganizationResolutionError) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, message: "Invalid contact request", issues: error.issues });
    }
    console.error("PUBLIC_CONTACT_ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to submit contact request" });
  }
});

export default router;
