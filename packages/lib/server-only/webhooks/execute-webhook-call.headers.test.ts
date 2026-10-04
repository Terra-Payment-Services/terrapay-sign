import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivers to a real loopback server through a host on the SSRF bypass list, so
 * what is asserted is the headers that arrived rather than what was passed to a
 * transport.
 */

const BYPASSED_HOST = 'hook.bypass.test';

let server: http.Server;
let port: number;
let received: http.IncomingHttpHeaders[];
let bodies: string[];

const loadModule = async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS', BYPASSED_HOST);

  return await import('./execute-webhook-call');
};

const loopback = async () => [{ address: '127.0.0.1', family: 4 }];

beforeEach(async () => {
  received = [];
  bodies = [];

  server = http.createServer((req, res) => {
    received.push(req.headers);

    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200);
      res.end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('executeWebhookCall secret headers', () => {
  it('sends the secret under the TerraPay header and the legacy Documenso header', async () => {
    const { executeWebhookCall } = await loadModule();

    const result = await executeWebhookCall({
      url: `http://${BYPASSED_HOST}:${port}/hook`,
      body: {},
      secret: 's3cret',
      resolve: loopback,
    });

    expect(result.success).toBe(true);
    expect(received[0]['x-terrapay-secret']).toBe('s3cret');
    expect(received[0]['x-documenso-secret']).toBe('s3cret');
  });

  it('sends both headers empty when the webhook has no secret', async () => {
    const { executeWebhookCall } = await loadModule();

    await executeWebhookCall({
      url: `http://${BYPASSED_HOST}:${port}/hook`,
      body: {},
      secret: null,
      resolve: loopback,
    });

    expect(received[0]['x-terrapay-secret']).toBe('');
    expect(received[0]['x-documenso-secret']).toBe('');
    expect(received[0]['x-terrapay-signature']).toBeUndefined();
    expect(received[0]['x-terrapay-timestamp']).toBeUndefined();
  });
});

describe('executeWebhookCall signature', () => {
  // Computed here the way a receiver would, not with the module's own helper,
  // so a mistake in the helper cannot agree with itself.
  const expectedSignature = (secret: string, timestamp: string, body: string) =>
    `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

  it('signs the timestamp and the exact body the receiver got', async () => {
    const { executeWebhookCall } = await loadModule();
    const before = Math.floor(Date.now() / 1000);

    await executeWebhookCall({
      url: `http://${BYPASSED_HOST}:${port}/hook`,
      body: { event: 'DOCUMENT_COMPLETED', payload: { title: 'Contrat signé' } },
      secret: 's3cret',
      resolve: loopback,
    });

    const timestamp = String(received[0]['x-terrapay-timestamp']);

    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(timestamp)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(received[0]['x-terrapay-signature']).toBe(expectedSignature('s3cret', timestamp, bodies[0]));
  });

  it('gives a signature that fails for any other secret or body', async () => {
    const { executeWebhookCall } = await loadModule();

    await executeWebhookCall({
      url: `http://${BYPASSED_HOST}:${port}/hook`,
      body: { event: 'DOCUMENT_COMPLETED' },
      secret: 's3cret',
      resolve: loopback,
    });

    const timestamp = String(received[0]['x-terrapay-timestamp']);
    const signature = received[0]['x-terrapay-signature'];

    expect(signature).not.toBe(expectedSignature('other', timestamp, bodies[0]));
    expect(signature).not.toBe(expectedSignature('s3cret', timestamp, bodies[0].replace('COMPLETED', 'REJECTED')));
  });
});
