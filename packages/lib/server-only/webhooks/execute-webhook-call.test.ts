import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TWebhookResolver } from './execute-webhook-call';

/**
 * These deliver to a real HTTP server on loopback and replace only DNS, so
 * what is asserted is where the bytes went rather than which function was
 * called. Loopback is exactly what the guard refuses, which is the point: the
 * refusal tests prove nothing reached it, and the delivery tests reach it only
 * through a host on the SSRF bypass list.
 */

const BYPASSED_HOST = 'hook.bypass.test';

type TReceived = {
  method?: string;
  host?: string;
  secret?: string;
  body: string;
};

let server: http.Server;
let port: number;
let received: TReceived[];
let respond: (res: http.ServerResponse) => void;

const loadModule = async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS', BYPASSED_HOST);

  return await import('./execute-webhook-call');
};

const resolverReturning =
  (...answers: string[][]): TWebhookResolver =>
  async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0];

    return (next ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

beforeEach(async () => {
  received = [];
  respond = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  };

  server = http.createServer((req, res) => {
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      received.push({
        method: req.method,
        host: req.headers.host,
        secret: req.headers['x-documenso-secret'] as string | undefined,
        body,
      });

      respond(res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.unstubAllEnvs();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('executeWebhookCall', () => {
  it('refuses a host that resolves to loopback, and nothing is delivered', async () => {
    const { executeWebhookCall } = await loadModule();

    const result = await executeWebhookCall({
      url: `http://evil.example.com:${port}/hook`,
      body: { event: 'x' },
      secret: 's',
      resolve: resolverReturning(['127.0.0.1']),
    });

    expect(result.success).toBe(false);
    expect(result.responseCode).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('refuses a host that rebinds to loopback between the check and the connection', async () => {
    const { executeWebhookCall } = await loadModule();

    // First answer satisfies the URL check, second is what the socket would use.
    const resolve = vi.fn(resolverReturning(['93.184.216.34'], ['127.0.0.1']));

    const result = await executeWebhookCall({
      url: `http://rebind.example.com:${port}/hook`,
      body: { event: 'x' },
      secret: 's',
      resolve,
    });

    expect(result.success).toBe(false);
    expect(String(result.responseBody)).toContain('not publicly routable');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(0);
  });

  it('refuses when DNS fails, rather than delivering anyway', async () => {
    const { executeWebhookCall } = await loadModule();

    const result = await executeWebhookCall({
      url: `http://broken.example.com:${port}/hook`,
      body: {},
      secret: null,
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });

    expect(result.success).toBe(false);
    expect(received).toHaveLength(0);
  });

  it.each([
    ['ECS task metadata', '169.254.170.2'],
    ['EC2 instance metadata', '169.254.169.254'],
    ['unique local IPv6', 'fd00::1'],
    ['IPv4 mapped IPv6 loopback', '::ffff:127.0.0.1'],
    ['link local IPv6', 'fe80::1'],
    ['RFC 1918', '10.1.2.3'],
  ])('refuses a host resolving to %s', async (_label, address) => {
    const { executeWebhookCall } = await loadModule();

    const result = await executeWebhookCall({
      url: `http://inner.example.com:${port}/hook`,
      body: {},
      secret: null,
      resolve: resolverReturning([address]),
    });

    expect(result.success).toBe(false);
    expect(received).toHaveLength(0);
  });

  it('delivers to an allowed host with the hostname as Host, and stores the JSON reply', async () => {
    const { executeWebhookCall } = await loadModule();

    const result = await executeWebhookCall({
      url: `http://${BYPASSED_HOST}:${port}/hook`,
      body: { event: 'DOCUMENT_SIGNED' },
      secret: 'shh',
      resolve: resolverReturning(['127.0.0.1']),
    });

    expect(result).toMatchObject({ success: true, responseCode: 200, responseBody: { ok: true } });
    expect(received).toEqual([
      {
        method: 'POST',
        host: `${BYPASSED_HOST}:${port}`,
        secret: 'shh',
        body: JSON.stringify({ event: 'DOCUMENT_SIGNED' }),
      },
    ]);
  });

  it('keeps only the first 4 KB of a large reply and marks it as cut', async () => {
    const { executeWebhookCall, WEBHOOK_RESPONSE_BODY_MAX_BYTES, WEBHOOK_RESPONSE_TRUNCATION_MARKER } =
      await loadModule();

    respond = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('a'.repeat(1024 * 1024));
    };

    const result = await executeWebhookCall({
      url: `http://${BYPASSED_HOST}:${port}/hook`,
      body: {},
      secret: null,
      resolve: resolverReturning(['127.0.0.1']),
    });

    expect(result.success).toBe(true);
    expect(result.responseBody).toBe('a'.repeat(WEBHOOK_RESPONSE_BODY_MAX_BYTES) + WEBHOOK_RESPONSE_TRUNCATION_MARKER);
  });

  it('does not follow a redirect, and records it as a failed delivery', async () => {
    const { executeWebhookCall } = await loadModule();

    respond = (res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    };

    const result = await executeWebhookCall({
      url: `http://${BYPASSED_HOST}:${port}/hook`,
      body: {},
      secret: null,
      resolve: resolverReturning(['127.0.0.1']),
    });

    expect(result).toMatchObject({ success: false, responseCode: 302 });
    expect(received).toHaveLength(1);
  });
});
