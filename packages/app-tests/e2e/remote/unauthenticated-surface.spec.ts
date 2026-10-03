import { expect, test } from '@playwright/test';

/**
 * What an anonymous visitor to a deployed instance sees.
 *
 * No session, no seeding, no database. Everything here is a page load and an
 * assertion on what came back.
 *
 * These specs run twice: against the server `start-server-and-test` boots on
 * every local run and merge request, and against a real origin when
 * `E2E_BASE_URL` is set. The two are not configured alike. The deployment
 * authenticates against Entra and only Entra, while the local server leaves
 * upstream's defaults in place, because the rest of this suite signs in with
 * an email and a password and would have nothing to sign in with otherwise.
 *
 * So anything that depends on which sign in methods are configured has to say
 * which target it is talking about. Asserting the deployed policy against
 * localhost is what broke pipeline 52778.
 */

const isRemote = Boolean(process.env.E2E_BASE_URL?.trim());

test.use({ storageState: { cookies: [], origins: [] } });

test('[REMOTE] the root path sends an anonymous visitor to sign in', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/signin(\?|$)/);
});

test('[REMOTE] the sign in page renders', async ({ page }) => {
  // True of both targets. Which sign in methods appear is not, so none of that
  // is asserted here.
  await page.goto('/signin');

  await expect(page).toHaveTitle('Sign In - TerraPay Sign');
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
});

test('[REMOTE] the sign in page does not offer to sign up', async ({ page }) => {
  // Accounts come from the directory, so a sign up link would only lead back
  // to the same Microsoft sign in. True of both targets: the link is gone from
  // the page, whatever sign up methods the server leaves enabled.
  await page.goto('/signin');

  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign up' })).toBeHidden();
  await expect(page.getByText("Don't have an account?")).toBeHidden();
});

test('[REMOTE] the deployment offers Microsoft and nothing else', async ({ page }) => {
  // A password and a passkey are credentials this application holds itself.
  // Neither is visible to the directory and neither can be revoked there, so
  // somebody removed from Entra would keep a way in. These absences are the
  // check on that, and they only describe the deployed configuration.
  //
  // The Microsoft button belongs here rather than above for a duller reason:
  // it renders only when a client id and secret are both set, and they are
  // empty in .env, so it is absent locally.
  test.skip(!isRemote, 'the local server keeps email and password sign in, which the rest of the suite needs');

  await page.goto('/signin');

  await expect(page.getByRole('button', { name: 'Sign in with Microsoft', exact: true })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeHidden();
  await expect(page.getByLabel('Password', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Forgot your password?' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Passkey' })).toBeHidden();
});

test('[REMOTE] the local server still offers the email and password form', async ({ page }) => {
  // The mirror of the test above. Without it the local run asserts nothing
  // about the sign in methods at all, and the form could disappear on the path
  // every other spec in this suite depends on without anything noticing.
  test.skip(isRemote, 'the deployment has no email and password form, by design');

  await page.goto('/signin');

  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible();
});

test('[REMOTE] the signed out pages carry the TerraPay wordmark', async ({ page }) => {
  await page.goto('/signin');

  // Addressed by its accessible name. An earlier version matched the first svg
  // inside <main>, which passed against a build that had no wordmark at all.
  await expect(page.getByRole('img', { name: 'TerraPay' })).toBeVisible();
});

test('[REMOTE] an authenticated area is closed to an anonymous visitor', async ({ page }) => {
  await page.goto('/inbox');

  await expect(page).toHaveURL(/\/signin(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
});

test('[REMOTE] the password reset page renders', async ({ page }) => {
  await page.goto('/forgot-password');

  await expect(page.getByLabel('Email')).toBeVisible();
});

test('[REMOTE] the electronic signature disclosure is published', async ({ page }) => {
  // Signers are pointed at this page from the signing flow, so it has to be
  // readable without an account.
  await page.goto('/articles/signature-disclosure');

  await expect(page.getByRole('heading', { name: 'Electronic Signature Disclosure' })).toBeVisible();
});

test('[REMOTE] the assets the page asks for all load', async ({ page }) => {
  // A build that boots and serves HTML can still be missing its client bundle
  // or its fonts, which leaves a page that renders and does nothing. The
  // status codes say so where the rendered text does not.
  const failures: string[] = [];

  page.on('response', (response) => {
    if (response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('/signin');
  await page.waitForLoadState('networkidle');

  expect(failures).toEqual([]);
});
