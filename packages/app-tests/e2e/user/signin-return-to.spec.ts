/**
 * A returnTo on the sign-in page can only lead back into the app.
 *
 * Written from the specification alone, before any fix exists.
 *
 * | Test                                                                     | Criterion |
 * | ------------------------------------------------------------------------ | --------- |
 * | C1 <value>: signing in with that returnTo leaves the browser on the app  | C1        |
 * |   and makes no request to the foreign host                               |           |
 * | C2 <value>: GET /signin and /signin.data with that returnTo hand the     | C2        |
 * |   browser no //evil.example and no \evil.example                         |           |
 * | C3: returnTo=/settings/profile, and a team documents page with its query | C3        |
 * |   string, still take the user there (control, passes before and after)   |           |
 *
 * `evil.example` is reserved and never resolves, so the tests do not wait for it to load. They watch every request
 * the page makes, abort any to that host and record it, and read the page's final URL.
 *
 * Production signs in with Microsoft; the harness server allows email and password, which takes the same returnTo
 * through the same sign-in page. The SSO callback is not driven here.
 *
 * Expected on main (red run): C2 fails for at least /.//evil.example, /%2e//evil.example and /./\evil.example, and
 * C1 fails for any value the app turns into a protocol-relative location. C3 passes.
 */
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

const FOREIGN_HOST = 'evil.example';

/** Each value is URL-encoded into /signin?returnTo= exactly once. */
const FOREIGN_RETURN_TOS = [
  '/.//evil.example',
  '/%2e//evil.example',
  '/./\\evil.example',
  '//evil.example',
  '/\\evil.example',
  '\\/evil.example',
  'https://evil.example/',
  '/%2F%2Fevil.example',
  '%2F%2Fevil.example',
  '/.%2F%2Fevil.example',
];

const isForeign = (url: URL) => url.hostname === FOREIGN_HOST || url.hostname.endsWith(`.${FOREIGN_HOST}`);

const signinPath = (returnTo: string) => `/signin?returnTo=${encodeURIComponent(returnTo)}`;

/**
 * Opens the sign-in page with the returnTo, signs in through the form and waits until the browser has left the
 * sign-in page or tried to reach the foreign host. Returns the app's origin and every foreign request the page made.
 */
const signInWithReturnTo = async (page: Page, returnTo: string) => {
  const { user } = await seedUser();
  const foreignRequests: string[] = [];

  await page.route(isForeign, async (route) => {
    foreignRequests.push(route.request().url());

    await route.abort('blockedbyclient');
  });

  page.on('request', (request) => {
    const url = new URL(request.url());

    if (isForeign(url) && !foreignRequests.includes(request.url())) {
      foreignRequests.push(request.url());
    }
  });

  await page.goto(signinPath(returnTo));

  const appOrigin = new URL(page.url()).origin;

  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect
    .poll(() => foreignRequests.length > 0 || new URL(page.url()).pathname !== '/signin', {
      message: `the sign-in with returnTo ${JSON.stringify(returnTo)} completes`,
      timeout: 30_000,
    })
    .toBe(true);

  // A redirect chain may continue after the first navigation; let it settle before reading where it ended.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1_000);

  return { appOrigin, foreignRequests };
};

for (const returnTo of FOREIGN_RETURN_TOS) {
  const label = JSON.stringify(returnTo);

  /** Guards C1: a returnTo that looks like a path on this app must not take the signed-in user to another site. */
  test(`C1 signing in with returnTo ${label} keeps the browser on the app`, async ({ page }) => {
    const { appOrigin, foreignRequests } = await signInWithReturnTo(page, returnTo);

    expect(foreignRequests, `returnTo ${label}: no request reaches ${FOREIGN_HOST}`).toEqual([]);
    expect(new URL(page.url()).origin, `returnTo ${label}: the browser ends on the app's origin`).toBe(appOrigin);
  });

  /** Guards C2: the sign-in page's response, HTML or single-fetch data, never carries the foreign location. */
  test(`C2 the sign-in page with returnTo ${label} hands the browser no foreign location`, async ({ request }) => {
    for (const path of [signinPath(returnTo), signinPath(returnTo).replace('/signin?', '/signin.data?')]) {
      const response = await request.get(path, { maxRedirects: 0 });
      const headers = JSON.stringify(response.headers());
      const body = await response.text();

      for (const [part, text] of [
        ['headers', headers],
        ['body', body],
      ]) {
        expect(text, `returnTo ${label}: ${path} ${part} contain no //${FOREIGN_HOST}`).not.toContain(
          `//${FOREIGN_HOST}`,
        );
        expect(text, `returnTo ${label}: ${path} ${part} contain no \\${FOREIGN_HOST}`).not.toContain(
          `\\${FOREIGN_HOST}`,
        );
      }
    }
  });
}

/** Guards C3: an ordinary page of the app as returnTo still takes the user there after sign-in. */
test('C3 signing in with returnTo /settings/profile lands on the profile page', async ({ page }) => {
  const { appOrigin, foreignRequests } = await signInWithReturnTo(page, '/settings/profile');

  expect(foreignRequests).toEqual([]);
  await expect(page).toHaveURL(`${appOrigin}/settings/profile`);
});

/**
 * Guards C3: a same-app returnTo keeps its query string. The app has no /documents route; documents live under the
 * team, so the returnTo is the user's own team documents page.
 */
test('C3 signing in with returnTo a documents page keeps its query string', async ({ page }) => {
  const { user, team } = await seedUser();
  const returnTo = `/t/${team.url}/documents?status=PENDING`;
  const foreignRequests: string[] = [];

  page.on('request', (request) => {
    if (isForeign(new URL(request.url()))) {
      foreignRequests.push(request.url());
    }
  });

  await page.goto(signinPath(returnTo));

  const appOrigin = new URL(page.url()).origin;

  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign In' }).click();

  await page.waitForURL((url) => url.pathname === `/t/${team.url}/documents`, { timeout: 30_000 });

  const url = new URL(page.url());

  expect(foreignRequests).toEqual([]);
  expect(url.origin).toBe(appOrigin);
  expect(url.searchParams.get('status'), 'the query string survives the sign-in').toBe('PENDING');
});
