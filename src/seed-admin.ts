import "dotenv/config";
import bcrypt from "bcryptjs";
import { createPrismaClient } from "./config/prisma";

const prisma = createPrismaClient();

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL ?? "admin@asrgh.com";
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!password) {
    throw new Error(
      "INITIAL_ADMIN_PASSWORD is required. Add it to .env before running this seed.",
    );
  }

  const organization = await prisma.organization.findUnique({
    where: { code: "ASRGH" },
  });

  if (!organization) {
    throw new Error("ASRGH organization not found");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.adminUser.upsert({
    where: {
      organizationId_email: {
        organizationId: organization.id,
        email,
      },
    },
    update: {
      passwordHash,
      displayName: "Super Admin",
      status: "active",
    },
    create: {
      organizationId: organization.id,
      email,
      passwordHash,
      displayName: "Super Admin",
      status: "active",
    },
  });

  console.log(`Super Admin ready: ${email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
