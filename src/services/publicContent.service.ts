// backened/src/services/publicContent.service.ts

import { AppPrisma } from "../config/prisma";
import { categoryFromMemberCode, compareMemberCodes } from "./memberClassification.service";

export class PublicOrganizationResolutionError extends Error {
  readonly status: 404 | 409;

  constructor(message: string, status: 404 | 409) {
    super(message);
    this.name = "PublicOrganizationResolutionError";
    this.status = status;
  }
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function getRequestSite(
  origin: string | undefined,
  referer: string | undefined,
): string | undefined {
  return origin ?? referer;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getBoolean(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  return typeof record[key] === "boolean" ? record[key] : fallback;
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  return typeof record[key] === "number" ? record[key] : fallback;
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

export function publicAddressFields(
  addressPublic: boolean,
  member: { addressLine2: string | null; city: string | null },
) {
  return {
    addressLine1: null,
    addressLine2: addressPublic ? member.addressLine2 : null,
    city: addressPublic ? member.city : null,
    state: null,
  };
}

function isAssignmentCurrent(
  assignment: {
    startDate: Date | null;
    endDate: Date | null;
    term: {
      startDate: Date;
      endDate: Date | null;
    };
  },
  now: Date,
): boolean {
  const today = now.toISOString().slice(0, 10);
  const termStart = assignment.term.startDate.toISOString().slice(0, 10);
  const termEnd = assignment.term.endDate?.toISOString().slice(0, 10);
  const assignmentStart = assignment.startDate?.toISOString().slice(0, 10);
  const assignmentEnd = assignment.endDate?.toISOString().slice(0, 10);

  if (termStart > today) {
    return false;
  }

  if (termEnd && termEnd < today) {
    return false;
  }

  if (assignmentStart && assignmentStart > today) {
    return false;
  }

  if (assignmentEnd && assignmentEnd < today) {
    return false;
  }

  return true;
}

function formatManagementAssignment(
  assignment: {
    id: string;
    memberId: string;
    positionId: string;
    termId: string;
    startDate: Date | null;
    endDate: Date | null;
    displayOrder: number;
    notes: string | null;
    position: {
      id: string;
      code: string;
      name: string;
      displayOrder: number;
      description: string | null;
      isActive: boolean;
      customFields: unknown;
    };
    term: {
      id: string;
      name: string;
      startDate: Date;
      endDate: Date | null;
      status: string;
      notes: string | null;
      customFields: unknown;
    };
  },
  current: boolean,
) {
  return {
    id: assignment.id,
    memberId: assignment.memberId,
    positionId: assignment.positionId,
    termId: assignment.termId,
    startDate: assignment.startDate,
    endDate: assignment.endDate,
    displayOrder: assignment.displayOrder,
    notes: assignment.notes,
    current,
    position: {
      id: assignment.position.id,
      code: assignment.position.code,
      name: assignment.position.name,
      displayOrder: assignment.position.displayOrder,
      description: assignment.position.description,
      isActive: assignment.position.isActive,
      customFields: assignment.position.customFields,
    },
    term: {
      id: assignment.term.id,
      name: assignment.term.name,
      startDate: assignment.term.startDate,
      endDate: assignment.term.endDate,
      status: assignment.term.status,
      notes: assignment.term.notes,
      customFields: assignment.term.customFields,
    },
  };
}

export async function resolvePublicOrganization(
  prisma: AppPrisma,
  origin?: string,
  referer?: string,
) {
  const organizations = await prisma.organization.findMany({
    where: {
      isActive: true,
    },
    select: {
      id: true,
      code: true,
      name: true,
      websiteUrl: true,
    },
  });

  if (organizations.length === 0) {
    throw new PublicOrganizationResolutionError(
      "No active organization is configured",
      404,
    );
  }

  const requestHostname = normalizeHostname(
    getRequestSite(origin, referer),
  );

  if (requestHostname) {
    const matched = organizations.find(
      (organization) =>
        normalizeHostname(organization.websiteUrl) === requestHostname,
    );

    if (matched) {
      return matched;
    }
  }

  if (organizations.length === 1) {
    return organizations[0];
  }

  throw new PublicOrganizationResolutionError(
    "Unable to determine the public organization",
    409,
  );
}

export async function getPublicEvents(
  prisma: AppPrisma,
  organizationId: string,
) {
  const events = await prisma.event.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: {
        notIn: ["draft", "archived", "deleted"],
      },
    },
    select: {
      id: true,
      title: true,
      slug: true,
      category: true,
      summary: true,
      description: true,
      venue: true,
      startAt: true,
      endAt: true,
      status: true,
      coverMediaId: true,
      customFields: true,
      album: {
        select: {
          id: true,
          title: true,
          coverMediaId: true,
          deletedAt: true,
          photos: {
            orderBy: {
              displayOrder: "asc",
            },
            select: {
              id: true,
              displayOrder: true,
              caption: true,
              isFeatured: true,
              createdAt: true,
              mediaAsset: {
                select: {
                  storageKey: true,
                  metadata: true,
                  isPublic: true,
                  deletedAt: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: {
      startAt: "desc",
    },
  });

  return events.map((event) => {
    const fields = asRecord(event.customFields);

    const album =
      event.album && event.album.deletedAt === null
        ? {
            id: event.album.id,
            title: event.album.title,
            coverMediaId: event.album.coverMediaId,
            photos: event.album.photos
              .filter(
                (photo) =>
                  photo.mediaAsset.isPublic &&
                  photo.mediaAsset.deletedAt === null,
              )
              .map((photo) => {
                const metadata = asRecord(photo.mediaAsset.metadata);
                const thumbnailUrl = getString(metadata, "thumbnailUrl");

                return {
                  id: photo.id,
                  displayOrder: photo.displayOrder,
                  caption: photo.caption,
                  isFeatured: photo.isFeatured,
                  createdAt: photo.createdAt,
                  mediaAsset: {
                    storageKey: photo.mediaAsset.storageKey,
                    metadata: thumbnailUrl
                      ? { thumbnailUrl }
                      : undefined,
                  },
                };
              }),
          }
        : null;

    return {
      id: event.id,
      title: event.title,
      slug: event.slug,
      category: event.category,
      summary: event.summary,
      description: event.description,
      venue: event.venue,
      startAt: event.startAt,
      endAt: event.endAt,
      status: event.status,
      coverMediaId: event.coverMediaId,
      customFields: {
        event_code: getString(fields, "event_code") ?? event.slug,
        social_work_activity_id: getString(
          fields,
          "social_work_activity_id",
        ),
        social_work_activity_title: getString(
          fields,
          "social_work_activity_title",
        ),
        address: getString(fields, "address"),
        google_maps_url: getString(fields, "google_maps_url"),
        featured: getBoolean(fields, "featured", false),
        countdown_enabled: getBoolean(
          fields,
          "countdown_enabled",
          false,
        ),
      },
      album,
    };
  });
}

export async function getPublicMembers(
  prisma: AppPrisma,
  organizationId: string,
) {
  const members = await prisma.member.findMany({
    where: {
      organizationId,
      deletedAt: null,
      membershipStatus: {
        notIn: ["archived", "deleted"],
      },
    },
    select: {
      id: true,
      memberCode: true,
      firstName: true,
      lastName: true,
      displayName: true,
      phone: true,
      email: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      membershipStatus: true,
      joinedOn: true,
      notes: true,
      profileMedia: {
        select: {
          storageKey: true,
          isPublic: true,
          deletedAt: true,
        },
      },
      customFields: true,
      assignments: {
        orderBy: [
          {
            displayOrder: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
        select: {
          id: true,
          memberId: true,
          positionId: true,
          termId: true,
          startDate: true,
          endDate: true,
          displayOrder: true,
          notes: true,
          position: {
            select: {
              id: true,
              code: true,
              name: true,
              displayOrder: true,
              description: true,
              isActive: true,
              customFields: true,
            },
          },
          term: {
            select: {
              id: true,
              name: true,
              startDate: true,
              endDate: true,
              status: true,
              notes: true,
              customFields: true,
            },
          },
        },
      },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  const now = new Date();

  return members.map((member) => {
    const fields = asRecord(member.customFields);
    const visibilityRecord = asRecord(fields.visibility);

    const visibility = {
      phone_public: getBoolean(
        visibilityRecord,
        "phone_public",
        false,
      ),
      email_public: getBoolean(
        visibilityRecord,
        "email_public",
        false,
      ),
      address_public: getBoolean(
        visibilityRecord,
        "address_public",
        false,
      ),
      photo_public: getBoolean(
        visibilityRecord,
        "photo_public",
        true,
      ),
      designation_public: getBoolean(
        visibilityRecord,
        "designation_public",
        true,
      ),
    };

    const photoUrl = getString(fields, "photo_url");

    const profilePhotoUrl =
      member.profileMedia?.isPublic &&
      member.profileMedia.deletedAt === null
        ? member.profileMedia.storageKey
        : undefined;

    const assignments = member.assignments.map((assignment) =>
      formatManagementAssignment(
        assignment,
        isAssignmentCurrent(assignment, now),
      ),
    );

    const currentAssignments = assignments.filter(
      (assignment) => assignment.current,
    );

    const legacyManagement =
      currentAssignments.length === 0 &&
      member.assignments.length === 0 &&
      getBoolean(fields, "current_management", false);

    const currentManagementPost =
      currentAssignments.length > 0
        ? currentAssignments
            .sort(
              (a, b) =>
                a.position.displayOrder - b.position.displayOrder,
            )
            .map((assignment) => assignment.position.name)
            .join(", ")
        : getString(fields, "management_post");

    const currentDisplayOrder =
      currentAssignments.length > 0
        ? Math.min(
            ...currentAssignments.map(
              (assignment) => assignment.displayOrder,
            ),
          )
        : getNumber(fields, "display_order", 0);

    const category = categoryFromMemberCode(member.memberCode);
    const publicAddress = publicAddressFields(visibility.address_public, member);
    return {
      id: member.id,
      memberCode: member.memberCode,
      firstName: member.firstName,
      lastName: member.lastName,
      displayName: member.displayName,
      phone: visibility.phone_public ? member.phone : null,
      email: visibility.email_public ? member.email : null,
      ...publicAddress,
      membershipStatus: member.membershipStatus,
      joinedOn: member.joinedOn,
      notes: visibility.designation_public
        ? member.notes
        : null,
      assignments,
      customFields: {
        category,
        designation: visibility.designation_public
          ? category
          : undefined,
        photo_url: visibility.photo_public
          ? profilePhotoUrl ?? photoUrl
          : undefined,
        current_management:
          currentAssignments.length > 0 || legacyManagement,
        management_post: currentManagementPost,
        display_order: currentDisplayOrder,
        visibility,
        bio: getString(fields, "bio"),
      },
    };
  }).sort((left, right) => compareMemberCodes(left.memberCode, right.memberCode));
}

export async function getPublicAnnouncements(
  prisma: AppPrisma,
  organizationId: string,
) {
  const now = new Date();
  return prisma.announcement.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: "published",
      OR: [{ publishedAt: null }, { publishedAt: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    select: {
      id: true,
      title: true,
      slug: true,
      summary: true,
      body: true,
      status: true,
      publishedAt: true,
      expiresAt: true,
      coverMediaId: true,
      customFields: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPublicSocialWork(
  prisma: AppPrisma,
  organizationId: string,
) {
  const items = await prisma.socialWorkItem.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { notIn: ["draft", "archived", "deleted"] },
    },
    select: {
      id: true,
      title: true,
      slug: true,
      summary: true,
      description: true,
      startDate: true,
      endDate: true,
      status: true,
      displayOrder: true,
      publishedAt: true,
      coverMediaId: true,
      metadata: true,
      customFields: true,
      category: {
        select: { id: true, code: true, name: true, displayOrder: true },
      },
    },
    orderBy: [{ displayOrder: "asc" }, { startDate: "desc" }],
  });

  return items.map(({ category, ...item }) => ({
    ...item,
    category: category
      ? {
          id: category.id,
          name: category.name,
          slug: category.code,
          displayOrder: category.displayOrder,
        }
      : null,
  }));
}
