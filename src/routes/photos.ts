// backened/src/routes/photos.ts

import { Router } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";
import { PERMISSIONS, requirePermission } from "../auth/permissions";
import { recordAudit, requestAuditContext } from "../services/audit.service";
import {
  deletePhoto,
  setPhotoAsCover,
  updatePhotoCaption,
  reorderPhotos,
} from "../services/photo.service";
import { normalizeParam } from "../utils/routeParams";
import {
  deleteOracleObject,
  deleteOracleObjectByStorageKey,
  putOracleObject,
} from "../services/oracleObjectStorage.service";

const router = Router();

function withoutLegacyPhotoUrl(value: Prisma.JsonValue): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { photo_url: _legacyPhotoUrl, ...copy } = value;
  return copy;
}


const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 50,
  },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      callback(new Error("Only image files are allowed"));
      return;
    }

    callback(null, true);
  },
});

function storagePathFromKey(storageKey: string): string | null {
  if (storageKey.startsWith("/media/images/")) {
    return path.resolve("storage/images", path.basename(storageKey));
  }

  if (storageKey.startsWith("/media/thumbnails/")) {
    return path.resolve("storage/thumbnails", path.basename(storageKey));
  }

  if (storageKey.startsWith("/media/profiles/")) {
    return path.resolve("storage/profiles", path.basename(storageKey));
  }

  return null;
}

async function deleteStoredMedia(storageKey: string): Promise<void> {
  await deleteOracleObjectByStorageKey(storageKey);

  const localPath = storagePathFromKey(storageKey);
  if (localPath) {
    try {
      await fs.unlink(localPath);
    } catch {
      // Transitional local fallback may already be absent.
    }
  }
}


const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      callback(new Error("Profile photo must be JPG, PNG, or WebP"));
      return;
    }

    callback(null, true);
  },
});

function profileUploadMiddleware(req: AuthenticatedRequest, res: any, next: any) {
  profileUpload.single("profilePhoto")(req, res, (error: any) => {
    if (error) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          success: false,
          message: "Profile photo must be 2 MB or smaller",
        });
      }

      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "Invalid profile photo",
      });
    }

    next();
  });
}

router.post(
  "/members/:memberId/profile-photo",
  requireAuth,
  requirePermission(PERMISSIONS.membersWrite),
  profileUploadMiddleware,
  async (req: AuthenticatedRequest, res) => {
    try {
      const memberId = normalizeParam(req.params.memberId);
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          success: false,
          message: "Select a profile photo",
        });
      }

      if (file.mimetype !== "image/webp") {
        return res.status(400).json({
          success: false,
          message: "Profile photo must be processed as WebP before upload",
        });
      }

      const member = await req.prisma.member.findFirst({
        where: {
          id: memberId,
          organizationId: req.user!.organizationId,
          deletedAt: null,
        },
        include: { profileMedia: true },
      });

      if (!member) {
        return res.status(404).json({
          success: false,
          message: "Member not found",
        });
      }

      const mediaId = crypto.randomUUID();
      const filename = `profile-${mediaId}.webp`;
      const objectName = `images/${filename}`;

      await putOracleObject(objectName, file.buffer, "image/webp");

      try {
        const mediaAsset = await req.prisma.$transaction(async (tx) => {
          const created = await tx.mediaAsset.create({
            data: {
              organizationId: req.user!.organizationId,
              storageProvider: "oracle-object-storage",
              storageKey: `/media/${objectName}`,
              originalFilename: file.originalname,
              mimeType: "image/webp",
              fileSizeBytes: BigInt(file.size),
              widthPx: 512,
              heightPx: 512,
              metadata: {
                thumbnailUrl: `/media/${objectName}`,
                profilePhoto: true,
              },
            },
          });

          await tx.member.update({
            where: { id: member.id },
            data: { profileMediaId: created.id, customFields: withoutLegacyPhotoUrl(member.customFields) },
          });

          await tx.auditLog.create({
            data: {
              organizationId: req.user!.organizationId,
              actorUserId: req.user!.userId,
              action: "MEMBER_PROFILE_PHOTO_UPDATE",
              entityType: "member",
              entityId: member.id,
              beforeData: {
                profileMediaId: member.profileMediaId,
              },
              afterData: {
                profileMediaId: created.id,
              },
              metadata: {
                actorRoles: req.authorization?.roleNames ?? [],
              },
            },
          });

          return created;
        });

        if (member.profileMedia) {
          await deleteStoredMedia(member.profileMedia.storageKey);

          await req.prisma.mediaAsset.update({
            where: { id: member.profileMedia.id },
            data: { deletedAt: new Date() },
          });
        }

        return res.status(201).json({
          success: true,
          data: mediaAsset,
        });
      } catch (error) {
        await deleteOracleObject(objectName);
        throw error;
      }
    } catch (error) {
      console.error("PROFILE_PHOTO_UPLOAD_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "Unable to upload profile photo",
      });
    }
  },
);

