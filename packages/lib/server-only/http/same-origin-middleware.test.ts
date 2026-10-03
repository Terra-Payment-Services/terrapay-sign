import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createSameOriginMiddleware } from './same-origin-middleware';

/**
 * The session cookie is SameSite=None, so a page on any site could post to
 * the tRPC endpoint with the signed-in user's session attached. These cases
 * drive the guard through a real Hono app, as the server mounts it.
 */

const app = new Hono();

app.use(
  '/api/trpc/*',
  createSameOriginMiddleware(() => 'https://sign.example.com/ESign'),
);
app.all('/api/trpc/*', (c) => c.text('handled'));

const send = async (method: string, headers: Record<string, string> = {}) =>
  await app.request('/api/trpc/team.update', { method, headers });

describe('createSameOriginMiddleware', () => {
  it('lets a POST from our own origin through', async () => {
    const res = await send('POST', { origin: 'https://sign.example.com' });

    expect(res.status).toBe(200);
  });

  it('rejects a POST from another origin', async () => {
    const res = await send('POST', { origin: 'https://evil.example.net' });

    expect(res.status).toBe(403);
  });

  it('rejects a POST whose origin is null', async () => {
    const res = await send('POST', { origin: 'null' });

    expect(res.status).toBe(403);
  });

  it('rejects a lookalike origin that only shares a prefix', async () => {
    const res = await send('POST', { origin: 'https://sign.example.com.evil.example.net' });

    expect(res.status).toBe(403);
  });

  it('falls back to Referer when Origin is absent', async () => {
    expect((await send('POST', { referer: 'https://sign.example.com/ESign/sign/abc' })).status).toBe(200);
    expect((await send('POST', { referer: 'https://evil.example.net/page' })).status).toBe(403);
  });

  it('lets a request with neither header through, since no browser page sent it', async () => {
    const res = await send('POST');

    expect(res.status).toBe(200);
  });

  it('does not judge GET or HEAD requests', async () => {
    expect((await send('GET', { origin: 'https://evil.example.net' })).status).toBe(200);
    expect((await send('HEAD', { origin: 'https://evil.example.net' })).status).toBe(200);
  });
});

describe('createSameOriginMiddleware with exemptions', () => {
  const exemptApp = new Hono();

  exemptApp.use(
    '*',
    createSameOriginMiddleware(() => 'https://sign.example.com', {
      isExempt: (c) => c.req.path.startsWith('/api/v1/'),
    }),
  );
  exemptApp.all('*', (c) => c.text('handled'));

  it('lets an exempt path through from another origin', async () => {
    const res = await exemptApp.request('/api/v1/documents', {
      method: 'POST',
      headers: { origin: 'https://partner.example.net' },
    });

    expect(res.status).toBe(200);
  });

  it('still guards every other path', async () => {
    const res = await exemptApp.request('/api/theme', {
      method: 'POST',
      headers: { origin: 'https://partner.example.net' },
    });

    expect(res.status).toBe(403);
  });
});
