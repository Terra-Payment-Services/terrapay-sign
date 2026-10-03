import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const OWN_ORIGIN = new URL(WEBAPP_BASE_URL).origin;
const OTHER_ORIGIN = 'https://attacker.example.net';

/**
 * The session cookie is SameSite=None, so a page on any site could post to
 * tRPC or the auth routes with a signed-in user's session attached. Those
 * routes now refuse a state-changing request from another origin. The public
 * API is called from other sites with tokens and must stay open to them.
 */
test.describe('[CSRF]: cross-origin requests', () => {
  test('tRPC refuses a mutation from another origin and accepts one from ours', async ({ page }) => {
    const { user } = await seedUser();

    await apiSignin({ page, email: user.email });

    const mutate = async (origin: string) =>
      await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/profile.updateProfile`, {
        headers: { 'content-type': 'application/json', origin },
        data: JSON.stringify({ json: { name: 'Renamed', signature: '' } }),
      });

    expect((await mutate(OTHER_ORIGIN)).status()).toBe(403);
    expect((await mutate(OWN_ORIGIN)).status()).not.toBe(403);
  });

  test('the auth routes refuse a sign-out from another origin', async ({ page }) => {
    const { user } = await seedUser();

    await apiSignin({ page, email: user.email });

    const res = await page.context().request.post(`${WEBAPP_BASE_URL}/api/auth/signout`, {
      headers: { origin: OTHER_ORIGIN },
    });

    expect(res.status()).toBe(403);
  });

  test('the token-authenticated v2 API is not subject to the origin check', async ({ request }) => {
    const { user, team } = await seedUser();
    const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'csrf', expiresIn: null });

    // The body is deliberately incomplete; the API itself answers it, so any
    // status other than the guard's 403 shows the request got through.
    const res = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/document/create`, {
      headers: { Authorization: `Bearer ${token}`, origin: OTHER_ORIGIN, 'content-type': 'application/json' },
      data: JSON.stringify({}),
    });

    expect(res.status()).not.toBe(403);
  });

  test('the v2 API refuses a cookie-authenticated call from another origin', async ({ page }) => {
    const { user } = await seedUser();

    await apiSignin({ page, email: user.email });

    // No Authorization header, so the v2 API would fall back to the session cookie.
    const res = await page.context().request.post(`${WEBAPP_BASE_URL}/api/v2-beta/document/create`, {
      headers: { origin: OTHER_ORIGIN, 'content-type': 'application/json' },
      data: JSON.stringify({}),
    });

    expect(res.status()).toBe(403);
  });

  test('React Router actions refuse a request from another origin', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/locale`, {
      headers: { origin: OTHER_ORIGIN },
      form: { lang: 'en' },
    });

    expect(res.status()).toBe(403);
  });
});
