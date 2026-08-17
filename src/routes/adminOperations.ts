import { Router } from "express";
import { z } from "zod";
import { PERMISSIONS, requirePermission } from "../auth/permissions";
import { requireAuth } from "../middleware/requireAuth";
import { requestAuditContext } from "../services/audit.service";
import {
  createSocialWorkCategory,
  deleteNotification,
  deleteSocialWorkCategory,
  getDashboard,
  resolveRejectedRecord,
  updateAdminUser,
  updateNotification,
  updateSocialWorkCategory,
  updateSettingsBundle,
} from "../services/adminOperations.service";
import { commitImport, createExportWorkbook, ImportCommitError } from "../services/importExport.service";

const router = Router();
const objectSchema = z.record(z.string(), z.unknown());
const organizationSettingsSchema = z.object({ name: z.string().trim().min(1).optional(), legalName: z.string().nullable().optional(), email: z.string().email().or(z.literal("")).optional(), phone: z.string().nullable().optional(), addressLine1: z.string().nullable().optional(), addressLine2: z.string().nullable().optional(), city: z.string().nullable().optional(), state: z.string().nullable().optional(), postalCode: z.string().nullable().optional(), country: z.string().trim().min(1).optional(), websiteUrl: z.string().url().or(z.literal("")).nullable().optional(), settings: objectSchema.optional() }).strict();
const websiteSettingsSchema = z.object({ siteTitle: z.string().nullable().optional(), tagline: z.string().nullable().optional(), contactEmail: z.string().email().or(z.literal("")).nullable().optional(), contactPhone: z.string().nullable().optional(), address: z.string().nullable().optional(), socialLinks: objectSchema.or(z.array(z.unknown())).optional(), featureFlags: objectSchema.optional(), publicSettings: objectSchema.optional() }).strict();

router.put("/settings", requireAuth, requirePermission(PERMISSIONS.settingsWrite), async (req, res) => {
  try {
    const data = z.object({ organization: organizationSettingsSchema.optional(), uiState: objectSchema.optional(), websiteSetting: websiteSettingsSchema.optional() }).strict().refine((value) => value.organization || value.uiState || value.websiteSetting, "No settings supplied").parse(req.body);
    const result = await updateSettingsBundle(req.prisma, requestAuditContext(req), data.organization, data.uiState, data.websiteSetting);
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid settings" });
  }
});

router.get("/dashboard", requireAuth, requirePermission(PERMISSIONS.dashboardRead), async (req, res) => {
  const data = await getDashboard(req.prisma, req.user!.organizationId);
  return res.json({ success: true, data });
});

router.post("/social-work/categories", requireAuth, requirePermission(PERMISSIONS.socialWorkWrite), async (req, res) => {
  try {
    const data = objectSchema.parse(req.body);
    if (!String(data.name ?? "").trim()) throw new Error("Name is required");
    const result = await createSocialWorkCategory(req.prisma, requestAuditContext(req), data);
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid category" });
  }
});

router.put("/social-work/categories/:id", requireAuth, requirePermission(PERMISSIONS.socialWorkWrite), async (req, res) => {
  try {
    const result = await updateSocialWorkCategory(req.prisma, requestAuditContext(req), String(req.params.id), objectSchema.parse(req.body));
    return result ? res.json({ success: true, data: result }) : res.status(404).json({ success: false, message: "Category not found" });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid category" });
  }
});

router.delete("/social-work/categories/:id", requireAuth, requirePermission(PERMISSIONS.socialWorkDelete), async (req, res) => {
  try {
    const result = await deleteSocialWorkCategory(req.prisma, requestAuditContext(req), String(req.params.id));
    return result ? res.json({ success: true }) : res.status(404).json({ success: false, message: "Category not found" });
  } catch (error) {
    return res.status(409).json({ success: false, message: error instanceof Error ? error.message : "Unable to delete category" });
  }
});

router.patch("/notifications/:id", requireAuth, requirePermission(PERMISSIONS.notificationsWrite), async (req, res) => {
  const result = await updateNotification(req.prisma, requestAuditContext(req), String(req.params.id), objectSchema.parse(req.body));
  return result ? res.json({ success: true, data: result }) : res.status(404).json({ success: false, message: "Notification not found" });
});

