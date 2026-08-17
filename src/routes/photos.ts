// backened/src/routes/photos.ts

import { Router } from "express";
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

const router = Router();

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

  return null;
}

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

      const imageDirectory = path.resolve("storage/images");
      const thumbnailDirectory = path.resolve("storage/thumbnails");

      await fs.mkdir(imageDirectory, { recursive: true });
      await fs.mkdir(thumbnailDirectory, { recursive: true });

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

        const imagePath = path.join(imageDirectory, imageFilename);
        const thumbnailPath = path.join(
          thumbnailDirectory,
          thumbnailFilename,
        );

        const metadata = await sharp(file.buffer).metadata();

        await sharp(file.buffer)
          .rotate()
          .resize({
            width: 1600,
            height: 1200,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toFile(imagePath);

        await sharp(file.buffer)
          .rotate()
          .resize({
            width: 400,
            height: 400,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .toFile(thumbnailPath);

        const imageStat = await fs.stat(imagePath);

        const mediaAsset = await req.prisma.mediaAsset.create({
          data: {
            organizationId: req.user!.organizationId,
            storageProvider: "local",
            storageKey: `/media/images/${imageFilename}`,
            originalFilename: file.originalname,
            mimeType: "image/webp",
            fileSizeBytes: BigInt(imageStat.size),
            widthPx: metadata.width ?? null,
            heightPx: metadata.height ?? null,
            metadata: {
              thumbnailUrl: `/media/thumbnails/${thumbnailFilename}`,
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

      const filePaths = [
        storagePathFromKey(storage.storageKey),
        storage.thumbnailUrl
          ? storagePathFromKey(storage.thumbnailUrl)
          : null,
      ].filter((item): item is string => Boolean(item));

      await Promise.all(
        filePaths.map(async (filePath) => {
          try {
            await fs.unlink(filePath);
          } catch {
            // The database state is authoritative if the file is already absent.
          }
        }),
      );

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
