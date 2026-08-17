import { Router } from "express";
import { z } from "zod";
import { PERMISSIONS, requirePermission } from "../auth/permissions";
import { AuthenticatedRequest, requireAuth } from "../middleware/requireAuth";
import { requestAuditContext, withAudit } from "../services/audit.service";

const router = Router();
const customFields = z.record(z.string(), z.unknown()).optional();
const nullableDate = z.string().date().nullable().optional();

router.get("/", requireAuth, requirePermission(PERMISSIONS.membersRead), async (req, res) => {
  const organizationId = req.user!.organizationId;
  const [positions, terms, assignments] = await Promise.all([
    req.prisma.managementPosition.findMany({ where: { organizationId }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }),
    req.prisma.managementTerm.findMany({ where: { organizationId }, orderBy: { startDate: "desc" } }),
    req.prisma.managementAssignment.findMany({ where: { organizationId }, include: { member: true, position: true, term: true }, orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }] }),
  ]);
  return res.json({ success: true, data: { positions, terms, assignments } });
});

router.post("/positions", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req, res) => {
  try {
    const data = z.object({ code: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(150), displayOrder: z.number().int().optional(), description: z.string().nullable().optional(), isActive: z.boolean().optional(), customFields }).strict().parse(req.body);
    const result = await withAudit(req.prisma, requestAuditContext(req), async (tx) => {
      const created = await tx.managementPosition.create({ data: { organizationId: req.user!.organizationId, ...data, description: data.description ?? null, customFields: data.customFields as never } });
      return { result: created, event: { action: "MANAGEMENT_POSITION_CREATE", entityType: "management_position", entityId: created.id, afterData: created } };
    });
    return res.status(201).json({ success: true, data: result });
  } catch (error) { return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid position" }); }
});

router.put("/positions/:id", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req, res) => {
  try {
    const data = z.object({ code: z.string().trim().min(1).max(80).optional(), name: z.string().trim().min(1).max(150).optional(), displayOrder: z.number().int().optional(), description: z.string().nullable().optional(), isActive: z.boolean().optional(), customFields }).strict().parse(req.body);
    const before = await req.prisma.managementPosition.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId } });
    if (!before) return res.status(404).json({ success: false, message: "Position not found" });
    const result = await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const updated = await tx.managementPosition.update({ where: { id: before.id }, data: data as never }); return { result: updated, event: { action: "MANAGEMENT_POSITION_UPDATE", entityType: "management_position", entityId: updated.id, beforeData: before, afterData: updated } }; });
    return res.json({ success: true, data: result });
  } catch (error) { return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid position" }); }
});

router.delete("/positions/:id", requireAuth, requirePermission(PERMISSIONS.membersDelete), async (req, res) => {
  const before = await req.prisma.managementPosition.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId }, include: { _count: { select: { assignments: true } } } });
  if (!before) return res.status(404).json({ success: false, message: "Position not found" });
  if (before._count.assignments) return res.status(409).json({ success: false, message: "Position is assigned and cannot be deleted" });
  await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const deleted = await tx.managementPosition.delete({ where: { id: before.id } }); return { result: deleted, event: { action: "MANAGEMENT_POSITION_DELETE", entityType: "management_position", entityId: before.id, beforeData: before } }; });
  return res.json({ success: true });
});

router.post("/terms", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req, res) => {
  try {
    const data = z.object({ name: z.string().trim().min(1).max(180), startDate: z.string().date(), endDate: nullableDate, status: z.string().trim().min(1).max(30).optional(), notes: z.string().nullable().optional(), customFields }).strict().parse(req.body);
    if (data.endDate && data.endDate < data.startDate) throw new Error("End date must not precede start date");
    const result = await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const created = await tx.managementTerm.create({ data: { organizationId: req.user!.organizationId, name: data.name, startDate: new Date(data.startDate), endDate: data.endDate ? new Date(data.endDate) : null, status: data.status, notes: data.notes, customFields: data.customFields as never } }); return { result: created, event: { action: "MANAGEMENT_TERM_CREATE", entityType: "management_term", entityId: created.id, afterData: created } }; });
    return res.status(201).json({ success: true, data: result });
  } catch (error) { return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid term" }); }
});

router.put("/terms/:id", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req, res) => {
  try {
    const data = z.object({ name: z.string().trim().min(1).max(180).optional(), startDate: z.string().date().optional(), endDate: nullableDate, status: z.string().trim().min(1).max(30).optional(), notes: z.string().nullable().optional(), customFields }).strict().parse(req.body);
    const before = await req.prisma.managementTerm.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId } });
    if (!before) return res.status(404).json({ success: false, message: "Term not found" });
    const start = data.startDate ?? before.startDate.toISOString().slice(0, 10); const end = data.endDate === undefined ? before.endDate?.toISOString().slice(0, 10) : data.endDate;
    if (end && end < start) throw new Error("End date must not precede start date");
    const result = await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const updated = await tx.managementTerm.update({ where: { id: before.id }, data: { ...data, startDate: data.startDate ? new Date(data.startDate) : undefined, endDate: data.endDate === null ? null : data.endDate ? new Date(data.endDate) : undefined, customFields: data.customFields as never } }); return { result: updated, event: { action: "MANAGEMENT_TERM_UPDATE", entityType: "management_term", entityId: updated.id, beforeData: before, afterData: updated } }; });
    return res.json({ success: true, data: result });
  } catch (error) { return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid term" }); }
});

