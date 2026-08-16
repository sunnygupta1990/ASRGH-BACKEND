// backened/src/routes/auth.ts

import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";


const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  try {
    const prisma = req.prisma;
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.adminUser.findFirst({
      where: {
        email: email.toLowerCase(),
        status: "active",
        deletedAt: null,
      },
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        organizationId: user.organizationId,
      },
      process.env.JWT_SECRET!,
      {
        expiresIn: "8h",
      },
    );

    await prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
      },
    });
  } catch {
    return res.status(400).json({
      success: false,
      message: "Invalid login request",
    });
  }
});

export default router;