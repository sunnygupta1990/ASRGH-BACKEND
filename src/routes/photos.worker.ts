// backened/src/routes/photos.worker.ts

import { env } from "cloudflare:workers";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
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

const router = Router();

function withoutLegacyPhotoUrl(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.photo_url;
  return copy as Prisma.InputJsonValue;
}


type R2LikeObject = {
  body: ReadableStream;
  httpEtag: string;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
};

type R2LikeBucket = {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: {
        contentType?: string;
        cacheControl?: string;
      };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<R2LikeObject | null>;
  delete(key: string): Promise<void>;
};

type CloudflareEnv = {
  MEDIA_BUCKET: R2LikeBucket;
};

const workerEnv = env as unknown as CloudflareEnv;

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

function extensionForMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };

  return extensions[mimeType] ?? "bin";
}

function objectKeyFromStorageKey(storageKey: string): string | null {
  if (!storageKey.startsWith("/media/")) {
    return null;
  }

  return storageKey.replace(/^\/media\//, "");
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
      const objectKey = `profiles/${mediaId}.webp`;
      const publicPath = `/media/${objectKey}`;

      await workerEnv.MEDIA_BUCKET.put(objectKey, file.buffer, {
        httpMetadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: {
          originalFilename: file.originalname,
          profilePhoto: "true",
        },
      });

      try {
        const mediaAsset = await req.prisma.$transaction(async (tx) => {
          const created = await tx.mediaAsset.create({
            data: {
              organizationId: req.user!.organizationId,
              storageProvider: "cloudflare-r2",
              storageKey: publicPath,
              originalFilename: file.originalname,
              mimeType: "image/webp",
              fileSizeBytes: BigInt(file.size),
              widthPx: 512,
              heightPx: 512,
              metadata: {
                thumbnailUrl: publicPath,
                r2ObjectKey: objectKey,
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
              beforeData: { profileMediaId: member.profileMediaId },
              afterData: { profileMediaId: created.id },
              metadata: { actorRoles: req.authorization?.roleNames ?? [] },
            },
          });

          return created;
        });

        if (member.profileMedia) {
          const oldObjectKey = objectKeyFromStorageKey(member.profileMedia.storageKey);
          if (oldObjectKey) {
            await workerEnv.MEDIA_BUCKET.delete(oldObjectKey);
          }
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
        await workerEnv.MEDIA_BUCKET.delete(objectKey);
        throw error;
      }
    } catch (error) {
      console.error("R2_PROFILE_PHOTO_UPLOAD_ERROR:", error);
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

      const oldObjectKey = objectKeyFromStorageKey(member.profileMedia.storageKey);

      await req.prisma.$transaction(async (tx) => {
        await tx.member.update({
          where: { id: member.id },
          data: { profileMediaId: null, customFields: withoutLegacyPhotoUrl(member.customFields) },
        });
        await tx.mediaAsset.update({
          where: { id: member.profileMedia!.id },
          data: { deletedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            organizationId: req.user!.organizationId,
            actorUserId: req.user!.userId,
            action: "MEMBER_PROFILE_PHOTO_DELETE",
            entityType: "member",
            entityId: member.id,
            beforeData: { profileMediaId: member.profileMedia.id },
            afterData: { profileMediaId: null },
            metadata: { actorRoles: req.authorization?.roleNames ?? [] },
          },
        });
      });

      if (oldObjectKey) {
        await workerEnv.MEDIA_BUCKET.delete(oldObjectKey);
      }

      return res.json({ success: true });
    } catch (error) {
      console.error("R2_PROFILE_PHOTO_DELETE_ERROR:", error);
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
        const objectId = crypto.randomUUID();
        const extension = extensionForMimeType(file.mimetype);
        const objectKey = `images/${objectId}.${extension}`;
        const publicPath = `/media/${objectKey}`;

        await workerEnv.MEDIA_BUCKET.put(objectKey, file.buffer, {
          httpMetadata: {
            contentType: file.mimetype,
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: {
            originalFilename: file.originalname,
          },
        });

        try {
          const mediaAsset = await req.prisma.mediaAsset.create({
            data: {
              organizationId: req.user!.organizationId,
              storageProvider: "cloudflare-r2",
              storageKey: publicPath,
              originalFilename: file.originalname,
              mimeType: file.mimetype,
              fileSizeBytes: BigInt(file.size),
              metadata: {
                thumbnailUrl: publicPath,
                r2ObjectKey: objectKey,
              },
            },
          });

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
        } catch (databaseError) {
          await workerEnv.MEDIA_BUCKET.delete(objectKey);
          throw databaseError;
        }
      }

      await recordAudit(req.prisma, requestAuditContext(req), { action: "PHOTO_UPLOAD", entityType: "event_album", entityId: album.id, metadata: { photoIds: uploadedPhotos.map((photo) => photo.id), count: uploadedPhotos.length } });
      return res.status(201).json({
        success: true,
        data: uploadedPhotos,
      });
    } catch (error) {
      console.error("R2_PHOTO_UPLOAD_ERROR:", error);

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
      console.error("R2_PHOTO_UPDATE_ERROR:", error);

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
      console.error("R2_PHOTO_COVER_ERROR:", error);

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

      if (storage.r2ObjectKey) {
        await env.MEDIA_BUCKET.delete(storage.r2ObjectKey);
      }

      return res.json({
        success: true,
      });
    } catch (error) {
      console.error("R2_PHOTO_DELETE_ERROR:", error);

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
