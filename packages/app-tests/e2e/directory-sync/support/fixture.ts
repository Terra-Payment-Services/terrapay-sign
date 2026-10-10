import './worker-database';

import { prisma } from '@documenso/prisma';
import { test as base, expect } from '@playwright/test';
import { type DirectoryUser, type GraphStub, type GraphStubOptions, startGraphStub } from './graph-stub';
import {
  attachEvidence,
  type RunOutcome,
  redisUrl,
  runDirectorySync,
  type SignServer,
  spawnSignServer,
  waitUntilServing,
} from './sign-server';
import { SYNC_CLIENT_ID, SYNC_CLIENT_SECRET, TENANT_ID } from './tenant';
import { releaseWorkerDatabases, resetWorkerDatabase } from './worker-database';

export type RunOptions = {
  /** Settings layered over a live configuration; `undefined` removes one. */
  env?: Record<string, string | undefined>;
  stub?: Omit<Partial<GraphStubOptions>, 'users'>;
  timeoutMs?: number;
};

export type SyncRun = {
  outcome: RunOutcome;
  stub: GraphStub;
  /** Everything the server wrote from the moment the run was queued. */
  log: string;
  /** Everything the server wrote from start to the end of the run. */
  fullLog: string;
};

/**
 * A live configuration: BullMQ, the three Entra settings, dry run off. The
 * minimum is set low and the disable limit at the most the start-up guard
 * allows, so that tests about matching are not decided by a safety stop. Tests
 * about the stops set their own.
 *
 * The server runs with NODE_ENV=test, as the e2e harness runs its own. In
 * production a server given the Graph or login base URL refuses to start
 * (criterion 22), so the stub can only be reached outside production. The
 * start-up guard has a spec of its own; NOT_REQUIRED stays set so that these
 * tests do not depend on how the guard reads NODE_ENV.
 */
export const liveEnv = (stub: GraphStub): Record<string, string> => ({
  NODE_ENV: 'test',
  // The stub speaks HTTPS with a certificate of its own.
  NODE_EXTRA_CA_CERTS: stub.caFile,
  NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq',
  NEXT_PRIVATE_REDIS_URL: redisUrl(),
  NEXT_PRIVATE_ENTRA_TENANT_ID: TENANT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_ID: SYNC_CLIENT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_SECRET: SYNC_CLIENT_SECRET,
  NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL: stub.graphBaseUrl,
  NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL: stub.loginBaseUrl,
  NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'false',
  NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '1',
  NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.5',
  NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED: 'true',
  NEXT_PRIVATE_MICROSOFT_TENANT: TENANT_ID,
});

type SyncHarness = {
  /** The tenant as Graph will report it. Add to it before calling `run`. */
  directory: DirectoryUser[];
  run: (options?: RunOptions) => Promise<SyncRun>;
};

export const test = base.extend<{ sync: SyncHarness }, { workerDatabases: undefined }>({
  // When the worker shuts down, drop its database and template, so the run
  // leaves nothing behind on the Postgres server (criterion 27).
  workerDatabases: [
    // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
    async ({}, use) => {
      await use(undefined);
      await prisma.$disconnect();
      await releaseWorkerDatabases();
    },
    { scope: 'worker', auto: true },
  ],
  // Playwright reads fixture dependencies from this destructuring; there are none.
  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  sync: async ({}, use, testInfo) => {
    await resetWorkerDatabase(
      async () => await prisma.$disconnect(),
      async () => (await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db'))[0].db,
    );

    const directory: DirectoryUser[] = [];
    const started: { stub?: GraphStub; server?: SignServer }[] = [];

    const run = async (options: RunOptions = {}): Promise<SyncRun> => {
      const stub = await startGraphStub({
        tenantId: TENANT_ID,
        clientId: SYNC_CLIENT_ID,
        clientSecret: SYNC_CLIENT_SECRET,
        users: directory,
        ...options.stub,
      });

      const slot: { stub?: GraphStub; server?: SignServer } = { stub };
      started.push(slot);

      const server = await spawnSignServer({ ...liveEnv(stub), ...options.env });
      slot.server = server;

      await waitUntilServing(server);

      const offset = server.output().length;
      const outcome = await runDirectorySync(server, options.timeoutMs);

      // In production pino writes to the log file through a worker thread, so
      // the last lines can land after the job has finished. Wait for quiet.
      let previous = -1;
      const settleBy = Date.now() + 5_000;

      while (Date.now() < settleBy && server.output().length !== previous) {
        previous = server.output().length;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return { outcome, stub, log: server.outputSince(offset), fullLog: server.output() };
    };

    await use({ directory, run });

    for (const [index, { stub, server }] of started.entries()) {
      if (stub) {
        await attachEvidence(testInfo, `graph-transcript-${index}.json`, stub.transcript);
      }

      if (server) {
        await attachEvidence(testInfo, `sign-server-${index}.log`, server.output());
        await server.stop();
      }

      if (stub) {
        await stub.stop();
      }
    }

    await attachEvidence(testInfo, 'directory.json', directory);
  },
});

export { expect };

/**
 * The run reached the stub: it asked the configured login endpoint for a
 * client-credentials token and, unless `tokenOnly`, read users from the
 * configured Graph. Without this a run that never left the building would pass
 * every test that expects nobody to be disabled.
 */
export const expectDirectoryWasRead = (run: SyncRun, { tokenOnly = false } = {}) => {
  const tokens = run.stub.tokenRequests();

  expect(tokens.length, 'token requests to the configured login base URL').toBeGreaterThan(0);
  expect(tokens[0].body ?? '').toContain('grant_type=client_credentials');

  if (!tokenOnly) {
    expect(run.stub.userPageRequests().length, 'user list requests to the configured Graph base URL').toBeGreaterThan(
      0,
    );
  }
};

const FAILURE_SUBJECT = /graph|directory|entra|microsoft|token|reconcile|sync|users|page/i;
const FAILURE_WORD = /fail|error|abort|timed? ?out|timeout|invalid|malformed|unexpected|refus|stop/i;

/** Some single log line ties a failure to the directory read. */
export const expectFailureLogged = (run: SyncRun) => {
  const lines = run.log.split('\n').filter((line) => FAILURE_SUBJECT.test(line) && FAILURE_WORD.test(line));

  expect(lines.length, `a log line reporting the directory failure in:\n${run.log}`).toBeGreaterThan(0);
};
