/**
 * Start-up guard: a production server that would not disable leavers does not
 * start (criteria 16 to 18, failure mode F6).
 *
 * Each case starts the built server the way the image does
 * (`node build/server/main.js`, NODE_ENV=production) with one setting changed
 * from a configuration that is otherwise live, and observes only whether it
 * comes up: a refused start exits non-zero without ever answering HTTP; an
 * accepted one answers. Because each refused case differs from the accepted
 * baseline by one setting, the refusal is attributable to that setting.
 */
import { expect, type TestInfo, test } from '@playwright/test';
import { attachEvidence, redisUrl, spawnSignServer } from './support/sign-server';
import { SYNC_CLIENT_ID, SYNC_CLIENT_SECRET, TENANT_ID } from './support/tenant';

test.describe.configure({ mode: 'parallel', timeout: 180_000 });

const liveProduction = (): Record<string, string | undefined> => ({
  NODE_ENV: 'production',
  NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq',
  NEXT_PRIVATE_REDIS_URL: redisUrl(),
  NEXT_PRIVATE_ENTRA_TENANT_ID: TENANT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_ID: SYNC_CLIENT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_SECRET: SYNC_CLIENT_SECRET,
  NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'false',
  NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '700',
});

type Outcome = { started: boolean; code: number | null; output: string };

