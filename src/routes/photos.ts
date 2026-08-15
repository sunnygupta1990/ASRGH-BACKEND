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

router.post(
  "/albums/:albumId/photos",
  requireAuth,
  upload.array("photos", 50),
  async (req: AuthenticatedRequest, res) => {
    try {
      const files = req.files as Express.Multer.File[];

      if (!files?.length) {
        return res.status(400).json({
          success: false,
          message: "No photos selected",
        });
      }

      const album = await prisma.eventAlbum.findFirst({
        where: {
          id: String(req.params.albumId),
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
          .webp({
            quality: 82,
          })
          .toFile(imagePath);

        await sharp(file.buffer)
          .rotate()
          .resize({
            width: 400,
            height: 400,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({
            quality: 78,
          })
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

export default router;

