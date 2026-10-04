import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type GuardedFetchOptions, guardedFetch } from './guarded-fetch';

class TestFetchError extends Error {}

const PUBLIC = '198.51.101.10';
const OTHER_PUBLIC = '198.51.101.11';

const context = {
  subject: 'test',
  createError: (message: string) => new TestFetchError(message),
  isOwnError: (error: unknown) => error instanceof TestFetchError,
  allowedProtocols: ['http:', 'https:'] as const,
};

const fetchThrough = async (overrides: Partial<GuardedFetchOptions>) =>
  await guardedFetch({
    url: 'http://responder.example.test/',
    method: 'GET',
    headers: {},
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
    lookup: async () => [PUBLIC],
    ...context,
    ...overrides,
  });

/** Answers each lookup with the next address in turn, then the last one forever. */
const lookupAnswering = (...answers: string[]) => {
  let call = 0;

  return vi.fn(async (_hostname: string) => [answers[Math.min(call++, answers.length - 1)]]);
};

const ok = (text: string) => new Response(text, { status: 200 });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('guardedFetch and DNS rebinding', () => {
  it('sends the request to the address it checked, not to what a second lookup would say', async () => {
    // A rebinding resolver answers the check with a public address and the
    // connection with loopback. The transport is given the checked address
    // and the resolver is never asked a second time.
    const lookup = lookupAnswering(PUBLIC, '127.0.0.1');
    const transport = vi.fn(async () => ok('fine'));

    await expect(fetchThrough({ lookup, fetchFn: transport })).resolves.toEqual(new TextEncoder().encode('fine'));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toEqual(['http://responder.example.test/', expect.any(Object), [PUBLIC]]);
  });

  it('refuses a same-host redirect once the host has started resolving somewhere private', async () => {
    const lookup = lookupAnswering(PUBLIC, '169.254.169.254');
    const transport = vi.fn(async () => redirect('/next'));

    await expect(fetchThrough({ lookup, fetchFn: transport })).rejects.toThrow(
      /169\.254\.169\.254, which is not publicly routable/,
    );

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('pins each redirect hop to the address checked for that hop', async () => {
    const lookup = lookupAnswering(PUBLIC, OTHER_PUBLIC);
    const transport = vi.fn().mockResolvedValueOnce(redirect('/next')).mockResolvedValueOnce(ok('second'));

    await expect(fetchThrough({ lookup, fetchFn: transport })).resolves.toEqual(new TextEncoder().encode('second'));

    expect(transport.mock.calls.map((call) => call[2])).toEqual([[PUBLIC], [OTHER_PUBLIC]]);
  });

  it('connects through the pinned transport when no transport is given', async () => {
    // The local address rule is relaxed so a loopback server can stand in for
    // the remote one. `.invalid` never resolves, so the request lands only if
    // the default transport connected to the address the lookup returned.
    const server = createServer((_request, response) => response.end('from the pinned address'));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const body = await fetchThrough({
      url: `http://rebind.invalid:${port}/`,
      lookup: async () => ['127.0.0.1'],
      allowLocalAddresses: true,
    });

    expect(new TextDecoder().decode(body)).toBe('from the pinned address');
  });

  it('still refuses a host that resolves private before connecting anywhere', async () => {
    const transport = vi.fn(async () => ok('never'));

    await expect(fetchThrough({ lookup: async () => ['10.0.0.5'], fetchFn: transport })).rejects.toThrow(
      /not publicly routable/,
    );

    expect(transport).not.toHaveBeenCalled();
  });
});

/**
 * A loopback server whose handler decides per path, and which reports when the
 * socket that carried a given path closes.
 */
const listenTracking = async (handler: (path: string, response: import('node:http').ServerResponse) => void) => {
  const closed = new Map<string, Promise<void>>();

  const server = createServer((request, response) => {
    const path = request.url ?? '/';

    closed.set(path, new Promise((resolve) => request.socket.once('close', () => resolve())));
    handler(path, response);
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  /** Resolves true when the socket closes, false if it is still open after `ms`. */
  const socketClosesWithin = async (path: string, ms: number) =>
    await Promise.race([
      (closed.get(path) ?? Promise.reject(new Error(`no request for ${path}`))).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  return { url: `http://responder.invalid:${port}`, socketClosesWithin };
};

const fetchLocal = async (url: string, overrides: Partial<GuardedFetchOptions> = {}) =>
  await fetchThrough({ url, lookup: async () => ['127.0.0.1'], allowLocalAddresses: true, ...overrides });

describe('guardedFetch leaves no socket open behind it', () => {
  it('closes the socket of a redirect whose body never ends', async () => {
    const { url, socketClosesWithin } = await listenTracking((path, response) => {
      if (path === '/') {
        response.writeHead(302, { location: '/next' });
        response.write('a redirect body that never finishes');
        return;
      }

      response.end('second hop');
    });

    await expect(fetchLocal(`${url}/`)).resolves.toEqual(new TextEncoder().encode('second hop'));

    expect(await socketClosesWithin('/', 500)).toBe(true);
  });

  it('closes the socket of an error status whose body never ends', async () => {
    const { url, socketClosesWithin } = await listenTracking((_path, response) => {
      response.writeHead(503);
      response.write('an error body that never finishes');
    });

    await expect(fetchLocal(`${url}/`)).rejects.toThrow(/HTTP 503/);

    expect(await socketClosesWithin('/', 500)).toBe(true);
  });

  it('closes the socket of a body that declares a length over the cap', async () => {
    const { url, socketClosesWithin } = await listenTracking((_path, response) => {
      response.writeHead(200, { 'content-length': '999999' });
      response.write('the start of a body far over the cap');
    });

    await expect(fetchLocal(`${url}/`, { maxResponseBytes: 32 })).rejects.toThrow(/over the 32 byte cap/);

    expect(await socketClosesWithin('/', 500)).toBe(true);
  });
});

describe('guardedFetch and a resolver that never answers', () => {
  it('times out within the wall clock budget instead of waiting on DNS', async () => {
    const transport = vi.fn(async () => ok('never'));
    const started = Date.now();

    await expect(
      fetchThrough({ lookup: () => new Promise<string[]>(() => undefined), fetchFn: transport, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out after 50ms/);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(transport).not.toHaveBeenCalled();
  });
});
