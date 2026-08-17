import { Prisma } from "@prisma/client";
import { AppPrisma } from "../config/prisma";
import { AuditContext, withAudit } from "./audit.service";

type JsonObject = Record<string, unknown>;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const slugify = (value: string) =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function getDashboard(prisma: AppPrisma, organizationId: string) {
  const [members, events, photos, socialWork, announcements, contacts, notifications, rejectedImports, recentActivity] =
    await Promise.all([
      prisma.member.count({ where: { organizationId, deletedAt: null, membershipStatus: { notIn: ["archived", "deleted"] } } }),
      prisma.event.count({ where: { organizationId, deletedAt: null, status: { notIn: ["archived", "deleted"] } } }),
      prisma.albumPhoto.count({ where: { organizationId } }),
      prisma.socialWorkItem.count({ where: { organizationId, deletedAt: null, status: { notIn: ["archived", "deleted"] } } }),
      prisma.announcement.count({ where: { organizationId, deletedAt: null } }),
      prisma.contactRequest.count({ where: { organizationId, status: { in: ["new", "assigned", "in_progress"] } } }),
      prisma.notification.count({ where: { organizationId } }),
      prisma.rejectedRecord.count({ where: { organizationId, correctionStatus: { not: "resolved" } } }),
      prisma.auditLog.findMany({
        where: { organizationId },
        include: { actor: { select: { displayName: true } } },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);
  return { counts: { members, events, photos, socialWork, announcements, contacts, notifications, rejectedImports }, recentActivity };
}

export async function createSocialWorkCategory(prisma: AppPrisma, audit: AuditContext, data: JsonObject) {
  return withAudit(prisma, audit, async (tx) => {
    const name = String(data.name).trim();
    const result = await tx.socialWorkCategory.create({ data: {
      organizationId: audit.organizationId,
      code: String(data.code || slugify(name)), name,
      description: typeof data.description === "string" ? data.description : null,
      iconKey: typeof data.iconKey === "string" ? data.iconKey : null,
      displayOrder: typeof data.displayOrder === "number" ? data.displayOrder : 0,
      isActive: data.isActive !== false,
      customFields: json(data.customFields ?? {}),
    }});
    return { result, event: { action: "SOCIAL_WORK_CATEGORY_CREATE", entityType: "social_work_category", entityId: result.id, afterData: result } };
  });
}

export async function updateSocialWorkCategory(prisma: AppPrisma, audit: AuditContext, id: string, data: JsonObject) {
  const before = await prisma.socialWorkCategory.findFirst({ where: { id, organizationId: audit.organizationId } });
  if (!before) return null;
  return withAudit(prisma, audit, async (tx) => {
    const result = await tx.socialWorkCategory.update({ where: { id: before.id }, data: {
      code: typeof data.code === "string" ? data.code : undefined,
      name: typeof data.name === "string" ? data.name : undefined,
      description: typeof data.description === "string" ? data.description : undefined,
      iconKey: typeof data.iconKey === "string" ? data.iconKey : undefined,
      displayOrder: typeof data.displayOrder === "number" ? data.displayOrder : undefined,
      isActive: typeof data.isActive === "boolean" ? data.isActive : undefined,
      customFields: data.customFields === undefined ? undefined : json(data.customFields),
    }});
    return { result, event: { action: "SOCIAL_WORK_CATEGORY_UPDATE", entityType: "social_work_category", entityId: id, beforeData: before, afterData: result } };
  });
}

export async function deleteSocialWorkCategory(prisma: AppPrisma, audit: AuditContext, id: string) {
  const before = await prisma.socialWorkCategory.findFirst({ where: { id, organizationId: audit.organizationId }, include: { _count: { select: { items: true } } } });
  if (!before) return null;
  if (before._count.items > 0) throw new Error("Category is in use and cannot be deleted");
  return withAudit(prisma, audit, async (tx) => {
    const result = await tx.socialWorkCategory.delete({ where: { id } });
    return { result, event: { action: "SOCIAL_WORK_CATEGORY_DELETE", entityType: "social_work_category", entityId: id, beforeData: before } };
  });
}

export async function updateNotification(prisma: AppPrisma, audit: AuditContext, id: string, data: JsonObject) {
  const before = await prisma.notification.findFirst({ where: { id, organizationId: audit.organizationId } });
  if (!before) return null;
  return withAudit(prisma, audit, async (tx) => {
    const isRead = typeof data.isRead === "boolean" ? data.isRead : undefined;
    const result = await tx.notification.update({ where: { id }, data: {
      title: typeof data.title === "string" ? data.title : undefined,
      message: typeof data.message === "string" ? data.message : undefined,
      linkUrl: typeof data.linkUrl === "string" ? data.linkUrl || null : undefined,
      isRead, readAt: isRead === undefined ? undefined : isRead ? new Date() : null,
    }});
    return { result, event: { action: "NOTIFICATION_UPDATE", entityType: "notification", entityId: id, beforeData: before, afterData: result } };
  });
}

export async function deleteNotification(prisma: AppPrisma, audit: AuditContext, id: string) {
  const before = await prisma.notification.findFirst({ where: { id, organizationId: audit.organizationId } });
  if (!before) return null;
  return withAudit(prisma, audit, async (tx) => {
    const result = await tx.notification.delete({ where: { id } });
    return { result, event: { action: "NOTIFICATION_DELETE", entityType: "notification", entityId: id, beforeData: before } };
  });
}

export async function updateAdminUser(prisma: AppPrisma, audit: AuditContext, id: string, data: { status?: string; roleIds?: string[] }) {
  const before = await prisma.adminUser.findFirst({ where: { id, organizationId: audit.organizationId, deletedAt: null }, include: { roles: true } });
  if (!before) return null;
  if (data.status && data.status !== "active" && before.status === "active") {
    const systemAdmins = await prisma.adminUser.count({ where: { organizationId: audit.organizationId, status: "active", deletedAt: null, roles: { some: { role: { isSystemRole: true, isActive: true } } } } });
    const isSystemAdmin = await prisma.adminUserRole.count({ where: { adminUserId: id, role: { isSystemRole: true, isActive: true } } });
    if (systemAdmins <= 1 && isSystemAdmin > 0) throw new Error("Cannot deactivate the final active system administrator");
  }
  if (data.roleIds) {
    const validRoles = await prisma.role.count({ where: { id: { in: data.roleIds }, organizationId: audit.organizationId, isActive: true } });
    if (validRoles !== new Set(data.roleIds).size) throw new Error("One or more roles are invalid");
    if (data.roleIds.length === 0) throw new Error("An admin user must retain at least one role");
    const currentlySystemAdmin = await prisma.adminUserRole.count({ where: { adminUserId: id, role: { isSystemRole: true, isActive: true } } });
    const keepsSystemAdmin = await prisma.role.count({ where: { id: { in: data.roleIds }, organizationId: audit.organizationId, isSystemRole: true, isActive: true } });
    if (currentlySystemAdmin && !keepsSystemAdmin) { const systemAdmins = await prisma.adminUser.count({ where: { organizationId: audit.organizationId, status: "active", deletedAt: null, roles: { some: { role: { isSystemRole: true, isActive: true } } } } }); if (systemAdmins <= 1) throw new Error("Cannot remove the system role from the final active system administrator"); }
  }
  return withAudit(prisma, audit, async (tx) => {
    if (data.roleIds) {
      await tx.adminUserRole.deleteMany({ where: { adminUserId: id } });
      await tx.adminUserRole.createMany({ data: [...new Set(data.roleIds)].map((roleId) => ({ adminUserId: id, roleId })) });
    }
    const result = await tx.adminUser.update({ where: { id }, data: { status: data.status }, include: { roles: { include: { role: true } } } });
    return { result, event: { action: "ADMIN_USER_UPDATE", entityType: "admin_user", entityId: id, beforeData: before, afterData: result } };
  });
}

export async function resolveRejectedRecord(prisma: AppPrisma, audit: AuditContext, id: string) {
  const before = await prisma.rejectedRecord.findFirst({ where: { id, organizationId: audit.organizationId } });
  if (!before) return null;
  return withAudit(prisma, audit, async (tx) => {
    const result = await tx.rejectedRecord.update({ where: { id }, data: { correctionStatus: "resolved", resolvedBy: audit.actorUserId, resolvedAt: new Date() } });
    return { result, event: { action: "IMPORT_REJECTION_RESOLVE", entityType: "rejected_record", entityId: id, beforeData: before, afterData: result } };
  });
}

export async function updateSettingsBundle(prisma: AppPrisma, audit: AuditContext, organizationData: JsonObject | undefined, uiState: JsonObject | undefined, websiteData?: JsonObject) {
  return withAudit(prisma, audit, async (tx) => {
    const beforeOrganization = await tx.organization.findUnique({ where: { id: audit.organizationId } });
    const beforeWebsite = await tx.websiteSetting.findUnique({ where: { organizationId: audit.organizationId } });
    const organization = organizationData ? await tx.organization.update({ where: { id: audit.organizationId }, data: {
      name: typeof organizationData.name === "string" ? organizationData.name : undefined,
      legalName: organizationData.legalName === null ? null : typeof organizationData.legalName === "string" ? organizationData.legalName : undefined,
      email: typeof organizationData.email === "string" ? organizationData.email || null : undefined,
      phone: organizationData.phone === null ? null : typeof organizationData.phone === "string" ? organizationData.phone || null : undefined,
      addressLine1: organizationData.addressLine1 === null ? null : typeof organizationData.addressLine1 === "string" ? organizationData.addressLine1 : undefined,
      addressLine2: organizationData.addressLine2 === null ? null : typeof organizationData.addressLine2 === "string" ? organizationData.addressLine2 : undefined,
      city: organizationData.city === null ? null : typeof organizationData.city === "string" ? organizationData.city : undefined,
      state: organizationData.state === null ? null : typeof organizationData.state === "string" ? organizationData.state : undefined,
      postalCode: organizationData.postalCode === null ? null : typeof organizationData.postalCode === "string" ? organizationData.postalCode : undefined,
      country: typeof organizationData.country === "string" ? organizationData.country : undefined,
      websiteUrl: typeof organizationData.websiteUrl === "string" ? organizationData.websiteUrl || null : undefined,
      settings: organizationData.settings && typeof organizationData.settings === "object" && !Array.isArray(organizationData.settings) ? json(organizationData.settings) : undefined,
    } }) : beforeOrganization;
    let websiteSetting = beforeWebsite;
    if (uiState || websiteData) {
      const customFields = beforeWebsite?.customFields && typeof beforeWebsite.customFields === "object" && !Array.isArray(beforeWebsite.customFields) ? { ...(beforeWebsite.customFields as JsonObject) } : {};
      if (uiState) customFields.adminUiState = uiState;
      const values = { siteTitle: websiteData?.siteTitle === null ? null : typeof websiteData?.siteTitle === "string" ? websiteData.siteTitle : undefined, tagline: websiteData?.tagline === null ? null : typeof websiteData?.tagline === "string" ? websiteData.tagline : undefined, contactEmail: websiteData?.contactEmail === null ? null : typeof websiteData?.contactEmail === "string" ? websiteData.contactEmail || null : undefined, contactPhone: websiteData?.contactPhone === null ? null : typeof websiteData?.contactPhone === "string" ? websiteData.contactPhone || null : undefined, address: websiteData?.address === null ? null : typeof websiteData?.address === "string" ? websiteData.address : undefined, socialLinks: websiteData?.socialLinks && typeof websiteData.socialLinks === "object" ? json(websiteData.socialLinks) : undefined, featureFlags: websiteData?.featureFlags && typeof websiteData.featureFlags === "object" ? json(websiteData.featureFlags) : undefined, publicSettings: websiteData?.publicSettings && typeof websiteData.publicSettings === "object" ? json(websiteData.publicSettings) : undefined, customFields: json(customFields), updatedBy: audit.actorUserId };
      websiteSetting = await tx.websiteSetting.upsert({ where: { organizationId: audit.organizationId }, create: { organizationId: audit.organizationId, ...values }, update: values });
    }
    const result = { organization, websiteSetting };
    return { result, event: { action: "SETTINGS_UPDATE", entityType: "settings", beforeData: { organization: beforeOrganization, websiteSetting: beforeWebsite }, afterData: result } };
  });
}