router.delete("/terms/:id", requireAuth, requirePermission(PERMISSIONS.membersDelete), async (req, res) => {
  const before = await req.prisma.managementTerm.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId }, include: { _count: { select: { assignments: true } } } });
  if (!before) return res.status(404).json({ success: false, message: "Term not found" });
  if (before._count.assignments) return res.status(409).json({ success: false, message: "Term is assigned and cannot be deleted" });
  await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const deleted = await tx.managementTerm.delete({ where: { id: before.id } }); return { result: deleted, event: { action: "MANAGEMENT_TERM_DELETE", entityType: "management_term", entityId: before.id, beforeData: before } }; });
  return res.json({ success: true });
});

const assignmentSchema = z.object({ memberId: z.string().uuid(), positionId: z.string().uuid(), termId: z.string().uuid(), startDate: nullableDate, endDate: nullableDate, displayOrder: z.number().int().optional(), notes: z.string().nullable().optional(), customFields }).strict();
async function validateRelations(req: AuthenticatedRequest, data: { memberId: string; positionId: string; termId: string }) {
  const organizationId = req.user!.organizationId;
  const [member, position, term] = await Promise.all([req.prisma.member.findFirst({ where: { id: data.memberId, organizationId, deletedAt: null } }), req.prisma.managementPosition.findFirst({ where: { id: data.positionId, organizationId, isActive: true } }), req.prisma.managementTerm.findFirst({ where: { id: data.termId, organizationId } })]);
  if (!member || !position || !term) throw new Error("Member, active position, and term must belong to your organization");
}

router.post("/assignments", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req, res) => {
  try { const data = assignmentSchema.parse(req.body); await validateRelations(req, data); if (data.startDate && data.endDate && data.endDate < data.startDate) throw new Error("End date must not precede start date");
    const duplicate = await req.prisma.managementAssignment.findFirst({ where: { organizationId: req.user!.organizationId, memberId: data.memberId, positionId: data.positionId, termId: data.termId } }); if (duplicate) throw new Error("This member already has that position in the selected term");
    const result = await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const created = await tx.managementAssignment.create({ data: { organizationId: req.user!.organizationId, ...data, startDate: data.startDate ? new Date(data.startDate) : null, endDate: data.endDate ? new Date(data.endDate) : null, customFields: data.customFields as never }, include: { member: true, position: true, term: true } }); return { result: created, event: { action: "MANAGEMENT_ASSIGNMENT_CREATE", entityType: "management_assignment", entityId: created.id, afterData: created } }; }); return res.status(201).json({ success: true, data: result });
  } catch (error) { return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid assignment" }); }
});

router.put("/assignments/:id", requireAuth, requirePermission(PERMISSIONS.membersWrite), async (req, res) => {
  try { const data = assignmentSchema.partial().parse(req.body); const before = await req.prisma.managementAssignment.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId } }); if (!before) return res.status(404).json({ success: false, message: "Assignment not found" }); const relations = { memberId: data.memberId ?? before.memberId, positionId: data.positionId ?? before.positionId, termId: data.termId ?? before.termId }; await validateRelations(req, relations);
    const duplicate = await req.prisma.managementAssignment.findFirst({ where: { organizationId: req.user!.organizationId, memberId: relations.memberId, positionId: relations.positionId, termId: relations.termId, id: { not: before.id } } }); if (duplicate) throw new Error("This member already has that position in the selected term");
    const result = await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const updated = await tx.managementAssignment.update({ where: { id: before.id }, data: { ...data, startDate: data.startDate === null ? null : data.startDate ? new Date(data.startDate) : undefined, endDate: data.endDate === null ? null : data.endDate ? new Date(data.endDate) : undefined, customFields: data.customFields as never }, include: { member: true, position: true, term: true } }); return { result: updated, event: { action: "MANAGEMENT_ASSIGNMENT_UPDATE", entityType: "management_assignment", entityId: updated.id, beforeData: before, afterData: updated } }; }); return res.json({ success: true, data: result });
  } catch (error) { return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid assignment" }); }
});

router.delete("/assignments/:id", requireAuth, requirePermission(PERMISSIONS.membersDelete), async (req, res) => { const before = await req.prisma.managementAssignment.findFirst({ where: { id: String(req.params.id), organizationId: req.user!.organizationId } }); if (!before) return res.status(404).json({ success: false, message: "Assignment not found" }); await withAudit(req.prisma, requestAuditContext(req), async (tx) => { const deleted = await tx.managementAssignment.delete({ where: { id: before.id } }); return { result: deleted, event: { action: "MANAGEMENT_ASSIGNMENT_DELETE", entityType: "management_assignment", entityId: before.id, beforeData: before } }; }); return res.json({ success: true }); });

export default router;
