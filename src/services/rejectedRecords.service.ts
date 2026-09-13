import { Prisma } from "@prisma/client";
import { AppPrisma } from "../config/prisma";
import { AuditContext, withAudit } from "./audit.service";
import { persistImportRow, validateImportRows } from "./importExport.service";

export type RejectionAction = "dismiss" | "delete" | "retry" | "save";
const include = { importRecord: { include: { batch: true } } } as const;
class RetryPersistenceError extends Error {
  constructor(public reason: string, public rows: Record<string, string>, public version: Date) { super(reason); }
}

export async function listRejectedRecords(prisma: AppPrisma, organizationId: string, status: string, module: string, page: number) {
  const where: Prisma.RejectedRecordWhereInput = {
    organizationId,
    ...(status === "all" ? {} : { correctionStatus: status === "closed" ? { in: ["resolved", "dismissed"] } : "open" }),
    ...(module === "all" ? {} : { importRecord: { batch: { entityType: module } } }),
  };
  const [records, total] = await Promise.all([
    prisma.rejectedRecord.findMany({ where, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 50, take: 50 }),
    prisma.rejectedRecord.count({ where }),
  ]);
  return { records, total, page, pageSize: 50 };
}

export async function manageRejectedRecord(prisma: AppPrisma, audit: AuditContext, id: string, action: RejectionAction, correctedData?: Record<string, string>) {
  // Serializable isolation prevents simultaneous retries from importing a row twice.
  const run = async () => prisma.$transaction(async (tx) => {
    const before = await tx.rejectedRecord.findFirst({ where: { id, organizationId: audit.organizationId }, include });
    if (!before) throw new Error("Rejected record not found");
    const record = before.importRecord;
    if (record.organizationId !== audit.organizationId || record.batch.organizationId !== audit.organizationId) throw new Error("Rejected record not found");
    const event = async (result: unknown, outcome: string) => {
      await tx.auditLog.create({ data: { organizationId: audit.organizationId, actorUserId: audit.actorUserId, requestId: audit.requestId, ipAddress: audit.ipAddress, userAgent: audit.userAgent, action: `IMPORT_REJECTION_${action.toUpperCase()}`, entityType: "rejected_record", entityId: id, metadata: { actorRoles: audit.actorRoleNames, outcome, importRecordId: record.id } } });
      return { id, outcome, record: result };
    };
    if (action === "delete") {
      await tx.rejectedRecord.delete({ where: { id } });
      return event(null, "deleted");
    }
    if (action === "dismiss") {
      const result = await tx.rejectedRecord.update({ where: { id }, data: { correctionStatus: before.correctionStatus === "resolved" ? "resolved" : "dismissed", resolvedBy: audit.actorUserId, resolvedAt: new Date() }, include });
      return event(result, "dismissed");
    }
    if (record.targetEntityId) throw new Error("This record is already imported and cannot be imported again");
    const source = { ...(record.sourceData as Record<string, unknown>), ...(before.correctedData as Record<string, unknown>), ...correctedData };
    const rows = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value ?? "")]));
    if (action === "save") {
      const result = await tx.rejectedRecord.update({ where: { id }, data: { correctedData: rows }, include });
      return event(result, "saved");
    }
    const type = record.batch.entityType;
    if (type !== "members" && type !== "events" && type !== "social_work" && type !== "announcements") throw new Error("This legacy module cannot be retried; you can dismiss or delete its warning");
    const validation = await validateImportRows(tx, audit.organizationId, type, [rows]);
    const reason = validation.rejected[0]?.error ?? validation.skipped[0]?.reason;
    if (reason) {
      await tx.importRecord.update({ where: { id: record.id }, data: { validationErrors: [reason], processedAt: new Date() } });
      const result = await tx.rejectedRecord.update({ where: { id }, data: { correctedData: rows, correctionStatus: "open", rejectionCode: "VALIDATION_ERROR", rejectionReason: reason, resolvedAt: null, resolvedBy: null }, include });
      return event(result, "failed");
    }
    const item = validation.accepted[0];
    let targetEntityId: string;
    try { targetEntityId = await persistImportRow(tx, audit, type, item); }
    catch (error) {
      const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "";
      if (code === "P2034") throw error;
      throw new RetryPersistenceError(code === "P2002" ? "A record with this unique code already exists" : code === "P2000" ? "A field exceeds the database length limit" : code === "P2003" ? "A referenced record is no longer available" : "Unable to save the imported row. Check its values and retry.", rows, before.updatedAt);
    }
    await tx.importRecord.update({ where: { id: record.id }, data: { status: "committed", recordKey: item.key, normalizedData: item.data as Prisma.InputJsonValue, validationErrors: [], targetEntityId, processedAt: new Date() } });
    await tx.importBatch.update({ where: { id: record.batchId }, data: { acceptedRecords: { increment: 1 }, committedRecords: { increment: 1 }, rejectedRecords: { decrement: 1 } } });
    const result = await tx.rejectedRecord.update({ where: { id }, data: { correctedData: rows, correctionStatus: "resolved", resolvedBy: audit.actorUserId, resolvedAt: new Date() }, include });
    return event(result, "imported");
  }, { isolationLevel: "Serializable", timeout: 30_000 });
  try { return await run(); }
  catch (error) {
    // A database error rolls back both the entity and resolution. Keep the latest reason
    // on the existing warning; never create a second rejection or overwrite a resolution.
    if (!(error instanceof RetryPersistenceError)) throw error;
    const reason = error.reason;
    return withAudit(prisma, audit, async (tx) => {
      const changed = await tx.rejectedRecord.updateMany({ where: { id, organizationId: audit.organizationId, updatedAt: error.version, importRecord: { targetEntityId: null } }, data: { correctedData: error.rows, correctionStatus: "open", rejectionCode: "PERSISTENCE_ERROR", rejectionReason: reason, resolvedBy: null, resolvedAt: null } });
      if (!changed.count) throw new Error("Record changed during retry; refresh the list");
      const result = await tx.rejectedRecord.findFirst({ where: { id, organizationId: audit.organizationId }, include });
      if (result) await tx.importRecord.update({ where: { id: result.importRecordId }, data: { validationErrors: [reason], processedAt: new Date() } });
      return { result: { id, outcome: "failed", record: result }, event: { action: "IMPORT_REJECTION_RETRY", entityType: "rejected_record", entityId: id, metadata: { outcome: "failed", reason } } };
    });
  }
}

export async function clearClosedRejectedRecords(prisma: AppPrisma, audit: AuditContext, module: string) {
  return withAudit(prisma, audit, async (tx) => {
    const result = await tx.rejectedRecord.deleteMany({ where: { organizationId: audit.organizationId, correctionStatus: { in: ["resolved", "dismissed"] }, ...(module === "all" ? {} : { importRecord: { batch: { entityType: module } } }) } });
    return { result, event: { action: "IMPORT_REJECTION_CLEAR", entityType: "rejected_record", metadata: { module, count: result.count } } };
  });
}
