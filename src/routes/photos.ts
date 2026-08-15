// backened/src/routes/photos.ts

import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";

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

function normalizeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

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

      const album = await prisma.eventAlbum.findFirst({
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

      const existingCount = await prisma.albumPhoto.count({
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

        const mediaAsset = await prisma.mediaAsset.create({
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

        const albumPhoto = await prisma.albumPhoto.create({
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
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);
      const caption =
        typeof req.body.caption === "string"
          ? req.body.caption.trim()
          : undefined;

      const photo = await prisma.albumPhoto.findFirst({
        where: {
          id: photoId,
          albumId,
          organizationId: req.user!.organizationId,
        },
      });

      if (!photo) {
        return res.status(404).json({
          success: false,
          message: "Photo not found",
        });
      }

      const updated = await prisma.albumPhoto.update({
        where: { id: photo.id },
        data: {
          caption: caption === undefined ? undefined : caption || null,
        },
        include: {
          mediaAsset: true,
        },
      });

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
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);

      const album = await prisma.eventAlbum.findFirst({
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

      const photo = await prisma.albumPhoto.findFirst({
        where: {
          id: photoId,
          albumId: album.id,
          organizationId: req.user!.organizationId,
        },
      });

      if (!photo) {
        return res.status(404).json({
          success: false,
          message: "Photo not found",
        });
      }

      await prisma.albumPhoto.updateMany({
        where: {
          albumId: album.id,
        },
        data: {
          isFeatured: false,
        },
      });

      await prisma.albumPhoto.update({
        where: {
          id: photo.id,
        },
        data: {
          isFeatured: true,
        },
      });

      await prisma.eventAlbum.update({
        where: {
          id: album.id,
        },
        data: {
          coverMediaId: photo.mediaAssetId,
        },
      });

      await prisma.event.update({
        where: {
          id: album.eventId,
        },
        data: {
          coverMediaId: photo.mediaAssetId,
        },
      });

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
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);

      const photo = await prisma.albumPhoto.findFirst({
        where: {
          id: photoId,
          albumId,
          organizationId: req.user!.organizationId,
        },
        include: {
          album: true,
          mediaAsset: true,
        },
      });

      if (!photo) {
        return res.status(404).json({
          success: false,
          message: "Photo not found",
        });
      }

      const thumbnailUrl =
        typeof photo.mediaAsset.metadata === "object" &&
        photo.mediaAsset.metadata !== null &&
        "thumbnailUrl" in photo.mediaAsset.metadata
          ? String(
              (photo.mediaAsset.metadata as Record<string, unknown>)
                .thumbnailUrl ?? "",
            )
          : "";

      await prisma.albumPhoto.delete({
        where: {
          id: photo.id,
        },
      });

      if (photo.album.coverMediaId === photo.mediaAssetId) {
        await prisma.eventAlbum.update({
          where: {
            id: photo.album.id,
          },
          data: {
            coverMediaId: null,
          },
        });

        await prisma.event.update({
          where: {
            id: photo.album.eventId,
          },
          data: {
            coverMediaId: null,
          },
        });
      }

      await prisma.mediaAsset.delete({
        where: {
          id: photo.mediaAsset.id,
        },
      });

      const filePaths = [
        storagePathFromKey(photo.mediaAsset.storageKey),
        thumbnailUrl ? storagePathFromKey(thumbnailUrl) : null,
      ].filter((item): item is string => Boolean(item));

      await Promise.all(
        filePaths.map(async (filePath) => {
          try {
            await fs.unlink(filePath);
          } catch {
            // File may already be absent; database state is authoritative.
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
