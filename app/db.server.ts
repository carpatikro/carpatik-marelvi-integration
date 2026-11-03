import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { marelviPrisma?: PrismaClient };

export const prisma = globalForPrisma.marelviPrisma ?? new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

if (process.env.NODE_ENV !== "production") globalForPrisma.marelviPrisma = prisma;