router.delete("/notifications/:id", requireAuth, requirePermission(PERMISSIONS.notificationsWrite), async (req, res) => {
  const result = await deleteNotification(req.prisma, requestAuditContext(req), String(req.params.id));
  return result ? res.json({ success: true }) : res.status(404).json({ success: false, message: "Notification not found" });
});

router.patch("/admin-users/:id", requireAuth, requirePermission(PERMISSIONS.adminUsersWrite), requirePermission(PERMISSIONS.rolesManage), async (req, res) => {
  try {
    const data = z.object({ status: z.enum(["active", "suspended", "archived"]).optional(), roleIds: z.array(z.string().uuid()).optional() }).parse(req.body);
    if (data.roleIds && !req.authorization!.isSystemRole) { const roles = await req.prisma.role.findMany({ where: { id: { in: data.roleIds }, organizationId: req.user!.organizationId, isActive: true }, include: { permissions: { include: { permission: true } } } }); if (roles.some((role) => role.isSystemRole || role.permissions.some(({ permission }) => !req.authorization!.permissions.has(permission.code)))) throw new Error("Cannot assign a role containing permissions you do not hold"); }
    const result = await updateAdminUser(req.prisma, requestAuditContext(req), String(req.params.id), data);
    return result ? res.json({ success: true, data: result }) : res.status(404).json({ success: false, message: "Admin user not found" });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid admin user update" });
  }
});

router.patch("/rejected-records/:id/resolve", requireAuth, requirePermission(PERMISSIONS.importExport), async (req, res) => {
  const result = await resolveRejectedRecord(req.prisma, requestAuditContext(req), String(req.params.id));
  return result ? res.json({ success: true, data: result }) : res.status(404).json({ success: false, message: "Rejected record not found" });
});

