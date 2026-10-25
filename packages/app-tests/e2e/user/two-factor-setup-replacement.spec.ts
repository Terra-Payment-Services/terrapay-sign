import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

import { apiSignin } from '../fixtures/authentication';

// Each use of one secret needs its own 30-second step (#197), so a test with three uses takes about a minute.
test.describe.configure({ mode: 'parallel', timeout: 180000 });

const PERIOD_MS = 30_000;

/**
 * The newest step counter handed out for each secret. The server refuses a code of a step it has already accepted
 * (#197), so a second code for the same secret waits for a later step.
 */
const lastStepBySecret = new Map<string, number>();

/**
 * TOTP for a base32 secret, computed as an authenticator app would. The server accepts only the
 * current 30-second window, so if the window is about to roll over, wait for the next one rather
 * than send a code that may expire in flight. A secret already used in the current step waits for
 * the next one.
 */
const totpFor = async (secret: string) => {
  const lastStep = lastStepBySecret.get(secret);

  if (lastStep !== undefined && Math.floor(Date.now() / PERIOD_MS) <= lastStep) {
    await new Promise((resolve) => setTimeout(resolve, PERIOD_MS - (Date.now() % PERIOD_MS) + 250));
  }

  const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);

  if (remaining < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 250));
  }

  const counter = Math.floor(Date.now() / PERIOD_MS);

  lastStepBySecret.set(secret, counter);

  return await generateHOTP(base32.decode(secret), counter);
};

/**
 * POST to a two-factor route with the signed-in page's session cookie and the app's own Origin,
 * which the auth server's same-origin check requires.
 */
