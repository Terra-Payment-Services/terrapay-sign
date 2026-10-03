import { expect, test } from '@playwright/test';

/**
 * The contract a deployed instance offers without a session: its OpenAPI
 * documents, its crawler rules and the headers it sets on a page.
 */

test('[REMOTE] the v1 OpenAPI document is served', async ({ request }) => {
  const response = await request.get('/api/v1/openapi.json');

  expect(response.status()).toBe(200);

  const body = await response.json();

  expect(typeof body.openapi).toBe('string');
  expect(Object.keys(body.paths ?? {}).length).toBeGreaterThan(0);
});

test('[REMOTE] the v2 OpenAPI document is served', async ({ request }) => {
  const response = await request.get('/api/v2/openapi.json');

  expect(response.status()).toBe(200);

  const body = await response.json();

  expect(typeof body.openapi).toBe('string');
  expect(Object.keys(body.paths ?? {}).length).toBeGreaterThan(0);
});

test('[REMOTE] crawlers are kept away from signing links', async ({ request }) => {
  // A signing link is a bearer token in a URL. Indexing one publishes it.
  const response = await request.get('/robots.txt');

  expect(response.status()).toBe(200);

  const body = await response.text();

  expect(body).toContain('Disallow: /sign/');
  expect(body).toContain('Disallow: /d/');
  expect(body).toContain('Disallow: /embed/');
});

test('[REMOTE] a page carries its content security policy', async ({ page }) => {
  const response = await page.goto('/signin');

  const policy = response?.headers()['content-security-policy'];

  expect(policy).toBeDefined();
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'self'");
  expect(policy).toContain("'strict-dynamic'");
  // The nonce is generated per request, so the assertion is on its presence.
  expect(policy).toMatch(/'nonce-[^']+'/);
});

test('[REMOTE] the API refuses a call that carries no token', async ({ request }) => {
  // The document list is what an integrator reaches for first. A deployment
  // that answers it to a caller with no token is the worst thing this suite
  // could miss.
  const response = await request.get('/api/v2-beta/document');

  expect(response.status()).toBe(401);
});
