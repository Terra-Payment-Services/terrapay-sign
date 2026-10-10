import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

import { ENV_FILES } from './reporters/secret-values';

function calculateWorkers() {
  const total = os.cpus().length;

  // Reserve 2 cores for the system
  const usable = Math.max(total - 2, 1);

  // 1 worker per 2 cores, minimum 1
  const workers = Math.max(Math.floor(usable / 2), 1);

  // Max 6 workers
  return Math.min(workers, 6);
}

ENV_FILES.forEach((file) => {
  dotenv.config({
    path: path.join(__dirname, `../../${file}`),
  });
});

/**
 * Remote mode. Set E2E_BASE_URL to the origin of an already deployed instance
 * and the run targets that instance instead of a server booted here.
 *
 * The server comes from `start-server-and-test` in the test:e2e script, so
 * the remote script leaves that wrapper out and Playwright finds an instance
 * already listening.
 *
 * Only the specs under e2e/remote/ run in this mode. Every other spec in the
 * suite seeds the database through @documenso/prisma, and a deployed instance
 * gives the runner no route to that database, so those specs stay on the
 * local path.
 */
const remoteBaseUrl = process.env.E2E_BASE_URL?.trim();
const isRemote = Boolean(remoteBaseUrl);

const baseUrl = remoteBaseUrl || process.env.NEXT_PUBLIC_WEBAPP_URL || 'http://localhost:3000';

if (isRemote) {
  const parsed = new URL(baseUrl);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`E2E_BASE_URL must be an http or https origin, got ${baseUrl}`);
  }
}

/**
 * The app reads this cookie to turn off animations, which makes assertions on
 * moving elements stable. A cookie is scoped to a host, so the domain has to
 * follow whatever origin the run is pointed at.
 */
function animationCookieDomain() {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'localhost';
  }
}

function baseUrlIsSecure() {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A remote run shares one deployed instance, which during a canary deploy is
 * a single task behind the load balancer. Six browsers against one task
 * measure the task's capacity, so the remote project stays narrow.
 */
const REMOTE_WORKERS = 2;

const remoteProject = {
  name: 'remote',
  testMatch: /e2e\/remote\/.*\.spec\.ts/,
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1920, height: 1200 },
    // No traces here at all. The signing journey sends E2E_REMOTE_API_TOKEN
    // as a bearer header, a trace records request headers, and a failed run's
    // trace would carry the token into the job artifacts. Screenshots and
    // failure videos stay, from the shared settings below.
    trace: 'off',
  },
  workers: REMOTE_WORKERS,
};

const localProjects = [
  // API Tests e2e/api/**/*.spec.ts
  {
    name: 'api',
    testMatch: /e2e\/api\/.*\.spec\.ts/,
    workers: 10, // Limited by DB connections before it gets flakey.
  },
  // Run UI Tests (excluding remote tests which have their own project)
  {
    name: 'ui',
    testMatch: /e2e\/(?!api\/).*\.spec\.ts/,
    testIgnore: [/e2e\/remote\/.*\.spec\.ts/, /e2e\/directory-sync\/.*\.spec\.ts/],
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1920, height: 1200 },
    },
    workers: calculateWorkers(),
  },
  // The directory sync specs start a built server of their own per test,
  // with the sync configured against a stub of Microsoft Graph, and give each
  // worker a database of its own: the sync considers every account in the
  // database, so it cannot share one with specs seeding users in parallel.
  // Their own project keeps a worker, and so its database, to these files.
  {
    name: 'directory-sync',
    testMatch: /e2e\/directory-sync\/.*\.spec\.ts/,
    workers: 2,
  },
  // The remote-capable specs run on the local path too, against the server
  // start-server-and-test boots. That keeps them exercised on every local run
  // and every merge request, so they hold their shape between deploys.
  remoteProject,
];

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Ten is what upstream chose, sized by database connections on a large
  // machine. Our runner has four cores and seven gigabytes, and ten workers
  // each holding a browser and a Prisma client alongside the application
  // server exhausted it: the server died and every test after that failed on a
  // reset socket. E2E_WORKERS lets the job size this to the machine it is on.
  workers: isRemote ? REMOTE_WORKERS : Number(process.env.E2E_WORKERS) || 10,
  // Stopping at the first failure is right when a human is waiting and wrong
  // for a gate: the run reports one failure and says nothing about the other
  // thousand tests, so you cannot tell a single broken spec from a dead
  // server. E2E_MAX_FAILURES lets the pipeline see enough to diagnose.
  maxFailures: process.env.E2E_MAX_FAILURES ? Number(process.env.E2E_MAX_FAILURES) : process.env.CI ? 1 : undefined,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 4 : 1,
  // Every reporter on every run, local or CI, so a run leaves results a
  // machine can read and someone else can check. CI used to add junit with a
  // --reporter flag, which replaces this list rather than extending it: the
  // staging job's flag left it with no html report at all. The html report
  // never opens itself, so a local run ends when the tests do. The manifest
  // reporter writes test-results/manifest.json: commit, command, target, seed
  // and tool versions, so the run can be checked and repeated.
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['./reporters/manifest-reporter.ts'],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: baseUrl,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // Passing tests keep a screenshot too, so a green run shows what it reached.
    screenshot: 'on',

    /* Add explicit timeouts for actions */
    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    contextOptions: {
      reducedMotion: 'reduce',
    },

    /* Disable animations via cookie for more stable tests */
    storageState: {
      cookies: [
        {
          name: '__disable_animations',
          value: 'true',
          domain: animationCookieDomain(),
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: baseUrlIsSecure(),
          sameSite: 'Lax' as const,
        },
      ],
      origins: [],
    },
  },

  timeout: 60_000,

  /* Configure projects for major browsers */
  projects: isRemote ? [remoteProject] : localProjects,

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://127.0.0.1:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
