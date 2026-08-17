// backened/src/services/adminPortal.service.ts

import { Prisma } from "@prisma/client";
import { AppPrisma } from "../config/prisma";
import { AuditContext, withAudit } from "./audit.service";

type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function getAdminPortalState(
  prisma: AppPrisma,
  organizationId: string,
  adminUserId: string,
  authorization: { isSystemRole: boolean; permissions: Set<string> },
) {
  const [
    organization,
    websiteSetting,
    members,
    events,
    categories,
    socialWorkItems,
    announcements,
    contacts,
    notifications,
    auditLogs,
    adminUsers,
    roles,
    importBatches,
    rejectedRecords,
    dataExports,
  ] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      include: { logoMedia: true },
    }),
    prisma.websiteSetting.findUnique({
      where: { organizationId },
    }),
    prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      include: { profileMedia: true, assignments: { include: { position: true, term: true }, orderBy: { displayOrder: "asc" } } },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.event.findMany({
      where: { organizationId, deletedAt: null },
      include: {
        album: {
          include: {
            photos: {
              include: { mediaAsset: true },
              orderBy: { displayOrder: "asc" },
            },
          },
        },
      },
      orderBy: { startAt: "desc" },
    }),
    prisma.socialWorkCategory.findMany({
      where: { organizationId },
      orderBy: { displayOrder: "asc" },
    }),
    prisma.socialWorkItem.findMany({
      where: { organizationId, deletedAt: null },
      include: { category: true },
      orderBy: { displayOrder: "asc" },
    }),
    prisma.announcement.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.contactRequest.findMany({
      where: { organizationId },
      include: {
        assignee: {
          select: { id: true, displayName: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.findMany({
      where: { organizationId },
      include: { adminUser: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.auditLog.findMany({
      where: { organizationId },
      include: {
        actor: {
          select: { displayName: true, email: true, roles: { include: { role: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.adminUser.findMany({
      where: { organizationId, deletedAt: null },
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
    }),
    prisma.role.findMany({
      where: { organizationId, isActive: true },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.importBatch.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.rejectedRecord.findMany({
      where: { organizationId },
      include: {
        importRecord: true,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.dataExport.findMany({ where: { organizationId }, include: { requester: { select: { id: true, displayName: true, email: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);

  const customFields = asJsonObject(websiteSetting?.customFields);

  const can = (code: string) => authorization.isSystemRole || authorization.permissions.has(code);

  return {
    organization: can("settings.read") ? organization : null,
    websiteSetting: can("settings.read") ? websiteSetting : null,
    adminUserId,
    members: can("members.read") ? members : [],
    events: can("events.read") || can("photos.read") ? events : [],
    socialWorkCategories: can("social_work.read") ? categories : [],
    socialWorkActivities: can("social_work.read") ? socialWorkItems : [],
    announcements: can("announcements.read") ? announcements : [],
    contacts: can("contacts.read") ? contacts : [],
    notifications: can("notifications.read") ? notifications : [],
    auditLogs: can("audit.read") ? auditLogs : [],
    employees: can("admin_users.read") ? adminUsers : [],
    roles: can("admin_users.read") || can("roles.manage") ? roles : [],
    importBatches: can("import_export.manage") ? importBatches : [],
    rejectedRecords: can("import_export.manage") ? rejectedRecords : [],
    dataExports: can("import_export.manage") ? dataExports : [],
    adminUiState: can("settings.read") ? asJsonObject(customFields.adminUiState) : {},
  };
}

export async function createSocialWorkItem(
  prisma: AppPrisma,
  audit: AuditContext,
  data: {
    title: string;
    slug: string;
    categoryId?: string | null;
    summary?: string | null;
    description?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    status?: string;
    displayOrder?: number;
    publishedAt?: string | null;
    coverMediaId?: string | null;
    metadata?: JsonObject;
    customFields?: JsonObject;
  },
) {
  if (data.categoryId) { const category = await prisma.socialWorkCategory.findFirst({ where: { id: data.categoryId, organizationId: audit.organizationId, isActive: true } }); if (!category) throw new Error("Category must be active and belong to your organization"); }
  if (data.coverMediaId) { const media = await prisma.mediaAsset.findFirst({ where: { id: data.coverMediaId, organizationId: audit.organizationId, deletedAt: null } }); if (!media) throw new Error("Cover media must belong to your organization"); }
  return withAudit(prisma, audit, async (tx) => { const result = await tx.socialWorkItem.create({ data: {
      organizationId: audit.organizationId,
      title: data.title,
      slug: data.slug,
      categoryId: data.categoryId || null,
      summary: data.summary || null,
      description: data.description || null,
      startDate: dateOrNull(data.startDate),
      endDate: dateOrNull(data.endDate),
      status: data.status ?? "published",
      displayOrder: data.displayOrder ?? 0,
      publishedAt: dateOrNull(data.publishedAt),
      coverMediaId: data.coverMediaId ?? null,
      metadata: toJson(data.metadata ?? {}),
      customFields: toJson(data.customFields ?? {}),
    }, include: { category: true, coverMedia: true } }); return { result, event: { action: "SOCIAL_WORK_CREATE", entityType: "social_work", entityId: result.id, afterData: result } }; });
}

export async function updateSocialWorkItem(
  prisma: AppPrisma,
  audit: AuditContext,
  id: string,
  data: JsonObject,
) {
  const existing = await prisma.socialWorkItem.findFirst({
    where: { id, organizationId: audit.organizationId, deletedAt: null },
  });

  if (!existing) {
    return null;
  }

  if (typeof data.categoryId === "string") { const category = await prisma.socialWorkCategory.findFirst({ where: { id: data.categoryId, organizationId: audit.organizationId, isActive: true } }); if (!category) throw new Error("Category must be active and belong to your organization"); }
  if (typeof data.coverMediaId === "string") { const media = await prisma.mediaAsset.findFirst({ where: { id: data.coverMediaId, organizationId: audit.organizationId, deletedAt: null } }); if (!media) throw new Error("Cover media must belong to your organization"); }
  return withAudit(prisma, audit, async (tx) => { const result = await tx.socialWorkItem.update({
    where: { id: existing.id },
    data: {
      title: typeof data.title === "string" ? data.title : undefined,
      slug: typeof data.slug === "string" ? data.slug : undefined,
      categoryId: data.categoryId === null ? null : typeof data.categoryId === "string" ? data.categoryId : undefined,
      summary:
        typeof data.summary === "string" ? data.summary : undefined,
      description:
        typeof data.description === "string" ? data.description : undefined,
      startDate:
        typeof data.startDate === "string"
          ? dateOrNull(data.startDate)
          : undefined,
      endDate:
        data.endDate === null ? null : typeof data.endDate === "string"
          ? dateOrNull(data.endDate)
          : undefined,
      status: typeof data.status === "string" ? data.status : undefined,
      displayOrder:
        typeof data.displayOrder === "number" ? data.displayOrder : undefined,
      publishedAt: data.publishedAt === null ? null : typeof data.publishedAt === "string" ? dateOrNull(data.publishedAt) : undefined,
      coverMediaId: data.coverMediaId === null ? null : typeof data.coverMediaId === "string" ? data.coverMediaId : undefined,
      metadata: data.metadata !== undefined ? toJson(data.metadata) : undefined,
      customFields:
        data.customFields !== undefined ? toJson(data.customFields) : undefined,
    },
    include: { category: true, coverMedia: true },
  }); return { result, event: { action: "SOCIAL_WORK_UPDATE", entityType: "social_work", entityId: result.id, beforeData: existing, afterData: result } }; });
}

export async function createAnnouncement(
  prisma: AppPrisma,
  audit: AuditContext,
  data: {
    title: string;
    slug: string;
    summary?: string | null;
    body: string;
    status?: string;
    publishedAt?: string | null;
    expiresAt?: string | null;
    coverMediaId?: string | null;
    metadata?: JsonObject;
    customFields?: JsonObject;
  },
) {
  if (data.coverMediaId) { const media = await prisma.mediaAsset.findFirst({ where: { id: data.coverMediaId, organizationId: audit.organizationId, deletedAt: null } }); if (!media) throw new Error("Cover media must belong to your organization"); }
  return withAudit(prisma, audit, async (tx) => { const result = await tx.announcement.create({ data: {
      organizationId: audit.organizationId,
      title: data.title,
      slug: data.slug,
      summary: data.summary || null,
      body: data.body,
      status: data.status ?? "published",
      publishedAt: dateOrNull(data.publishedAt),
      expiresAt: dateOrNull(data.expiresAt),
      coverMediaId: data.coverMediaId ?? null,
      metadata: toJson(data.metadata ?? {}),
      customFields: toJson(data.customFields ?? {}),
    }, include: { coverMedia: true } }); return { result, event: { action: "ANNOUNCEMENT_CREATE", entityType: "announcement", entityId: result.id, afterData: result } }; });
}

export async function updateAnnouncement(
  prisma: AppPrisma,
  audit: AuditContext,
  id: string,
  data: JsonObject,
) {
  const existing = await prisma.announcement.findFirst({
    where: { id, organizationId: audit.organizationId, deletedAt: null },
  });

  if (!existing) {
    return null;
  }

  if (typeof data.coverMediaId === "string") { const media = await prisma.mediaAsset.findFirst({ where: { id: data.coverMediaId, organizationId: audit.organizationId, deletedAt: null } }); if (!media) throw new Error("Cover media must belong to your organization"); }
  return withAudit(prisma, audit, async (tx) => { const result = await tx.announcement.update({
    where: { id },
    data: {
      title: typeof data.title === "string" ? data.title : undefined,
      slug: typeof data.slug === "string" ? data.slug : undefined,
      summary: typeof data.summary === "string" ? data.summary : undefined,
      body: typeof data.body === "string" ? data.body : undefined,
      status: typeof data.status === "string" ? data.status : undefined,
      publishedAt:
        typeof data.publishedAt === "string"
          ? dateOrNull(data.publishedAt)
          : undefined,
      expiresAt:
        data.expiresAt === null
          ? null
          : typeof data.expiresAt === "string"
          ? dateOrNull(data.expiresAt)
          : undefined,
      coverMediaId: data.coverMediaId === null ? null : typeof data.coverMediaId === "string" ? data.coverMediaId : undefined,
      metadata: data.metadata !== undefined ? toJson(data.metadata) : undefined,
      customFields:
        data.customFields !== undefined ? toJson(data.customFields) : undefined,
    }, include: { coverMedia: true } }); return { result, event: { action: "ANNOUNCEMENT_UPDATE", entityType: "announcement", entityId: result.id, beforeData: existing, afterData: result } }; });
}

export async function updateContact(
  prisma: AppPrisma,
  audit: AuditContext,
  id: string,
  data: { status?: string; assignedTo?: string | null; notes?: string },
) {
  const existing = await prisma.contactRequest.findFirst({
    where: { id, organizationId: audit.organizationId },
  });

  if (!existing) {
    return null;
  }
  if (data.assignedTo) { const assignee = await prisma.adminUser.findFirst({ where: { id: data.assignedTo, organizationId: audit.organizationId, status: "active", deletedAt: null } }); if (!assignee) throw new Error("Assignee must be an active administrator in your organization"); }

  const metadata = asJsonObject(existing.metadata);
  if (data.notes !== undefined) {
    metadata.adminNotes = data.notes;
  }

  return withAudit(prisma, audit, async (tx) => {
    const result = await tx.contactRequest.update({ where: { id }, data: {
      status: data.status,
      assignedTo: data.assignedTo,
      respondedAt:
        data.status === "resolved" || data.status === "closed"
          ? new Date()
          : undefined,
      metadata: toJson(metadata),
    }, include: {
      assignee: {
        select: { id: true, displayName: true, email: true },
      },
    } });
    return { result, event: { action: "CONTACT_UPDATE", entityType: "contact", entityId: id, beforeData: existing, afterData: result } };
  });
}

export async function createNotification(
  prisma: AppPrisma,
  audit: AuditContext,
  data: {
    type: string;
    title: string;
    message: string;
    linkUrl?: string;
    metadata?: JsonObject;
    adminUserId?: string | null;
  },
) {
  if (data.adminUserId) { const recipient = await prisma.adminUser.findFirst({ where: { id: data.adminUserId, organizationId: audit.organizationId, status: "active", deletedAt: null } }); if (!recipient) throw new Error("Recipient must be an active administrator in your organization"); }
  return withAudit(prisma, audit, async (tx) => {
    const result = await tx.notification.create({ data: {
      organizationId: audit.organizationId,
      adminUserId: data.adminUserId ?? null,
      type: data.type,
      title: data.title,
      message: data.message,
      linkUrl: data.linkUrl || null,
      metadata: toJson({ ...(data.metadata ?? {}), deliveryStatus: "record_only" }),
    } });
    return { result, event: { action: "NOTIFICATION_CREATE", entityType: "notification", entityId: result.id, afterData: result, metadata: { delivery: "record_only" } } };
  });
}
