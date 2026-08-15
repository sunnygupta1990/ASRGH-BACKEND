// backened/src/worker.ts

import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import photosRouter from "./routes/photos.worker";
import { createApp } from "./app";

type R2LikeObject = {
  body: ReadableStream;
  httpEtag: string;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
};

type R2LikeBucket = {
  get(key: string): Promise<R2LikeObject | null>;
};

type CloudflareEnv = {
  MEDIA_BUCKET: R2LikeBucket;
};

const workerEnv = env as unknown as CloudflareEnv;
const app = createApp(photosRouter);

app.get("/media/*path", async (req, res) => {
  try {
    const wildcard = req.params.path;
    const pathValue = Array.isArray(wildcard)
      ? wildcard.join("/")
      : String(wildcard ?? "");
    const key = pathValue.replace(/^\/+/, "");

    if (!key) {
      return res.status(404).end();
    }

    const object = await workerEnv.MEDIA_BUCKET.get(key);

    if (!object) {
      return res.status(404).json({
        success: false,
        message: "Media not found",
      });
    }

    res.setHeader(
      "Content-Type",
      object.httpMetadata?.contentType ?? "application/octet-stream",
    );
    res.setHeader(
      "Cache-Control",
      object.httpMetadata?.cacheControl ??
        "public, max-age=3600",
    );
    res.setHeader("ETag", object.httpEtag);

    const bytes = await new Response(object.body).arrayBuffer();
    return res.send(Buffer.from(bytes));
  } catch (error) {
    console.error("R2_MEDIA_READ_ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load media",
    });
  }
});

app.listen(3000);

export default httpServerHandler({
  port: 3000,
});
