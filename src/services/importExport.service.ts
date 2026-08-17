import { Prisma } from "@prisma/client";
import { AppPrisma } from "../config/prisma";
import { AuditContext } from "./audit.service";
import * as XLSX from "xlsx";

type Row = Record<string, string>;
type EntityType = "members" | "events" | "social_work" | "announcements";
type Validated = { rowNumber: number; key: string; source: Row; data: Record<string, unknown> };
type Rejected = { rowNumber: number; key: string; source: Row; error: string };
export class ImportCommitError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 409 | 422 = 400,
  ) {
    super(message);
    this.name = "ImportCommitError";
  }
}

const yes = (value?: string) => String(value ?? "").trim().toLowerCase() === "yes";
const validBoolean = (input?: string) => !String(input ?? "").trim() || ["yes", "no", "true", "false", "1", "0"].includes(String(input).trim().toLowerCase());
const value = (row: Row, key: string) => String(row[key] ?? "").trim();
const firstValue = (row: Row, ...keys: string[]) => {
  for (const key of keys) {
    const candidate = value(row, key);
    if (candidate) return candidate;
  }
  return "";
};

const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const validDate = (text: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false; const parsed = new Date(`${text}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text; };
const asJson = (input: unknown) => input as Prisma.InputJsonValue;
function jsonObject(text: string, label: string) {
  if (!text) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${label} is invalid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

async function existingKeys(prisma: AppPrisma, organizationId: string, type: EntityType) {
  if (type === "members") return new Set((await prisma.member.findMany({ where: { organizationId }, select: { memberCode: true } })).flatMap((x) => x.memberCode ? [x.memberCode.toLowerCase()] : []));
  if (type === "events") return new Set((await prisma.event.findMany({ where: { organizationId }, select: { slug: true, customFields: true } })).flatMap((x) => [x.slug.toLowerCase(), String((x.customFields as Record<string, unknown>)?.event_code ?? "").toLowerCase()]));
  if (type === "social_work") return new Set((await prisma.socialWorkItem.findMany({ where: { organizationId }, select: { slug: true, customFields: true } })).flatMap((x) => [x.slug.toLowerCase(), String((x.customFields as Record<string, unknown>)?.activity_code ?? "").toLowerCase()]));
  return new Set((await prisma.announcement.findMany({ where: { organizationId }, select: { slug: true, customFields: true } })).flatMap((x) => [x.slug.toLowerCase(), String((x.customFields as Record<string, unknown>)?.announcement_code ?? "").toLowerCase()]));
}

export async function validateImportRows(prisma: AppPrisma, organizationId: string, type: EntityType, rows: Row[]) {
  const used = await existingKeys(prisma, organizationId, type);
  const socialWorkCategories = type === "social_work" ? new Set((await prisma.socialWorkCategory.findMany({ where: { organizationId, isActive: true }, select: { name: true } })).map((category) => category.name.toLowerCase())) : new Set<string>();
  const accepted: Validated[] = [];
  const rejected: Rejected[] = [];
  rows.forEach((source, index) => {
    const rowNumber = index + 2;
    const keyField = type === "members" ? "Member Code" : type === "events" ? "Event Code" : type === "social_work" ? "Activity Code" : "Announcement Code";
    const key = value(source, keyField);
    const reject = (error: string) => rejected.push({ rowNumber, key: key || `Row-${rowNumber}`, source, error });
    if (!key) return reject(`${keyField} is required`);
    if (used.has(key.toLowerCase())) return reject(`${keyField} must be unique`);

    if (type === "members") {
      const firstName = value(source, "First Name");
      if (!firstName) return reject("First Name is required");

      const managementRequested =
        yes(source["Current Management"]) ||
        Boolean(value(source, "Management Post"));
      if (managementRequested) {
        return reject(
          "Management assignments cannot be imported on the Member sheet. Create the member first, then assign a Management Position and Management Term.",
        );
      }

      const email = value(source, "Email");
      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        return reject("Email is invalid");
      }

      const gender = value(source, "Gender");
      if (gender && !["male", "female", "prefer not to say"].includes(gender.toLowerCase())) {
        return reject("Gender must be Male, Female, or Prefer not to say");
      }

      const memberStatus = firstValue(source, "Status", "Membership Status").toLowerCase() || "active";
      if (!["active", "archived"].includes(memberStatus)) {
        return reject("Status must be Active or Archived");
      }

      const dateOfBirth = value(source, "Date of Birth");
      const joinedOn = firstValue(source, "Joined Date", "Joined On");
      if (dateOfBirth && !validDate(dateOfBirth)) {
        return reject("Date of Birth must be YYYY-MM-DD");
      }
      if (joinedOn && !validDate(joinedOn)) {
        return reject("Joined Date must be YYYY-MM-DD");
      }

      const customFields: Record<string, unknown> = {
        category: firstValue(source, "Member Category", "Category") || "General",
        designation: value(source, "Designation") || "Member",
        visibility: {
          phone_public: false,
          email_public: false,
          address_public: false,
          photo_public: true,
          designation_public: true,
        },
      };

      const customFieldsText = value(source, "Custom Fields JSON");
      if (customFieldsText) {
        try {
          const parsed = JSON.parse(customFieldsText);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return reject("Custom Fields JSON must be an object");
          }
          Object.assign(customFields, parsed);
        } catch {
          return reject("Custom Fields JSON is invalid");
        }
      }

      let metadata: Record<string, unknown> = {};
      try {
        metadata = jsonObject(value(source, "Metadata JSON"), "Metadata JSON");
      } catch (error) {
        return reject((error as Error).message);
      }

      accepted.push({ rowNumber, key, source, data: { memberCode: key, firstName, middleName: value(source, "Middle Name") || null, lastName: value(source, "Last Name") || null, displayName: value(source, "Display Name") || null, gender: gender || null, dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00Z`) : null, phone: value(source, "Phone") || null, email: email || null, addressLine1: value(source, "Address Line 1") || null, addressLine2: value(source, "Address Line 2") || null, city: value(source, "City") || null, state: value(source, "State") || null, postalCode: value(source, "Postal Code") || null, country: value(source, "Country") || "India", membershipStatus: memberStatus, joinedOn: joinedOn ? new Date(`${joinedOn}T00:00:00Z`) : null, notes: value(source, "Notes") || null, metadata, customFields } });
    } else if (type === "events") {
      const title = value(source, "Event Title"); const date = value(source, "Event Date");
      if (!title) return reject("Event Title is required");
      if (!validDate(date)) return reject("Event Date must be YYYY-MM-DD");
      const startTime = value(source, "Start Time") || "00:00"; const endTime = value(source, "End Time");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || (endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime))) return reject("Times must be HH:mm");
      if (!validBoolean(source.Featured) || !validBoolean(source["Countdown Enabled"])) return reject("Boolean fields must be Yes/No, True/False, or 1/0");
      const eventStatus = value(source, "Event Status").toLowerCase() || "upcoming"; if (!["upcoming", "ongoing", "completed", "cancelled"].includes(eventStatus)) return reject("Event Status is invalid");
      const displayStatus = value(source, "Display Status").toLowerCase() || "active"; if (!["active", "archived"].includes(displayStatus)) return reject("Display Status must be Active or Archived");
      const publishedAt = value(source, "Published Date"); if (publishedAt && !validDate(publishedAt)) return reject("Published Date must be YYYY-MM-DD");
      let extra: Record<string, unknown>; let metadata: Record<string, unknown>; try { extra = jsonObject(value(source, "Custom Fields JSON"), "Custom Fields JSON"); metadata = jsonObject(value(source, "Metadata JSON"), "Metadata JSON"); } catch (error) { return reject((error as Error).message); }
      accepted.push({ rowNumber, key, source, data: { title, slug: key, category: value(source, "Category") || null, summary: value(source, "Summary") || null, description: value(source, "Description") || null, venue: value(source, "Location") || null, startAt: new Date(`${date}T${startTime}:00`), endAt: endTime ? new Date(`${date}T${endTime}:00`) : null, status: displayStatus === "archived" ? "archived" : eventStatus, publishedAt: publishedAt ? new Date(`${publishedAt}T00:00:00Z`) : null, metadata, customFields: { ...extra, event_code: key, social_work_activity_title: value(source, "Social Work Activity Code") || undefined, address: value(source, "Address") || undefined, google_maps_url: value(source, "Google Maps URL") || undefined, featured: yes(source.Featured), countdown_enabled: yes(source["Countdown Enabled"]) } } });
    } else if (type === "social_work") {
      const title = value(source, "Title"); if (!title) return reject("Title is required");
      const categoryName = value(source, "Social Work Category"); if (categoryName && !socialWorkCategories.has(categoryName.toLowerCase())) return reject(`Social Work Category '${categoryName}' does not exist or is inactive`);
      const startDate = value(source, "Start Date"); if (startDate && !validDate(startDate)) return reject("Start Date must be YYYY-MM-DD");
      const endDate = value(source, "End Date"); if (endDate && !validDate(endDate)) return reject("End Date must be YYYY-MM-DD");
      if (!validBoolean(source.Featured)) return reject("Featured must be Yes/No, True/False, or 1/0");
      const publishedAt = value(source, "Published Date"); if (publishedAt && !validDate(publishedAt)) return reject("Published Date must be YYYY-MM-DD");
      let extra: Record<string, unknown>; let metadata: Record<string, unknown>; try { extra = jsonObject(value(source, "Custom Fields JSON"), "Custom Fields JSON"); metadata = jsonObject(value(source, "Metadata JSON"), "Metadata JSON"); } catch (error) { return reject((error as Error).message); }
      accepted.push({ rowNumber, key, source, data: { title, slug: key || slugify(title), summary: value(source, "Summary") || null, description: value(source, "Description") || null, startDate: startDate ? new Date(startDate) : null, endDate: endDate ? new Date(endDate) : null, status: value(source, "Status").toLowerCase() || "published", displayOrder: Number(value(source, "Display Order")) || 0, publishedAt: publishedAt ? new Date(`${publishedAt}T00:00:00Z`) : null, categoryName, metadata, customFields: { ...extra, activity_code: key, type: value(source, "Activity Type") === "Individual Project" ? "Individual Project" : "Ongoing Initiative", location: value(source, "Location") || undefined, beneficiaries_count: Number(value(source, "Beneficiaries Count")) || 0, featured: yes(source.Featured) } } });
    } else {
      const title = value(source, "Title"); const body = value(source, "Content");
      if (!title || !body) return reject("Title and Content are required");
      const publishDate = value(source, "Publish Date"); if (publishDate && !validDate(publishDate)) return reject("Publish Date must be YYYY-MM-DD");
      const expiryDate = value(source, "Expiry Date"); if (expiryDate && !validDate(expiryDate)) return reject("Expiry Date must be YYYY-MM-DD");
      if (!validBoolean(source.Important) || !validBoolean(source.Featured)) return reject("Boolean fields must be Yes/No, True/False, or 1/0");
      let extra: Record<string, unknown>; let metadata: Record<string, unknown>; try { extra = jsonObject(value(source, "Custom Fields JSON"), "Custom Fields JSON"); metadata = jsonObject(value(source, "Metadata JSON"), "Metadata JSON"); } catch (error) { return reject((error as Error).message); }
      accepted.push({ rowNumber, key, source, data: { title, slug: key || slugify(title), summary: value(source, "Summary") || null, body, status: ["draft", "scheduled", "published", "archived"].includes(value(source, "Status").toLowerCase()) ? value(source, "Status").toLowerCase() : "published", publishedAt: publishDate ? new Date(publishDate) : null, expiresAt: expiryDate ? new Date(expiryDate) : null, metadata, customFields: { ...extra, announcement_code: key, important: yes(source.Important), featured: yes(source.Featured) } } });
    }
    used.add(key.toLowerCase());
  });
  return { accepted, rejected };
}

