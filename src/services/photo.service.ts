// backened/src/services/photo.service.ts

import { AppPrisma } from "../config/prisma";
import { AuditContext } from "./audit.service";

export interface PhotoServiceContext {
  prisma: AppPrisma;
  organizationId: string;
  audit?: AuditContext;
}

export interface DeletedPhotoStorage {
  storageKey: string;
  thumbnailUrl: string | null;
  r2ObjectKey: string | null;
}

function getMetadataValue(
  metadata: unknown,
  key: string,
): string | null {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !(key in metadata)
  ) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[key];

  return value === undefined || value === null
    ? null
    : String(value);
}

function getR2ObjectKey(
  storageKey: string,
  metadata: unknown,
): string | null {
  return (
    getMetadataValue(metadata, "r2ObjectKey") ??
    (storageKey.startsWith("/media/")
      ? storageKey.replace(/^\/media\//, "")
      : null)
  );
}

export async function updatePhotoCaption(
  context: PhotoServiceContext,
  albumId: string,
  photoId: string,
  caption: string | undefined,
) {
  const photo = await context.prisma.albumPhoto.findFirst({
    where: {
      id: photoId,
      albumId,
      organizationId: context.organizationId,
    },
  });

  if (!photo) {
    return null;
  }

  return context.prisma.$transaction(async (tx) => {
    const updated = await tx.albumPhoto.update({ where: { id: photo.id }, data: { caption: caption === undefined ? undefined : caption || null }, include: { mediaAsset: true } });
    if (context.audit) await tx.auditLog.create({ data: { organizationId: context.organizationId, actorUserId: context.audit.actorUserId, action: "PHOTO_CAPTION_UPDATE", entityType: "album_photo", entityId: photo.id, beforeData: { id: photo.id, caption: photo.caption }, afterData: { id: updated.id, caption: updated.caption }, metadata: { actorRoles: context.audit.actorRoleNames } } });
    return updated;
  });
}

export async function setPhotoAsCover(
  context: PhotoServiceContext,
  albumId: string,
  photoId: string,
) {
  const album = await context.prisma.eventAlbum.findFirst({
    where: {
      id: albumId,
      organizationId: context.organizationId,
      deletedAt: null,
    },
  });

  if (!album) {
    return null;
  }

  const photo = await context.prisma.albumPhoto.findFirst({
    where: {
      id: photoId,
      albumId: album.id,
      organizationId: context.organizationId,
    },
  });

  if (!photo) {
    return null;
  }

  await context.prisma.$transaction([
    context.prisma.albumPhoto.updateMany({
      where: {
        albumId: album.id,
      },
      data: {
        isFeatured: false,
      },
    }),
    context.prisma.albumPhoto.update({
      where: {
        id: photo.id,
      },
      data: {
        isFeatured: true,
      },
    }),
    context.prisma.eventAlbum.update({
      where: {
        id: album.id,
      },
      data: {
        coverMediaId: photo.mediaAssetId,
      },
    }),
    context.prisma.event.update({
      where: {
        id: album.eventId,
      },
      data: {
        coverMediaId: photo.mediaAssetId,
      },
    }),
    ...(context.audit ? [context.prisma.auditLog.create({ data: { organizationId: context.organizationId, actorUserId: context.audit.actorUserId, action: "PHOTO_SET_COVER", entityType: "album_photo", entityId: photo.id, metadata: { actorRoles: context.audit.actorRoleNames, albumId } } })] : []),
  ]);

  return photo;
}

export async function deletePhoto(
  context: PhotoServiceContext,
  albumId: string,
  photoId: string,
): Promise<DeletedPhotoStorage | null> {
  const photo = await context.prisma.albumPhoto.findFirst({
    where: {
      id: photoId,
      albumId,
      organizationId: context.organizationId,
    },
    include: {
      album: true,
      mediaAsset: true,
    },
  });

  if (!photo) {
    return null;
  }

  const storage = {
    storageKey: photo.mediaAsset.storageKey,
    thumbnailUrl: getMetadataValue(
      photo.mediaAsset.metadata,
      "thumbnailUrl",
    ),
    r2ObjectKey: getR2ObjectKey(
      photo.mediaAsset.storageKey,
      photo.mediaAsset.metadata,
    ),
  };

  await context.prisma.$transaction(async (tx) => {
    await tx.albumPhoto.delete({
      where: {
        id: photo.id,
      },
    });

    await tx.mediaAsset.delete({
      where: {
        id: photo.mediaAsset.id,
      },
    });

    if (photo.album.coverMediaId === photo.mediaAssetId) {
      await tx.eventAlbum.update({
        where: {
          id: photo.album.id,
        },
        data: {
          coverMediaId: null,
        },
      });

      await tx.event.update({
        where: {
          id: photo.album.eventId,
        },
        data: {
          coverMediaId: null,
        },
      });
    }

    if (context.audit) {
      await tx.auditLog.create({ data: { organizationId: context.organizationId, actorUserId: context.audit.actorUserId, action: "PHOTO_DELETE", entityType: "album_photo", entityId: photo.id, beforeData: { id: photo.id, albumId: photo.albumId, mediaAssetId: photo.mediaAssetId, caption: photo.caption }, metadata: { actorRoles: context.audit.actorRoleNames, albumId } } });
    }
  });

  return storage;
}

export async function reorderPhotos(context: PhotoServiceContext, albumId: string, photoIds: string[]) {
  const album = await context.prisma.eventAlbum.findFirst({ where: { id: albumId, organizationId: context.organizationId, deletedAt: null } });
  if (!album) return null;
  const photos = await context.prisma.albumPhoto.findMany({ where: { albumId, organizationId: context.organizationId }, select: { id: true } });
  if (photos.length !== photoIds.length || photos.some((photo) => !photoIds.includes(photo.id)) || new Set(photoIds).size !== photoIds.length) throw new Error("Photo order must contain every album photo exactly once");
  await context.prisma.$transaction([
    ...photoIds.map((id, index) => context.prisma.albumPhoto.update({ where: { id }, data: { displayOrder: index + 1 } })),
    ...(context.audit ? [context.prisma.auditLog.create({ data: { organizationId: context.organizationId, actorUserId: context.audit.actorUserId, action: "PHOTO_REORDER", entityType: "event_album", entityId: albumId, metadata: { actorRoles: context.audit.actorRoleNames, photoIds } } })] : []),
  ]);
  return true;
}
