import { Prisma } from "@prisma/client";
import { Request } from "express";
import { AppPrisma } from "../config/prisma";

export type TransactionClient = Prisma.TransactionClient;

export interface AuditContext {
  organizationId: string;
  actorUserId: string;
  actorRoleNames: string[];
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditEvent {
  action: string;
  entityType: string;
  entityId?: string;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: Record<string, unknown>;
}

function json(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalize = (input: unknown): unknown => {
    if (input === null) {
      return null;
    }

    if (input instanceof Date) {
      return input.toISOString();
    }

    if (typeof input === "bigint") {
      return input.toString();
    }

    if (typeof input === "string" || typeof input === "boolean") {
      return input;
    }

    if (typeof input === "number") {
      return Number.isFinite(input) ? input : null;
    }

    if (Array.isArray(input)) {
      return input.map((item) => normalize(item));
    }

    if (typeof input === "object") {
      const result: Record<string, unknown> = {};

      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        if (item !== undefined) {
          result[key] = normalize(item);
        }
      }

      return result;
    }

    return String(input);
  };

  const normalized = normalize(value);

  if (normalized === null) {
    return undefined;
  }

  return normalized as Prisma.InputJsonValue;
}

export function requestAuditContext(req: Request): AuditContext {
  return {
    organizationId: req.user!.organizationId,
    actorUserId: req.user!.userId,
    actorRoleNames: req.authorization?.roleNames ?? [],
    requestId: req.get("x-request-id"),
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  };
}

export async function withAudit<T>(
  prisma: AppPrisma,
  context: AuditContext,
  operation: (tx: TransactionClient) => Promise<{ result: T; event: AuditEvent }>,
): Promise<T> {
  return prisma.$transaction(
  async (tx) => {
    const { result, event } = await operation(tx);

    await tx.auditLog.create({
      data: {
        organizationId: context.organizationId,
        actorUserId: context.actorUserId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        beforeData: json(event.beforeData),
        afterData: json(event.afterData),
        metadata: json({
          ...(event.metadata ?? {}),
          actorRoles: context.actorRoleNames,
        }) ?? {},
      },
    });

    return result;
    },
  {
    timeout: 15000,
  },
);
}

export async function recordAudit(prisma: AppPrisma, context: AuditContext, event: AuditEvent) {
  return prisma.auditLog.create({ data: {
    organizationId: context.organizationId, actorUserId: context.actorUserId,
    action: event.action, entityType: event.entityType, entityId: event.entityId,
    requestId: context.requestId, ipAddress: context.ipAddress, userAgent: context.userAgent,
    beforeData: json(event.beforeData), afterData: json(event.afterData),
    metadata: json({ ...(event.metadata ?? {}), actorRoles: context.actorRoleNames }) ?? {},
  } });
}
