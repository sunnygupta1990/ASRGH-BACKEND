// backened/src/routes/photos.worker.ts

import { env } from "cloudflare:workers";
import { Router } from "express";
import multer from "multer";
import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";

const router = Router();

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
          id: req.params.albumId,
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

      const existingCount = await prisma.albumPhoto.count({
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
          const mediaAsset = await prisma.mediaAsset.create({
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
        } catch (databaseError) {
          await workerEnv.MEDIA_BUCKET.delete(objectKey);
          throw databaseError;
        }
      }

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

export default router;
