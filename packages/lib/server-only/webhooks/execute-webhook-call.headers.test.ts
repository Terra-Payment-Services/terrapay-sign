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

const loadModule = async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS', BYPASSED_HOST);

  return await import('./execute-webhook-call');
};

const loopback = async () => [{ address: '127.0.0.1', family: 4 }];

beforeEach(async () => {
  received = [];

  server = http.createServer((req, res) => {
    received.push(req.headers);
    req.resume();
    req.on('end', () => {
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
  });
});
