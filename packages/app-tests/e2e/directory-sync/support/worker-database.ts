/**
 * A database of this worker's own, so the directory sync sees only the users a
 * test seeded.
 *
 * The sync considers every account in the database. The rest of the suite
 * seeds users into the shared e2e database from other workers at the same
 * time, and a correct sync would disable every one of them, because none is in
 * the stub directory. So these specs run against a database cut from a
 * migrated template, recreated before each test, on the same Postgres server
 * the harness uses.
 *
 * IMPORT THIS MODULE FIRST in every directory-sync spec. `@documenso/prisma`
 * fixes its connection string when it is first imported, and this module has
 * to change the connection string before that happens.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA = path.join(REPO_ROOT, 'packages/prisma/schema.prisma');

/**
 * Playwright loads every spec file in the runner process to list the tests,
 * and every worker, of every project, is forked from the runner and inherits
 * its environment. Changing the database here in the runner moved every
 * other spec in the invocation onto a database that does not exist (pipeline
 * 54190). So the change is made only inside a test worker, which Playwright
 * marks with TEST_WORKER_INDEX. The directory-sync project's testMatch, and
 * the other projects' testIgnore, keep these files out of every other
 * project's workers, so no other spec ever shares a process with the change.
 */
const isTestWorker = process.env.TEST_WORKER_INDEX !== undefined;

// The harness database as configured, kept aside in case anything in this
// process already ran this module or saw the change.
const harnessUrl = process.env.DIRSYNC_HARNESS_DATABASE_URL ?? process.env.NEXT_PRIVATE_DATABASE_URL;

if (!harnessUrl) {
  throw new Error('NEXT_PRIVATE_DATABASE_URL is not set; the directory sync specs need the harness Postgres.');
}

const withDatabase = (url: string, database: string) => {
  const parsed = new URL(url.replace(/^postgres(ql)?:/, 'https:'));

  parsed.pathname = `/${database}`;

  return parsed.toString().replace(/^https:/, 'postgres:');
};

// One worker is one process. The pid alone keeps two workers of one run
// apart, but a later run, or another runner on a shared Postgres, can be given
// the same pid and would then reuse a template migrated from another commit.
// A random part makes the names unique to this process in this run.
const RUN_PART = randomBytes(6).toString('hex');
const WORKER_DATABASE = `dirsync_${RUN_PART}_${process.pid}`;
const TEMPLATE_DATABASE = `dirsync_tpl_${RUN_PART}_${process.pid}`;

export const workerDatabaseName = WORKER_DATABASE;
export const templateDatabaseName = TEMPLATE_DATABASE;

export const workerDatabaseUrl = withDatabase(harnessUrl, WORKER_DATABASE);

if (isTestWorker) {
  process.env.DIRSYNC_HARNESS_DATABASE_URL = harnessUrl;
  process.env.NEXT_PRIVATE_DATABASE_URL = workerDatabaseUrl;
  process.env.NEXT_PRIVATE_DIRECT_DATABASE_URL = workerDatabaseUrl;
}

let adminClient: PrismaClient | undefined;

const admin = () => {
  adminClient ??= new PrismaClient({ datasourceUrl: harnessUrl });

  return adminClient;
};

let templateReady = false;

const ensureTemplate = async () => {
  if (templateReady) {
    return;
  }

  const existing = await admin().$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM pg_database WHERE datname = '${TEMPLATE_DATABASE}'`,
  );

  if (existing.length === 0) {
    await admin().$executeRawUnsafe(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);

    const templateUrl = withDatabase(harnessUrl, TEMPLATE_DATABASE);

    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', SCHEMA], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NEXT_PRIVATE_DATABASE_URL: templateUrl,
        NEXT_PRIVATE_DIRECT_DATABASE_URL: templateUrl,
        NODE_OPTIONS: '',
      },
      encoding: 'utf8',
    });

    if (migrate.status !== 0) {
      await admin().$executeRawUnsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);

      throw new Error(
        `prisma migrate deploy failed for the directory sync template:\n${migrate.stdout}\n${migrate.stderr}`,
      );
    }
  }

  templateReady = true;
};

/**
 * Give this worker a freshly migrated, empty database: the state a deployment
 * is in after `prisma migrate deploy`, which includes the two built-in service
 * accounts the migrations create.
 *
 * @param disconnect - Closes the caller's own `@documenso/prisma` client first,
 *   so the drop does not pull connections out from under it. Prisma reconnects
 *   on the next query.
 * @param currentDatabase - Asks that client which database it is connected to.
 */
export const resetWorkerDatabase = async (disconnect: () => Promise<void>, currentDatabase: () => Promise<string>) => {
  await ensureTemplate();
  await disconnect();

  await admin().$executeRawUnsafe(`DROP DATABASE IF EXISTS "${WORKER_DATABASE}" WITH (FORCE)`);
  await admin().$executeRawUnsafe(`CREATE DATABASE "${WORKER_DATABASE}" TEMPLATE "${TEMPLATE_DATABASE}"`);

  // If anything imported @documenso/prisma before this module, the seeds and
  // the reads would go to the harness database while the server under test
  // used this one, and every assertion would fail looking like a product bug.
  const connected = await currentDatabase();

  if (connected !== WORKER_DATABASE) {
    throw new Error(
      `@documenso/prisma is connected to ${connected}, not ${WORKER_DATABASE}. Import ./support/worker-database first.`,
    );
  }
};

/**
 * Drop this worker's database and its template, so a run leaves nothing on the
 * Postgres server. Called once, when the worker shuts down.
 */
export const releaseWorkerDatabases = async () => {
  if (!adminClient) {
    return;
  }

  await adminClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${WORKER_DATABASE}" WITH (FORCE)`);
  await adminClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);
  await adminClient.$disconnect();

  adminClient = undefined;
  templateReady = false;
};
