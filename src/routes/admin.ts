// backened/src/routes/admin.ts

import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
} from "../middleware/requireAuth";

const router = Router();

router.get(
  "/me",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = await req.prisma.adminUser.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        lastLoginAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Admin user not found",
      });
    }

    return res.json({
      success: true,
      user,
    });
  },
);

export default router;