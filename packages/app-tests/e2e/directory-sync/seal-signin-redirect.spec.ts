/**
 * The sign-in page a signer reaches from the signing page's account dialog.
 *
 * Written from the specification alone, before
 * any fix exists.
 *
 * | Test                                                                   | Criteria | Failure modes |
 * | ---------------------------------------------------------------------- | -------- | ------------- |
 * | A: after the dialog's Login the embedded sign-in page shows an enabled | A, 1     | F1            |
 * |   "Sign in with Microsoft" button                                      |          |               |
 * | B: clicking it starts the Microsoft authorisation and carries the      | B, 2     | F1, F2        |
 * |   signing page as the path to return to                                |          |               |
 * | C: /signin?returnTo=... without the hash still shows the button        | C, 4     | F3            |
 * | 3: with email and password sign-in on, the embedded page shows the    | 3        | F4            |
 * |   form and no Microsoft button (control, passes before and after)      |          |               |
 *
 * F1: the hash `#embedded=true` hides the button, leaving an empty form. The server first paints the button and the
 *     browser removes it once it reads the hash, so the tests wait for the page to settle before asserting.
 * F2: the button starts the authorisation with the wrong or no return path.
 * F3: the fix hides or changes the button on the plain page.
 * F4: the fix shows the Microsoft button on the embedded page when email and password sign-in is on.
 *
 * The harness server has email and password sign-in on and no Microsoft client,
 * so the spec starts built servers of its own with the production configuration
 * (dummy NEXT_PRIVATE_MICROSOFT_CLIENT_ID and NEXT_PRIVATE_MICROSOFT_CLIENT_SECRET,
 * NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true, or unset for the control),
 * through the directory-sync specs' spawnSignServer. Both settings reach the
 * page from the sign-in loader, which reads the server's environment at run
 * time.
 *
 * The file lives in e2e/directory-sync/ so that project's isolation applies: a
 * production server runs background jobs, among them the directory reconcile,
 * and they must not see the shared e2e database. Each worker has a database of
 * its own (support/worker-database.ts). The worker's server runs on the port
 * that support/worker-origin.ts chose before the seal fixtures loaded, so the
 * fixtures' seeding calls and the browser reach that server and its database.
 * Test C is the control for A and B: it passes only when the configuration is
 * in place, so a red A or B with a green C comes from the hash and not from the
 * environment. Test 3 is the control for the unchanged email-enabled path.
 *
 * B stops at the browser's edge. It captures the request the button sends to
 * the application's own authorise route, answers it with a fixed Microsoft
 * authorisation URL so no network is needed, and aborts the navigation to that
 * URL. No Microsoft login is attempted. The primary outcome is that the browser
 * reaches the Microsoft URL; the request body then shows the return path.
 *
 * Expected on main (red run): A and B fail on the missing button; C and 3 pass.
 */
// First, so this worker's database is chosen before @documenso/prisma connects; then the origin, before any fixture.
import './support/worker-database';
import './support/worker-origin';

import { prisma } from '@documenso/prisma';
import { expect, type Page } from '@playwright/test';
import { SEAL_UI, test as sealTest, setupMemberSeal } from '../fixtures/company-seals';
import { redisUrl, type SignServer, spawnSignServer, waitUntilServing } from './support/sign-server';
import { SYNC_CLIENT_ID, SYNC_CLIENT_SECRET, TENANT_ID } from './support/tenant';
import { releaseWorkerDatabases, resetWorkerDatabase } from './support/worker-database';
import { workerOrigin, workerPort } from './support/worker-origin';

/** Microsoft sign-in configured, as in production; email and password sign-in is the one setting a test varies. */
const productionEnv = (emailPasswordSignin: boolean): Record<string, string | undefined> => ({
  // The production start-up guard refuses a server without these (startup-guard.spec.ts).
  NODE_ENV: 'production',
  NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq',
  NEXT_PRIVATE_REDIS_URL: redisUrl(),
  NEXT_PRIVATE_ENTRA_TENANT_ID: TENANT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_ID: SYNC_CLIENT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_SECRET: SYNC_CLIENT_SECRET,
  NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'false',
  NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '700',
  NEXT_PRIVATE_MICROSOFT_CLIENT_ID: 'e2e-microsoft-client-id',
  NEXT_PRIVATE_MICROSOFT_CLIENT_SECRET: 'e2e-microsoft-client-secret',
  NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: emailPasswordSignin ? undefined : 'true',
  NEXT_PUBLIC_DISABLE_MICROSOFT_SIGNIN: undefined,
  NEXT_PUBLIC_DISABLE_SIGNIN: undefined,
});

/**
 * `server` is the worker's production server with email and password sign-in off. It runs on the port the fixtures
 * were told, against the worker's own database, so the seeding calls and the browser reach the same server. Its
 * background jobs therefore touch only that database.
 */
const test = sealTest.extend<{ emailServer: SignServer }, { server: SignServer }>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
    async ({}, use) => {
      await resetWorkerDatabase(
        async () => await prisma.$disconnect(),
        async () => (await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db'))[0].db,
      );

      const server = await spawnSignServer({
        ...productionEnv(false),
        PORT: String(workerPort),
        NEXT_PUBLIC_WEBAPP_URL: workerOrigin,
        NEXT_PRIVATE_INTERNAL_WEBAPP_URL: workerOrigin,
      });

      try {
        await waitUntilServing({ ...server, origin: workerOrigin });
        await use({ ...server, origin: workerOrigin });
      } finally {
        await server.stop();
        await prisma.$disconnect();
        await releaseWorkerDatabases();
      }
    },
    { scope: 'worker' },
  ],
  // The same server with email and password sign-in on, for the control of criterion 3.
  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  emailServer: async ({ server: _server }, use) => {
    const server = await spawnSignServer(productionEnv(true));

    try {
      await waitUntilServing(server);
      await use(server);
    } finally {
      await server.stop();
    }
  },
});