export async function commitImport(prisma: AppPrisma, audit: AuditContext, entityType: EntityType, filename: string, rows: Row[]) {
  const { accepted, rejected } = await validateImportRows(prisma, audit.organizationId, entityType, rows);
  try {
    return await prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.create({ data: { organizationId: audit.organizationId, uploadedBy: audit.actorUserId, entityType, originalFilename: filename, status: rejected.length ? "partially_accepted" : "completed", totalRecords: rows.length, acceptedRecords: accepted.length, rejectedRecords: rejected.length, committedRecords: accepted.length, startedAt: new Date(), completedAt: new Date(), metadata: { batch_code: `BATCH-${Date.now()}` } } });
    const createdIds: string[] = [];
    for (const item of accepted) {
      let targetEntityId: string;
      if (entityType === "members") { const d = item.data; targetEntityId = (await tx.member.create({ data: { organizationId: audit.organizationId, memberCode: String(d.memberCode), firstName: String(d.firstName), middleName: d.middleName as string | null, lastName: d.lastName as string | null, displayName: d.displayName as string | null, gender: d.gender as string | null, dateOfBirth: d.dateOfBirth as Date | null, phone: d.phone as string | null, email: d.email as string | null, addressLine1: d.addressLine1 as string | null, addressLine2: d.addressLine2 as string | null, city: d.city as string | null, state: d.state as string | null, postalCode: d.postalCode as string | null, country: String(d.country), membershipStatus: String(d.membershipStatus), joinedOn: d.joinedOn as Date | null, notes: d.notes as string | null, metadata: asJson(d.metadata), customFields: asJson(d.customFields) } })).id; }
      else if (entityType === "events") { const d = item.data; targetEntityId = (await tx.event.create({ data: { organizationId: audit.organizationId, title: String(d.title), slug: String(d.slug), category: d.category as string | null, summary: d.summary as string | null, description: d.description as string | null, venue: d.venue as string | null, startAt: d.startAt as Date, endAt: d.endAt as Date | null, status: String(d.status), publishedAt: d.publishedAt as Date | null, metadata: asJson(d.metadata), customFields: asJson(d.customFields), album: { create: { organizationId: audit.organizationId, title: String(d.title) } } } })).id; }
      else if (entityType === "social_work") { const d = item.data; let categoryId: string | null = null; if (d.categoryName) { const category = await tx.socialWorkCategory.findFirst({ where: { organizationId: audit.organizationId, name: { equals: String(d.categoryName), mode: "insensitive" }, isActive: true } }); if (!category) throw new Error(`Social Work Category '${d.categoryName}' does not exist or is inactive`); categoryId = category.id; } targetEntityId = (await tx.socialWorkItem.create({ data: { organizationId: audit.organizationId, title: String(d.title), slug: String(d.slug), summary: d.summary as string | null, description: d.description as string | null, startDate: d.startDate as Date | null, endDate: d.endDate as Date | null, status: String(d.status), displayOrder: Number(d.displayOrder), publishedAt: d.publishedAt as Date | null, categoryId, metadata: asJson(d.metadata), customFields: asJson(d.customFields) } })).id; }
      else { const d = item.data; targetEntityId = (await tx.announcement.create({ data: { organizationId: audit.organizationId, title: String(d.title), slug: String(d.slug), summary: d.summary as string | null, body: String(d.body), status: String(d.status), publishedAt: d.publishedAt as Date | null, expiresAt: d.expiresAt as Date | null, metadata: asJson(d.metadata), customFields: asJson(d.customFields) } })).id; }
      createdIds.push(targetEntityId);
      await tx.importRecord.create({ data: { organizationId: audit.organizationId, batchId: batch.id, rowNumber: item.rowNumber, recordKey: item.key, status: "committed", sourceData: asJson(item.source), normalizedData: asJson(item.data), validationErrors: [], targetEntityId, processedAt: new Date() } });
    }
    for (const item of rejected) {
      const record = await tx.importRecord.create({ data: { organizationId: audit.organizationId, batchId: batch.id, rowNumber: item.rowNumber, recordKey: item.key, status: "rejected", sourceData: asJson(item.source), normalizedData: {}, validationErrors: [item.error], processedAt: new Date() } });
      await tx.rejectedRecord.create({ data: { organizationId: audit.organizationId, importRecordId: record.id, rejectionCode: "VALIDATION_ERROR", rejectionReason: item.error } });
    }
    await tx.auditLog.create({ data: { organizationId: audit.organizationId, actorUserId: audit.actorUserId, action: "IMPORT_COMMIT", entityType: "import_batch", entityId: batch.id, metadata: { actorRoles: audit.actorRoleNames, importedEntityType: entityType, accepted: accepted.length, rejected: rejected.length, createdIds } } });
    return { batch, accepted: accepted.length, rejected: rejected.length };
    }, {
      // Excel imports can involve several dependent writes over a remote database connection.
      maxWait: 15_000,
      timeout: 60_000,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ImportCommitError(
        "Import could not be completed because one or more records already exist with a unique code. No imported records were saved.",
        409,
      );
    }

    const message = error instanceof Error ? error.message : "Unable to commit import";
    throw new ImportCommitError(
      `Import could not be completed: ${message}. No imported records were saved.`,
      422,
    );
  }
}