router.post("/imports", requireAuth, requirePermission(PERMISSIONS.importExport), async (req, res) => {
  try {
    const data = z.object({
      entityType: z.enum(["members", "events", "social_work", "announcements"]),
      filename: z.string().trim().min(1).max(500),
      rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
    }).parse(req.body);
    const result = await commitImport(req.prisma, requestAuditContext(req), data.entityType, data.filename, data.rows);
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("IMPORT_COMMIT_ERROR:", error);
    if (error instanceof ImportCommitError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Unable to commit import. No imported records were saved." });
  }
});

router.get("/exports/:entityType", requireAuth, requirePermission(PERMISSIONS.importExport), async (req, res) => {
  const parsed = z.enum(["members", "events", "social_work", "announcements"]).safeParse(req.params.entityType);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Unsupported export type" });
  const buffer = await createExportWorkbook(req.prisma, req.user!.organizationId, parsed.data);
  const record = await req.prisma.$transaction(async (tx) => {
    const created = await tx.dataExport.create({ data: { organizationId: req.user!.organizationId, requestedBy: req.user!.userId, entityType: parsed.data, format: "xlsx", status: "completed", completedAt: new Date(), filters: {} } });
    await tx.auditLog.create({ data: { organizationId: req.user!.organizationId, actorUserId: req.user!.userId, action: "DATA_EXPORT", entityType: "data_export", entityId: created.id, metadata: { actorRoles: req.authorization!.roleNames, exportedEntityType: parsed.data, format: "xlsx" } } });
    return created;
  });
  return res.json({ success: true, exportId: record.id, filename: `${parsed.data}-export-${new Date().toISOString().slice(0,10)}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBase64: buffer.toString("base64") });
});

router.get("/import-history", requireAuth, requirePermission(PERMISSIONS.importExport), async (req, res) => {
  const data = await req.prisma.importBatch.findMany({ where: { organizationId: req.user!.organizationId }, include: { uploader: { select: { id: true, displayName: true, email: true } }, records: { include: { rejection: true }, orderBy: { rowNumber: "asc" } } }, orderBy: { createdAt: "desc" }, take: 200 });
  return res.json({ success: true, data });
});

router.get("/export-history", requireAuth, requirePermission(PERMISSIONS.importExport), async (req, res) => {
  const data = await req.prisma.dataExport.findMany({ where: { organizationId: req.user!.organizationId }, include: { requester: { select: { id: true, displayName: true, email: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
  return res.json({ success: true, data });
});

router.get("/audit-logs", requireAuth, requirePermission(PERMISSIONS.auditRead), async (req, res) => {
  const data = await req.prisma.auditLog.findMany({ where: { organizationId: req.user!.organizationId }, include: { actor: { select: { displayName: true, roles: { include: { role: true } } } } }, orderBy: { createdAt: "desc" }, take: 500 });
  return res.json({ success: true, data });
});

router.get("/permissions", requireAuth, requirePermission(PERMISSIONS.rolesManage), async (req, res) => {
  const data = await req.prisma.permission.findMany({ orderBy: [{ module: "asc" }, { code: "asc" }] });
  return res.json({ success: true, data });
});

router.post("/roles", requireAuth, requirePermission(PERMISSIONS.rolesManage), async (req, res) => {
  try {
    const data = z.object({ code: z.string().trim().min(1), name: z.string().trim().min(1), description: z.string().optional(), permissionIds: z.array(z.string().uuid()).default([]) }).parse(req.body);
    const permissions = await req.prisma.permission.findMany({ where: { id: { in: data.permissionIds } } });
    if (permissions.length !== new Set(data.permissionIds).size) throw new Error("One or more permissions are invalid");
    if (!req.authorization!.isSystemRole && permissions.some((permission) => !req.authorization!.permissions.has(permission.code))) throw new Error("Cannot grant a permission you do not hold");
    const role = await req.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({ data: { organizationId: req.user!.organizationId, code: data.code, name: data.name, description: data.description, permissions: { create: data.permissionIds.map((permissionId) => ({ permissionId })) } }, include: { permissions: { include: { permission: true } } } });
      await tx.auditLog.create({ data: { organizationId: req.user!.organizationId, actorUserId: req.user!.userId, action: "ROLE_CREATE", entityType: "role", entityId: created.id, afterData: created as never, metadata: { actorRoles: req.authorization!.roleNames } } });
      return created;
    });
    return res.status(201).json({ success: true, data: role });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid role" });
  }
});

router.put("/roles/:id", requireAuth, requirePermission(PERMISSIONS.rolesManage), async (req, res) => {
  try {
    const data = z.object({ name: z.string().trim().min(1).optional(), description: z.string().optional(), isActive: z.boolean().optional(), permissionIds: z.array(z.string().uuid()).optional() }).parse(req.body);
    const existing = await req.prisma.role.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId }, include: { users: true, permissions: true } });
    if (!existing) return res.status(404).json({ success: false, message: "Role not found" });
    if (existing.isSystemRole && data.isActive === false) throw new Error("System roles cannot be deactivated");
    if (data.permissionIds) {
      const permissions = await req.prisma.permission.findMany({ where: { id: { in: data.permissionIds } } });
      if (permissions.length !== new Set(data.permissionIds).size) throw new Error("One or more permissions are invalid");
      if (!req.authorization!.isSystemRole && permissions.some((permission) => !req.authorization!.permissions.has(permission.code))) throw new Error("Cannot grant a permission you do not hold");
    }
    const role = await req.prisma.$transaction(async (tx) => {
      if (data.permissionIds) { await tx.rolePermission.deleteMany({ where: { roleId: existing.id } }); await tx.rolePermission.createMany({ data: [...new Set(data.permissionIds)].map((permissionId) => ({ roleId: existing.id, permissionId })) }); }
      const updated = await tx.role.update({ where: { id: existing.id }, data: { name: data.name, description: data.description, isActive: data.isActive }, include: { permissions: { include: { permission: true } } } });
      await tx.auditLog.create({ data: { organizationId: req.user!.organizationId, actorUserId: req.user!.userId, action: "ROLE_UPDATE", entityType: "role", entityId: existing.id, beforeData: existing as never, afterData: updated as never, metadata: { actorRoles: req.authorization!.roleNames } } });
      return updated;
    });
    return res.json({ success: true, data: role });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid role update" });
  }
});

export default router;
