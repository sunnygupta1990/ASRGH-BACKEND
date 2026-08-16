// backened/src/routes/photos.worker.ts

import { env } from "cloudflare:workers";
import { Router } from "express";
import multer from "multer";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";
import {
  deletePhoto,
  setPhotoAsCover,
  updatePhotoCaption,
} from "../services/photo.service";
import { normalizeParam } from "../utils/routeParams";

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

function objectKeyFromStorageKey(storageKey: string): string | null {
  if (!storageKey.startsWith("/media/")) {
    return null;
  }

  return storageKey.replace(/^\/media\//, "");
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
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);

      const updated = await setPhotoAsCover(
        {
          prisma: req.prisma,
          organizationId: req.user!.organizationId,
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
  async (req: AuthenticatedRequest, res) => {
    try {
      const albumId = normalizeParam(req.params.albumId);
      const photoId = normalizeParam(req.params.photoId);

      const storage = await deletePhoto(
        {
          prisma: req.prisma,
          organizationId: req.user!.organizationId,
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