/**
 * The directory sync specs' own databases (criterion 27): unique to
 * the run, and gone when it ends.
 *
 * A name built from the pid alone is reused whenever a later run, or another
 * runner on a shared Postgres, gets the same pid, and then picks up a stale
 * template migrated from another commit. Databases left behind by every run
 * accumulate on the server. Each case starts a child process that takes and
 * releases its databases exactly as a test worker does, then checks Postgres.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const CHILD = path.join(__dirname, 'support/database-lifecycle-child.ts');

type Report = { pid: number; database: string; template: string; existedWhileInUse: boolean };

const harnessUrl = () => {
  const url = process.env.DIRSYNC_HARNESS_DATABASE_URL ?? process.env.NEXT_PRIVATE_DATABASE_URL;

  if (!url) {
    throw new Error('NEXT_PRIVATE_DATABASE_URL is not set.');
  }

  return url;
};

const runWorker = (): Report => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'DIRSYNC_HARNESS_DATABASE_URL') {
      env[key] = value;
    }
  }

  env.TEST_WORKER_INDEX = '0';
  env.NEXT_PRIVATE_DATABASE_URL = harnessUrl();
  env.NEXT_PRIVATE_DIRECT_DATABASE_URL = harnessUrl();

  const child = spawnSync(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: path.resolve(__dirname, '../..'),
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });

  expect(child.status, `the stand-in worker failed:\n${child.stdout}\n${child.stderr}`).toBe(0);

  const line = child.stdout.trim().split('\n').pop() ?? '';

  return JSON.parse(line) as Report;
};

test.describe.configure({ timeout: 300_000 });

test('27: each run gets databases of its own, and they are dropped when it ends', async () => {
  const admin = new PrismaClient({ datasourceUrl: harnessUrl() });

  try {
    const first = runWorker();
    const second = runWorker();

    for (const report of [first, second]) {
      expect(report.existedWhileInUse, 'the databases existed while the worker used them').toBe(true);
      expect(report.database, 'the name carries more than the pid').not.toBe(`dirsync_${report.pid}`);
      expect(report.template, 'the template name carries more than the pid').not.toBe(`dirsync_tpl_${report.pid}`);
      expect(report.database).toMatch(/^dirsync_/);
    }

    expect(new Set([first.database, first.template, second.database, second.template]).size).toBe(4);

    const left = await admin.$queryRawUnsafe<{ datname: string }[]>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
      [first.database, first.template, second.database, second.template],
    );

    expect(
      left.map((d) => d.datname),
      'databases still on the server after the worker ended',
    ).toEqual([]);
  } finally {
    await admin.$disconnect();
  }
});