router.delete(
  "/members/:memberId/profile-photo",
  requireAuth,
  requirePermission(PERMISSIONS.membersWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const memberId = normalizeParam(req.params.memberId);
      const member = await req.prisma.member.findFirst({
        where: {
          id: memberId,
          organizationId: req.user!.organizationId,
          deletedAt: null,
        },
        include: { profileMedia: true },
      });

      if (!member) {
        return res.status(404).json({ success: false, message: "Member not found" });
      }

      if (!member.profileMedia) {
        return res.json({ success: true });
      }

      const profileMedia = member.profileMedia;

      await req.prisma.$transaction(async (tx) => {
        await tx.member.update({
          where: { id: member.id },
          data: { profileMediaId: null, customFields: withoutLegacyPhotoUrl(member.customFields) },
        });
        await tx.mediaAsset.update({
          where: { id: profileMedia.id },
          data: { deletedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            organizationId: req.user!.organizationId,
            actorUserId: req.user!.userId,
            action: "MEMBER_PROFILE_PHOTO_DELETE",
            entityType: "member",
            entityId: member.id,
            beforeData: { profileMediaId: profileMedia.id },
            afterData: { profileMediaId: null },
            metadata: { actorRoles: req.authorization?.roleNames ?? [] },
          },
        });
      });

      await deleteStoredMedia(profileMedia.storageKey);

      return res.json({ success: true });
    } catch (error) {
      console.error("PROFILE_PHOTO_DELETE_ERROR:", error);
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "Unable to remove profile photo",
      });
    }
  },
);

