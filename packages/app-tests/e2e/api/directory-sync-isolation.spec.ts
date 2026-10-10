import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

/**
 * The directory sync specs give their own workers a private database. Loading
 * them must not move any other spec onto it: pipeline 54190 ran them in one
 * invocation with other specs, and every other spec failed in seedUser with
 * "Database `dirsync_<pid>` does not exist", because the module that chooses
 * the private database had changed the environment of the runner process,
 * which every worker inherits.
 */
test('a spec outside directory-sync seeds into the harness database', async () => {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db');

  expect(db).not.toMatch(/^dirsync_/);
  expect(process.env.NEXT_PRIVATE_DATABASE_URL ?? '').not.toMatch(/\/dirsync_/);

  const { user } = await seedUser();

  expect(user.id).toBeGreaterThan(0);
});
