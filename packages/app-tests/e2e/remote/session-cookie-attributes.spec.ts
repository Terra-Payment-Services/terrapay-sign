import { expect, test } from '@playwright/test';

/**
 * The deployed cookie options, read off a real response. GET only, no
 * credentials. The session cookie and the CSRF cookie share one options
 * object, so the CSRF cookie's attributes show what the session cookie
 * is issued with.
 *
 * Needs E2E_BASE_URL. Locally the server runs over http, where cookies are
 * never Secure and carry no prefix, so the check only means something against
 * a deployed https origin.
 */

const isRemote = Boolean(process.env.E2E_BASE_URL?.trim());

test.skip(!isRemote, 'needs E2E_BASE_URL, a deployed https origin');

test('[REMOTE] the CSRF cookie is SameSite=Lax, Secure and HttpOnly', async ({ request }) => {
  const response = await request.get('/api/auth/csrf');

  expect(response.status()).toBe(200);

  const setCookie = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value)
    .find((value) => value.startsWith('__Secure-csrfToken='));

  expect(setCookie, 'Set-Cookie for __Secure-csrfToken').toBeDefined();

  const attributes = (setCookie ?? '')
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());

  expect(attributes).toContain('samesite=lax');
  expect(attributes).toContain('secure');
  expect(attributes).toContain('httponly');
});
