import { createPrismaClient } from "./config/prisma";

const prisma = createPrismaClient();

async function main() {
  await prisma.organization.upsert({
    where: { code: "ASRGH" },
    update: {},
    create: {
      code: "ASRGH",
      name: "Aggarwal Sabha Rohini Group Housing",
      legalName: "Aggarwal Sabha Rohini Group Housing",
      websiteUrl: "https://www.asrgh.com",
      country: "India",
    },
  });

  console.log("ASRGH organization created.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
