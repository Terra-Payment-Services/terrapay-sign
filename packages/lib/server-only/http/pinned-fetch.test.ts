import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { pinnedFetch } from './pinned-fetch';

type Seen = { host: string | undefined; method: string | undefined; contentLength: string | undefined; body: string };

const servers: Server[] = [];

/** Starts a server on loopback and records every request it is sent. */
const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const seen: Seen[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        host: request.headers.host,
        method: request.method,
        contentLength: request.headers['content-length'],
        body: Buffer.concat(chunks).toString(),
      });

      handler(request, response);
    });
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return { port: (server.address() as AddressInfo).port, seen };
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('pinnedFetch', () => {
  it('connects to the pinned address even though the name does not resolve', async () => {
    // `.invalid` is reserved never to resolve, so reaching the server at all
    // means the connection used the pinned address and not DNS.
    const { port, seen } = await listen((_request, response) => response.end('hello'));

    const response = await pinnedFetch(`http://nowhere.invalid:${port}/path?q=1`, { method: 'GET' }, ['127.0.0.1']);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(seen).toEqual([{ host: `nowhere.invalid:${port}`, method: 'GET', contentLength: undefined, body: '' }]);
  });

  it('refuses a request with no vetted address', async () => {
    const { port, seen } = await listen((_request, response) => response.end('hello'));

    await expect(pinnedFetch(`http://nowhere.invalid:${port}/`, { method: 'GET' }, [])).rejects.toThrow(
      /at least one address/,
    );

    expect(seen).toHaveLength(0);
  });

  it('sends a byte body with its length rather than chunked', async () => {
    const { port, seen } = await listen((_request, response) => response.end());

    await pinnedFetch(
      `http://ocsp.invalid:${port}/`,
      { method: 'POST', headers: { 'content-type': 'application/ocsp-request' }, body: new Uint8Array([1, 2, 3]) },
      ['127.0.0.1'],
    );

    expect(seen[0]).toMatchObject({ method: 'POST', contentLength: '3', body: '\u0001\u0002\u0003' });
  });

  it('hands back a redirect without following it', async () => {
    const { port, seen } = await listen((_request, response) => {
      response.writeHead(302, { location: '/elsewhere' });
      response.end();
    });

    const response = await pinnedFetch(`http://nowhere.invalid:${port}/`, { method: 'GET' }, ['127.0.0.1']);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/elsewhere');
    expect(seen).toHaveLength(1);
  });

  it('answers a 204 without a body', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    const response = await pinnedFetch(`http://nowhere.invalid:${port}/`, { method: 'GET' }, ['127.0.0.1']);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('aborts with an AbortError while waiting for headers', async () => {
    const { port } = await listen(() => undefined);

    await expect(
      pinnedFetch(`http://nowhere.invalid:${port}/`, { method: 'GET', signal: AbortSignal.timeout(50) }, ['127.0.0.1']),
    ).rejects.toMatchObject({ name: expect.stringMatching(/AbortError|TimeoutError/) });
  });

  it('aborts the body read with an AbortError when the signal fires mid-stream', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200);
      response.write('partial');
    });

    const controller = new AbortController();

    const response = await pinnedFetch(
      `http://nowhere.invalid:${port}/`,
      { method: 'GET', signal: controller.signal },
      ['127.0.0.1'],
    );

    setTimeout(() => controller.abort(), 20);

    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
