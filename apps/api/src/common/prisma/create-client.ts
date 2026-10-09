import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Builds a PrismaClient wired to the pg driver adapter (Prisma 7). Used by PrismaService, the seed
 * script and test utilities. Nest-free on purpose.
 */
export function createPrismaClient(connectionString: string, poolMax = 10): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max: poolMax }) });
}
