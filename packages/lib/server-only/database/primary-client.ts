import { prisma } from '@documenso/prisma';

/**
 * The primary database client, for reads that must see the latest commit.
 *
 * The exported client reads from replicas when NEXT_PRIVATE_DATABASE_REPLICA_URLS is set, and a replica can lag the
 * primary. The read-replicas extension then exposes the primary as `$primary()`; without replicas the exported
 * client is the primary already.
 */
export const primaryClient = (): typeof prisma => {
  const client = prisma as typeof prisma & { $primary?: () => typeof prisma };

  return typeof client.$primary === 'function' ? client.$primary() : prisma;
};