/** Start the server and report whether it came up. */
const startWith = async (env: Record<string, string | undefined>, testInfo: TestInfo) => {
  // These servers need only a reachable, migrated database. In a worker that
  // has loaded the sync specs, use the harness one rather than the worker's.
  const harness = process.env.DIRSYNC_HARNESS_DATABASE_URL;
  const database = harness ? { NEXT_PRIVATE_DATABASE_URL: harness, NEXT_PRIVATE_DIRECT_DATABASE_URL: harness } : {};
  const server = await spawnSignServer({ ...database, ...env });
  const deadline = Date.now() + 120_000;
  let outcome: Outcome | undefined;

  try {
    while (!outcome && Date.now() < deadline) {
      if (server.hasExited()) {
        const { code } = await server.exit;
        outcome = { started: false, code, output: server.output() };
        break;
      }

      try {
        await fetch(`${server.origin}/favicon.ico`, { signal: AbortSignal.timeout(2_000) });
        outcome = { started: true, code: null, output: server.output() };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    if (!outcome) {
      throw new Error(`The server neither served nor exited within two minutes.\n${server.output()}`);
    }

    return outcome;
  } finally {
    await attachEvidence(testInfo, 'sign-server.log', server.output());
    await attachEvidence(
      testInfo,
      'environment.json',
      Object.fromEntries(Object.entries(env).map(([k, v]) => [k, /SECRET|REDIS_URL/.test(k) && v ? 'REDACTED' : v])),
    );
    await server.stop();
  }
};

const expectRefused = (outcome: Outcome) => {
  expect(outcome.started, `the server should have refused to start:\n${outcome.output}`).toBe(false);
  expect(outcome.code, 'a refused start exits non-zero').not.toBe(0);
};

const expectStarted = (outcome: Outcome) => {
  expect(outcome.started, `the server should have started:\n${outcome.output}`).toBe(true);
};

test.describe('[DIRECTORY SYNC]: production start-up guard', () => {
  test('16 / F6: a live production configuration starts', async () => {
    const testInfo = test.info();

    expectStarted(await startWith(liveProduction(), testInfo));
  });

  const accepted: [string, Record<string, string | undefined>][] = [
    ['a minimum of 1', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '1' }],
    [
      'the largest safe integer as the minimum',
      { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: String(Number.MAX_SAFE_INTEGER) },
    ],
    ['a disable ratio of 0.5', { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.5' }],
    ['a disable ratio of 0.1', { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.1' }],
  ];

  for (const [label, change] of accepted) {
    test(`16 / F6: production starts with ${label}`, async () => {
      const testInfo = test.info();

      expectStarted(await startWith({ ...liveProduction(), ...change }, testInfo));
    });
  }

  const refused: [string, Record<string, string | undefined>][] = [
    ['the local jobs provider', { NEXT_PRIVATE_JOBS_PROVIDER: 'local' }],
    ['no jobs provider', { NEXT_PRIVATE_JOBS_PROVIDER: undefined }],
    ['no tenant id', { NEXT_PRIVATE_ENTRA_TENANT_ID: undefined }],
    ['no client id', { NEXT_PRIVATE_ENTRA_CLIENT_ID: undefined }],
    ['no client secret', { NEXT_PRIVATE_ENTRA_CLIENT_SECRET: undefined }],
    ['a blank client secret', { NEXT_PRIVATE_ENTRA_CLIENT_SECRET: '' }],
    ['dry run unset', { NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: undefined }],
    ['dry run "true"', { NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'true' }],
    ['dry run "FALSE"', { NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'FALSE' }],
    ['no minimum', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: undefined }],
    ['a minimum of 0', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '0' }],
    ['a negative minimum', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '-700' }],
    ['a fractional minimum', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '700.5' }],
    ['a blank minimum', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '' }],
    ['a whitespace minimum', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '   ' }],
    ['a non-numeric minimum', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: 'seven hundred' }],
    ['a minimum beyond the safe integer range', { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '9007199254740993' }],
    ['a disable ratio of 0', { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0' }],
    ['a negative disable ratio', { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '-0.1' }],
    ['a disable ratio above 0.5', { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.51' }],
    ['a disable ratio of 1', { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '1' }],
    ['a non-numeric disable ratio', { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: 'ten percent' }],
  ];

  for (const [label, change] of refused) {
    test(`16 / F6: production refuses to start with ${label}`, async () => {
      const testInfo = test.info();

      expectRefused(await startWith({ ...liveProduction(), ...change }, testInfo));
    });
  }

  // Criterion 22: in production the sync talks only to Microsoft, so a server
  // told to send its client secret and Graph token anywhere else does not
  // start, and NOT_REQUIRED does not change that. Loopback stands in for a
  // somewhere else that would receive them.
  for (const setting of ['NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL', 'NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL']) {
    for (const [label, notRequired] of [
      ['', undefined],
      [' even with NOT_REQUIRED=true', 'true'],
    ] as const) {
      test(`22: production refuses to start with ${setting} set${label}`, async () => {
        const testInfo = test.info();

        const outcome = await startWith(
          {
            ...liveProduction(),
            [setting]: 'http://127.0.0.1:9',
            NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED: notRequired,
          },
          testInfo,
        );

        expectRefused(outcome);
        // The operator has to know what to remove, and an unrelated crash
        // must not pass for the refusal.
        expect(outcome.output, `the refusal names ${setting}`).toContain(setting);
      });
    }
  }

  // Criterion 31: present at all means refused, an empty value included.
  for (const setting of ['NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL', 'NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL']) {
    for (const [label, notRequired] of [
      ['', undefined],
      [' even with NOT_REQUIRED=true', 'true'],
    ] as const) {
      test(`31: production refuses to start with ${setting} present but empty${label}`, async () => {
        const testInfo = test.info();

        const outcome = await startWith(
          { ...liveProduction(), [setting]: '', NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED: notRequired },
          testInfo,
        );

        expectRefused(outcome);
        expect(outcome.output, `the refusal names ${setting}`).toContain(setting);
      });
    }
  }

  test('22: production refuses an inert NOT_REQUIRED configuration that sets a Graph base URL', async () => {
    const testInfo = test.info();

    const outcome = await startWith(
      {
        NODE_ENV: 'production',
        NEXT_PRIVATE_JOBS_PROVIDER: 'local',
        NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'true',
        NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED: 'true',
        NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL: 'http://127.0.0.1:9',
      },
      testInfo,
    );

    expectRefused(outcome);
    expect(outcome.output, 'the refusal names NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL').toContain(
      'NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL',
    );
  });

  test('22: outside production the Graph and login base URLs may be set', async () => {
    const testInfo = test.info();

    expectStarted(
      await startWith(
        {
          ...liveProduction(),
          NODE_ENV: 'test',
          NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL: 'http://127.0.0.1:9',
          NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL: 'http://127.0.0.1:9',
        },
        testInfo,
      ),
    );
  });

  test('17: outside production an inert configuration starts', async () => {
    const testInfo = test.info();

    expectStarted(
      await startWith(
        {
          NODE_ENV: 'test',
          NEXT_PRIVATE_JOBS_PROVIDER: 'local',
          NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'true',
        },
        testInfo,
      ),
    );
  });

  test('17: NOT_REQUIRED=true lets an inert production configuration start', async () => {
    const testInfo = test.info();

    expectStarted(
      await startWith(
        {
          NODE_ENV: 'production',
          NEXT_PRIVATE_JOBS_PROVIDER: 'local',
          NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'true',
          NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED: 'true',
        },
        testInfo,
      ),
    );
  });

  test('17: NOT_REQUIRED=true lets production start with unsafe limits', async () => {
    const testInfo = test.info();

    expectStarted(
      await startWith(
        {
          ...liveProduction(),
          NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '0',
          NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '1',
          NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED: 'true',
        },
        testInfo,
      ),
    );
  });
});
