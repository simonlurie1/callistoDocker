import { PrismaClient } from "@prisma/client";
import type { Repositories } from "../index";
import { PrismaConversionEventRepository } from "./PrismaConversionEventRepository";
import { PrismaLeadRepository } from "./PrismaLeadRepository";

/** Builds the Prisma-backed repositories on one shared client. */
export function createPrismaRepositories(): Repositories {
  const prisma = new PrismaClient();
  return {
    leads: new PrismaLeadRepository(prisma),
    conversionEvents: new PrismaConversionEventRepository(prisma),
    disconnect: () => prisma.$disconnect(),
  };
}
