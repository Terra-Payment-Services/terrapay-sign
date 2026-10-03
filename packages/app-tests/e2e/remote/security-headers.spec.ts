import { expect, test } from '@playwright/test';

/**
 * Response security headers, read off real responses. GETs only, so these run
 * against a deployed origin as well as the local server.
 */

const frameAncestors = (csp: string | undefined) =>
  (csp ?? '')
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('frame-ancestors'));

test('[REMOTE] signing and sign-in pages refuse to be framed by another origin', async ({ request }) => {
  for (const path of ['/signin', '/sign/not-a-real-token', '/d/not-a-real-token', '/forgot-password']) {
    const response = await request.get(path, { maxRedirects: 0 });

    expect(frameAncestors(response.headers()['content-security-policy']), path).toBe(`frame-ancestors 'self'`);
  }
});

test('[REMOTE] embed pages can still be framed', async ({ request }) => {
  const response = await request.get('/embed/sign/not-a-real-token', { maxRedirects: 0 });

  expect(frameAncestors(response.headers()['content-security-policy'])).toBe('frame-ancestors *');
});

test('[REMOTE] pages and API responses carry HSTS', async ({ request }) => {
  for (const path of ['/signin', '/api/health']) {
    const response = await request.get(path, { maxRedirects: 0 });

    expect(response.headers()['strict-transport-security'], path).toBe('max-age=31536000; includeSubDomains');
  }
});