const postTwoFactor = async (page: Page, route: 'setup' | 'enable' | 'disable', data?: object) =>
  await page.request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/two-factor/${route}`, {
    headers: { Origin: new URL(NEXT_PUBLIC_WEBAPP_URL()).origin },
    data: data ?? {},
  });

/**
 * Sign in with a password and optional TOTP from a fresh, cookieless context, so the result
 * depends only on what the server holds for the user and not on the test's own session.
 */
const freshSignin = async (email: string, totpCode?: string) => {
  const context: APIRequestContext = await request.newContext();

  try {
    const csrf = await context.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/csrf`);
    const { csrfToken } = await csrf.json();

    const response = await context.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/email-password/authorize`, {
      headers: { Origin: new URL(NEXT_PUBLIC_WEBAPP_URL()).origin },
      data: { email, password: 'password', csrfToken, totpCode },
    });

    const text = await response.text();

    return { status: response.status(), ok: response.ok(), text };
  } finally {
    await context.dispose();
  }
};

/**
 * Run setup and enable for the signed-in user and return the secret the authenticator holds.
 */
const setupAndEnable = async (page: Page) => {
  const setup = await postTwoFactor(page, 'setup');

  expect(setup.ok()).toBe(true);

  const { secret, uri } = await setup.json();

  expect(typeof secret).toBe('string');
  expect(typeof uri).toBe('string');

  const enable = await postTwoFactor(page, 'enable', { code: await totpFor(secret) });

  expect(enable.ok()).toBe(true);

  const { recoveryCodes } = await enable.json();

  expect(Array.isArray(recoveryCodes) && recoveryCodes.length > 0).toBe(true);

  return secret as string;
};

/**
 * Two-factor is on for the user: a password alone no longer signs in, and the server asks for
 * a second factor.
 */
const expectTwoFactorRequired = async (email: string) => {
  const signin = await freshSignin(email);

  expect(signin.ok, signin.text).toBe(false);
  expect(signin.text).toContain('TWO_FACTOR_MISSING_CREDENTIALS');
};

/**
 * C1. Guards against a session alone replacing an enabled authenticator. A second setup
 * call while 2FA is on must be refused without handing out a secret, 2FA must stay on, the
 * original authenticator must still sign in and disable, and any secret the call did return
 * must not be accepted.
 */
test('[USER] two-factor setup is refused while two-factor is enabled', async ({ page }) => {
  const { user } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: '/settings/security' });

  const originalSecret = await setupAndEnable(page);

  const second = await postTwoFactor(page, 'setup');
  const secondText = await second.text();

  let returnedSecret: unknown;

  try {
    returnedSecret = JSON.parse(secondText)?.secret;
  } catch {
    returnedSecret = undefined;
  }

  // Soft, so a run on unfixed code also shows what the state checks below find.
  expect.soft(second.status(), secondText).toBeGreaterThanOrEqual(400);
  expect.soft(second.status(), secondText).toBeLessThan(500);
  expect.soft(secondText).not.toContain('"secret"');
  expect.soft(secondText).not.toContain('"uri"');

  await expectTwoFactorRequired(user.email);

  if (typeof returnedSecret === 'string' && returnedSecret !== originalSecret) {
    const withReturned = await freshSignin(user.email, await totpFor(returnedSecret));

    expect(withReturned.ok, withReturned.text).toBe(false);
  }

  const withOriginal = await freshSignin(user.email, await totpFor(originalSecret));

  expect(withOriginal.ok, withOriginal.text).toBe(true);

  const disable = await postTwoFactor(page, 'disable', { totpCode: await totpFor(originalSecret) });

  expect(disable.ok(), await disable.text()).toBe(true);
});

/**
 * C2 (control). Guards the ordinary path the fix must keep: a user without 2FA sets it up
 * and enables it, after which sign-in needs the code and accepts it.
 */
test('[USER] a user without two-factor can set it up and enable it', async ({ page }) => {
  const { user } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: '/settings/security' });

  const secret = await setupAndEnable(page);

  await expectTwoFactorRequired(user.email);

  const withCode = await freshSignin(user.email, await totpFor(secret));

  expect(withCode.ok, withCode.text).toBe(true);
});

/**
 * C3 (control). Guards re-enrolment: once 2FA is disabled with a valid code, setup works
 * again and issues a new secret, which then enables 2FA in place of the old one.
 */
test('[USER] after disabling two-factor with a valid code, setup works again', async ({ page }) => {
  const { user } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: '/settings/security' });

  const firstSecret = await setupAndEnable(page);

  const disable = await postTwoFactor(page, 'disable', { totpCode: await totpFor(firstSecret) });

  expect(disable.ok(), await disable.text()).toBe(true);

  const withoutCode = await freshSignin(user.email);

  expect(withoutCode.ok, withoutCode.text).toBe(true);

  const secondSecret = await setupAndEnable(page);

  expect(secondSecret).not.toBe(firstSecret);

  await expectTwoFactorRequired(user.email);

  const withNew = await freshSignin(user.email, await totpFor(secondSecret));

  expect(withNew.ok, withNew.text).toBe(true);
});

/**
 * C4 (race). Guards enable switching on the authenticator it checked. Enable (with a valid
 * code for secret A) races a second setup (secret B) over many rounds. Whenever two-factor ends
 * up on, the authenticator must be A, and if enable answered 200 its recovery codes must belong
 * to it. Ending with two-factor off is allowed.
 *
 * The state is read from the security page and checked through /disable, which takes the same
 * TOTP or backup code as sign-in but is not subject to the login rate limit (50 sign-ins per 15
 * minutes per address), which a sign-in per round would exhaust. Even rounds prove the
 * authenticator with a TOTP for A, waiting for a fresh step when enable spent the current one
 * (#197); odd rounds use the backup code enable returned (or the TOTP when enable did not answer
 * 200). A round that finds a wrong authenticator leaves two-factor on,
 * so the next round starts with a fresh user.
 */
test('[USER] enable and a concurrent setup never leave two-factor on for a secret enable did not check', async ({
  page,
}) => {
  // Up to twenty TOTP rounds may each wait a full step.
  test.setTimeout(1_500_000);

  const ROUNDS = 40;
  const failures: string[] = [];
  const counts = { on: 0, off: 0, enable200: 0, setupB2xx: 0 };

  let email = '';

  for (let round = 0; round < ROUNDS; round++) {
    if (!email) {
      const { user } = await seedUser();

      email = user.email;

      await apiSignin({ page, email, redirectPath: '/settings/security' });
    }

    const setupA = await postTwoFactor(page, 'setup');

    expect(setupA.ok(), `round ${round}: setup A ${setupA.status()} ${await setupA.text()}`).toBe(true);

    const { secret: secretA } = await setupA.json();
    const code = await totpFor(secretA);

    const [enable, setupB] = await Promise.all([postTwoFactor(page, 'enable', { code }), postTwoFactor(page, 'setup')]);

    const enableText = await enable.text();
    const label = `round ${round} enable=${enable.status()} setupB=${setupB.status()}`;

    if (enable.ok()) {
      counts.enable200++;
    }

    if (setupB.ok()) {
      counts.setupB2xx++;
    }

    await page.goto(`${NEXT_PUBLIC_WEBAPP_URL()}/settings/security`);

    const toggle = page.getByRole('button', { name: /^(Enable|Disable) 2FA$/ });

    await expect(toggle).toBeVisible();

    if ((await toggle.textContent())?.includes('Enable')) {
      counts.off++;
      continue;
    }

    counts.on++;

    const recoveryCodes: string[] | undefined = enable.ok() ? JSON.parse(enableText).recoveryCodes : undefined;
    // totpFor waits for the next step when enable already spent this one for secret A.
    const useBackup = round % 2 === 1 && !!recoveryCodes?.length;

    const disable = await postTwoFactor(
      page,
      'disable',
      useBackup ? { backupCode: recoveryCodes?.[0] } : { totpCode: await totpFor(secretA) },
    );

    if (!disable.ok()) {
      failures.push(
        `${label}: two-factor is on but ${useBackup ? 'the recovery code from enable' : 'a code for secret A'} is refused: ${disable.status()} ${await disable.text()}`,
      );
      email = '';
    }
  }

  console.log(
    `C4 rounds=${ROUNDS} twoFactorOn=${counts.on} twoFactorOff=${counts.off} enable200=${counts.enable200} setupB2xx=${counts.setupB2xx} failures=${failures.length}`,
  );

  expect(failures, failures.join('\n')).toEqual([]);
});
