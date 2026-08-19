import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";

export type PublishPublicContent = () => Promise<void>;

export function createPublicationRouter(publish: PublishPublicContent) {
  const router = Router();

  router.post("/publish", requireAuth, async (req, res) => {
    if (!req.authorization?.isSystemRole) {
      return res.status(403).json({
        success: false,
        message: "Only a Super Admin can publish website changes",
      });
    }

    try {
      await publish();
      return res.json({
        success: true,
        data: { publishedAt: new Date().toISOString() },
      });
    } catch (error) {
      console.error("PUBLIC_CONTENT_PUBLISH_ERROR:", error);
      return res.status(503).json({
        success: false,
        message: "Unable to publish website changes. The public cache was not fully cleared.",
      });
    }
  });

  return router;
}