router.post(
  "/albums/:albumId/photos",
  requireAuth,
  requirePermission(PERMISSIONS.photosWrite),
  upload.array("photos", 50),
  async (req: AuthenticatedRequest, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      const albumId = normalizeParam(req.params.albumId);

      if (!files?.length) {
        return res.status(400).json({
          success: false,
          message: "No photos selected",
        });
      }

      const album = await req.prisma.eventAlbum.findFirst({
        where: {
          id: albumId,
          organizationId: req.user!.organizationId,
          deletedAt: null,
        },
      });

      if (!album) {
        return res.status(404).json({
          success: false,
          message: "Album not found",
        });
      }

      const existingCount = await req.prisma.albumPhoto.count({
        where: {
          albumId: album.id,
        },
      });

      const uploadedPhotos = [];

      for (const [index, file] of files.entries()) {
        const id = crypto.randomUUID();
        const imageFilename = `${id}.webp`;
        const thumbnailFilename = `${id}.webp`;

        const imageObjectName = `images/${imageFilename}`;
        const thumbnailObjectName = `thumbnails/${thumbnailFilename}`;

        const metadata = await sharp(file.buffer).metadata();

        const imageBuffer = await sharp(file.buffer)
          .rotate()
          .resize({
            width: 1600,
            height: 1200,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toBuffer();

        const thumbnailBuffer = await sharp(file.buffer)
          .rotate()
          .resize({
            width: 400,
            height: 400,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .toBuffer();

        await Promise.all([
          putOracleObject(imageObjectName, imageBuffer, "image/webp"),
          putOracleObject(thumbnailObjectName, thumbnailBuffer, "image/webp"),
        ]);

        let mediaAsset;
        try {
          mediaAsset = await req.prisma.mediaAsset.create({
            data: {
              organizationId: req.user!.organizationId,
              storageProvider: "oracle-object-storage",
              storageKey: `/media/${imageObjectName}`,
              originalFilename: file.originalname,
              mimeType: "image/webp",
              fileSizeBytes: BigInt(imageBuffer.length),
              widthPx: metadata.width ?? null,
              heightPx: metadata.height ?? null,
              metadata: {
                thumbnailUrl: `/media/${thumbnailObjectName}`,
              },
            },
          });
        } catch (error) {
          await Promise.all([
            deleteOracleObject(imageObjectName),
            deleteOracleObject(thumbnailObjectName),
          ]);
          throw error;
        }

        try {
          const albumPhoto = await req.prisma.albumPhoto.create({
            data: {
              organizationId: req.user!.organizationId,
              albumId: album.id,
              mediaAssetId: mediaAsset.id,
              displayOrder: existingCount + index,
            },
            include: {
              mediaAsset: true,
            },
          });

          uploadedPhotos.push(albumPhoto);
        } catch (error) {
          await req.prisma.mediaAsset.delete({ where: { id: mediaAsset.id } }).catch(() => undefined);
          await Promise.all([
            deleteOracleObject(imageObjectName),
            deleteOracleObject(thumbnailObjectName),
          ]);
          throw error;
        }
      }

      await recordAudit(req.prisma, requestAuditContext(req), { action: "PHOTO_UPLOAD", entityType: "event_album", entityId: album.id, metadata: { photoIds: uploadedPhotos.map((photo) => photo.id), count: uploadedPhotos.length } });
      return res.status(201).json({
        success: true,
        data: uploadedPhotos,
      });
    } catch (error) {
      console.error("PHOTO_UPLOAD_ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to upload photos",
      });
    }
  },
);

router.patch(
  "/albums/:albumId/photos/:photoId",
  requireAuth,
  requirePermission(PERMISSIONS.photosWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);
      const caption =
        typeof req.body.caption === "string"
          ? req.body.caption.trim()
          : undefined;

      const updated = await updatePhotoCaption(
        {
          prisma: req.prisma,
          organizationId: req.user!.organizationId,
          audit: requestAuditContext(req),
        },
        albumId,
        photoId,
        caption,
      );

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: "Photo not found",
        });
      }

      return res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      console.error("PHOTO_UPDATE_ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to update photo",
      });
    }
  },
);

router.patch(
  "/albums/:albumId/photos/:photoId/cover",
  requireAuth,
  requirePermission(PERMISSIONS.photosWrite),
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);

      const updated = await setPhotoAsCover(
        {
          prisma: req.prisma,
          organizationId: req.user!.organizationId,
          audit: requestAuditContext(req),
        },
        albumId,
        photoId,
      );

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: "Album or photo not found",
        });
      }

      return res.json({
        success: true,
      });
    } catch (error) {
      console.error("PHOTO_COVER_ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to set cover photo",
      });
    }
  },
);

router.delete(
  "/albums/:albumId/photos/:photoId",
  requireAuth,
  requirePermission(PERMISSIONS.photosDelete),
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);

      const storage = await deletePhoto(
        {
          prisma: req.prisma,
          organizationId: req.user!.organizationId,
          audit: requestAuditContext(req),
        },
        albumId,
        photoId,
      );

      if (!storage) {
        return res.status(404).json({
          success: false,
          message: "Photo not found",
        });
      }

      const storageKeys = [
        storage.storageKey,
        storage.thumbnailUrl,
      ].filter((item): item is string => Boolean(item));

      await Promise.all(storageKeys.map((storageKey) => deleteStoredMedia(storageKey)));

      return res.json({
        success: true,
      });
    } catch (error) {
      console.error("PHOTO_DELETE_ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to delete photo",
      });
    }
  },
);

export default router;
router.put("/albums/:albumId/photos/order", requireAuth, requirePermission(PERMISSIONS.photosWrite), async (req, res) => {
  try {
    const photoIds = Array.isArray(req.body.photoIds) ? req.body.photoIds.filter((id: unknown): id is string => typeof id === "string") : [];
    const result = await reorderPhotos({ prisma: req.prisma, organizationId: req.user!.organizationId, audit: requestAuditContext(req) }, String(req.params.albumId), photoIds);
    return result ? res.json({ success: true }) : res.status(404).json({ success: false, message: "Album not found" });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid photo order" });
  }
});
