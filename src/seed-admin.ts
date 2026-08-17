import "dotenv/config";
import bcrypt from "bcryptjs";
import { createPrismaClient } from "./config/prisma";
import { PERMISSIONS } from "./auth/permissions";

const prisma = createPrismaClient();

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD are required before running this seed.",
    );
  }

  const organization = await prisma.organization.findUnique({
    where: { code: "ASRGH" },
  });

  if (!organization) {
    throw new Error("ASRGH organization not found");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.adminUser.upsert({
    where: {
      organizationId_email: {
        organizationId: organization.id,
        email,
      },
    },
    update: {
      passwordHash,
      displayName: process.env.INITIAL_ADMIN_DISPLAY_NAME ?? email,
      status: "active",
    },
    create: {
      organizationId: organization.id,
      email,
      passwordHash,
      displayName: process.env.INITIAL_ADMIN_DISPLAY_NAME ?? email,
      status: "active",
    },
  });

  const permissionCodes = Object.values(PERMISSIONS);
  const permissions = await Promise.all(permissionCodes.map((code) => prisma.permission.upsert({
    where: { code },
    update: { name: code, module: code.split(".")[0] },
    create: { code, name: code, module: code.split(".")[0] },
  })));
  const systemRole = await prisma.role.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: "system-admin" } },
    update: { isSystemRole: true, isActive: true },
    create: { organizationId: organization.id, code: "system-admin", name: "System Administrator", isSystemRole: true },
  });
  await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: systemRole.id, permissionId: permission.id })), skipDuplicates: true });
  await prisma.adminUserRole.createMany({ data: [{ adminUserId: admin.id, roleId: systemRole.id }], skipDuplicates: true });

  console.log(`Initial administrator ready: ${email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