export async function exportData(prisma: AppPrisma, organizationId: string, entityType: EntityType) {
  if (entityType === "members") return prisma.member.findMany({ where: { organizationId, deletedAt: null } });
  if (entityType === "events") return prisma.event.findMany({ where: { organizationId, deletedAt: null } });
  if (entityType === "social_work") return prisma.socialWorkItem.findMany({ where: { organizationId, deletedAt: null } });
  return prisma.announcement.findMany({ where: { organizationId, deletedAt: null } });
}

const iso = (date: Date | null | undefined) => date ? date.toISOString() : "";
const jsonText = (input: unknown) => JSON.stringify(input ?? {});
export async function createExportWorkbook(prisma: AppPrisma, organizationId: string, entityType: EntityType) {
  const workbook = XLSX.utils.book_new();
  if (entityType === "members") {
    const [members, positions, terms, assignments] = await Promise.all([
      prisma.member.findMany({ where: { organizationId, deletedAt: null }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
      prisma.managementPosition.findMany({ where: { organizationId }, orderBy: { displayOrder: "asc" } }),
      prisma.managementTerm.findMany({ where: { organizationId }, orderBy: { startDate: "desc" } }),
      prisma.managementAssignment.findMany({ where: { organizationId }, include: { member: true, position: true, term: true }, orderBy: { displayOrder: "asc" } }),
    ]);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(members.map((m) => ({ "Member Code": m.memberCode ?? "", "First Name": m.firstName, "Middle Name": m.middleName ?? "", "Last Name": m.lastName ?? "", "Display Name": m.displayName ?? "", Gender: m.gender ?? "", "Date of Birth": iso(m.dateOfBirth).slice(0,10), Phone: m.phone ?? "", Email: m.email ?? "", "Address Line 1": m.addressLine1 ?? "", "Address Line 2": m.addressLine2 ?? "", City: m.city ?? "", State: m.state ?? "", "Postal Code": m.postalCode ?? "", Country: m.country, Status: m.membershipStatus, "Joined Date": iso(m.joinedOn).slice(0,10), Notes: m.notes ?? "", "Metadata JSON": jsonText(m.metadata), "Custom Fields JSON": jsonText(m.customFields) }))), "Members");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(positions.map((p) => ({ Code: p.code, Name: p.name, Description: p.description ?? "", "Display Order": p.displayOrder, Active: p.isActive ? "Yes" : "No", "Custom Fields JSON": jsonText(p.customFields) }))), "Management Positions");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(terms.map((t) => ({ Name: t.name, "Start Date": iso(t.startDate).slice(0,10), "End Date": iso(t.endDate).slice(0,10), Status: t.status, Notes: t.notes ?? "", "Custom Fields JSON": jsonText(t.customFields) }))), "Management Terms");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(assignments.map((a) => ({ "Member Code": a.member.memberCode ?? "", "Position Code": a.position.code, "Term Name": a.term.name, "Start Date": iso(a.startDate).slice(0,10), "End Date": iso(a.endDate).slice(0,10), "Display Order": a.displayOrder, Notes: a.notes ?? "", "Custom Fields JSON": jsonText(a.customFields) }))), "Management Assignments");
  } else {
    const records = await exportData(prisma, organizationId, entityType);
    const rows = records.map((record: any) => { const { id, organizationId: _org, coverMediaId: _cover, createdAt, updatedAt, deletedAt: _deleted, ...business } = record; return { ...business, startAt: iso(business.startAt), endAt: iso(business.endAt), startDate: iso(business.startDate).slice(0,10), endDate: iso(business.endDate).slice(0,10), publishedAt: iso(business.publishedAt), expiresAt: iso(business.expiresAt), metadata: jsonText(business.metadata), customFields: jsonText(business.customFields), createdAt: iso(createdAt), updatedAt: iso(updatedAt) }; });
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), entityType === "events" ? "Events" : entityType === "social_work" ? "Social Work" : "Announcements");
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
