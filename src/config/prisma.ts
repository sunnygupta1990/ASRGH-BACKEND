// backened/src/config/prisma.ts

import "dotenv/config";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";

export type AppPrisma = PrismaClient;

let sharedPrisma: AppPrisma | undefined;
let sharedConnectionString: string | undefined;

function instantiatePrismaClient(connectionString: string): AppPrisma {
  const adapter = new PrismaNeon({
    connectionString,
  });

  return new PrismaClient({
    adapter,
  });
}

export function createRequestPrismaClient(
  connectionString: string,
): AppPrisma {
  return instantiatePrismaClient(connectionString);
}

export function createPrismaClient(
  connectionString = process.env.DATABASE_URL!,
): AppPrisma {
  if (sharedPrisma && sharedConnectionString === connectionString) {
    return sharedPrisma;
  }

  sharedPrisma = instantiatePrismaClient(connectionString);
  sharedConnectionString = connectionString;

  return sharedPrisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (!sharedPrisma) {
    return;
  }

  await sharedPrisma.$disconnect();
  sharedPrisma = undefined;
  sharedConnectionString = undefined;
}
