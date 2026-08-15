import { prisma } from "./config/prisma";

async function main() {
  const count = await prisma.organization.count();
  console.log("Database connection successful. Organizations:", count);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