test.describe.configure({ mode: 'parallel', timeout: 180_000 });

const MICROSOFT_BUTTON = 'Sign in with Microsoft';
const AUTHORISE_ROUTE = '**/api/auth/oauth/authorize/microsoft';
const MICROSOFT_AUTHORISE_URL = 'https://login.microsoftonline.com/e2e-tenant/oauth2/v2.0/authorize?state=e2e-state';

type Box = { positionX: unknown; positionY: unknown; width: unknown; height: unknown };

const clickFieldCentre = async (page: Page, field: Box) => {
  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
  const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

  await canvas.click({ position: { x, y } });
  await page.waitForTimeout(500);
};

/** A signed-out recipient opens the signing page, clicks the seal field and follows the dialog's Login action. */
const arriveFromTheSigningPage = async (page: Page, origin: string, token: string, sealFieldId: number) => {
  const sealField = await prisma.field.findUniqueOrThrow({ where: { id: sealFieldId } });

  await page.goto(`${origin}/sign/${token}`);
  await clickFieldCentre(page, sealField);

  await expect(
    page.getByText(SEAL_UI.signInPromptText).first(),
    'the signing page asks the recipient to sign in',
  ).toBeVisible();

  await page.getByRole('dialog').getByRole('button', { name: 'Login', exact: true }).click();
  await page.waitForURL(/\/signin\?/, { timeout: 30_000 });

  // The server renders the page before the browser reads the hash, and the form then reacts to it. Waiting for the
  // page to settle makes the assertions that follow see the page the recipient is left with, not the first paint.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
};

test('criterion_A_the_embedded_sign_in_page_offers_sign_in_with_microsoft', async ({
  signIn,
  page,
  request,
  server,
}) => {
  const { person } = await setupMemberSeal(signIn, request);

  await arriveFromTheSigningPage(page, server.origin, person.token, person.sealFieldId as number);

  const url = new URL(page.url());

  expect(url.pathname, 'the recipient is on the sign-in page').toBe('/signin');
  expect(url.searchParams.get('returnTo'), 'the sign-in page carries the signing path').toBe(`/sign/${person.token}`);
  expect(url.hash, 'the sign-in page is the embedded variant').toContain('embedded=true');

  const button = page.getByRole('button', { name: MICROSOFT_BUTTON });

  await expect(button, 'the embedded sign-in page shows "Sign in with Microsoft"').toBeVisible({ timeout: 15_000 });
  await expect(button, 'the button is enabled').toBeEnabled();
});

test('criterion_B_the_button_starts_the_microsoft_authorisation_with_the_signing_page_as_return_path', async ({
  signIn,
  page,
  request,
  server,
}) => {
  const { person } = await setupMemberSeal(signIn, request);

  const authoriseBodies: unknown[] = [];
  const microsoftNavigations: string[] = [];

  await page.route(AUTHORISE_ROUTE, async (route) => {
    authoriseBodies.push(route.request().postDataJSON());

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ redirectUrl: MICROSOFT_AUTHORISE_URL }),
    });
  });

  await page.route('https://login.microsoftonline.com/**', async (route) => {
    microsoftNavigations.push(route.request().url());

    await route.abort();
  });

  await arriveFromTheSigningPage(page, server.origin, person.token, person.sealFieldId as number);

  const button = page.getByRole('button', { name: MICROSOFT_BUTTON });

  await expect(button, 'the embedded sign-in page shows "Sign in with Microsoft"').toBeVisible({ timeout: 15_000 });

  await button.click();

  await expect
    .poll(() => microsoftNavigations, {
      message: 'the browser reaches the Microsoft authorisation URL',
      timeout: 15_000,
    })
    .toEqual([MICROSOFT_AUTHORISE_URL]);

  await expect
    .poll(() => authoriseBodies.length, {
      message: 'the click sends one request to the application to start the Microsoft authorisation',
      timeout: 15_000,
    })
    .toBe(1);

  expect(authoriseBodies[0], 'the return path is the signing page').toEqual({
    redirectPath: `${server.origin}/sign/${person.token}`,
  });
});

test('criterion_C_the_plain_sign_in_page_with_a_return_path_still_offers_sign_in_with_microsoft', async ({
  signIn,
  page,
  request,
  server,
}) => {
  const { person } = await setupMemberSeal(signIn, request);

  await page.goto(`${server.origin}/signin?returnTo=${encodeURIComponent(`/sign/${person.token}`)}`);

  const button = page.getByRole('button', { name: MICROSOFT_BUTTON });

  await expect(button, 'the plain sign-in page shows "Sign in with Microsoft"').toBeVisible({ timeout: 15_000 });
  await expect(button, 'the button is enabled').toBeEnabled();
});

test('criterion_3_with_email_and_password_sign_in_on_the_embedded_page_shows_the_form_and_no_microsoft_button', async ({
  emailServer,
  page,
}) => {
  const email = 'recipient-3@terrapay-e2e.example';

  await page.goto(
    `${emailServer.origin}/signin?returnTo=${encodeURIComponent('/sign/abc')}#embedded=true&email=${email}`,
  );
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);

  await expect(page.getByLabel('Email'), 'the email field is shown with the address from the hash').toHaveValue(email);
  await expect(page.getByLabel('Password', { exact: true }), 'the password field is shown').toBeVisible();
  await expect(
    page.getByRole('button', { name: MICROSOFT_BUTTON }),
    'the embedded page has no "Sign in with Microsoft" button',
  ).toHaveCount(0);
});
