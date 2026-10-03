import { describe, expect, it, vi } from 'vitest';

import { RevocationFetchError } from './errors';
import { guardedFetch, isPubliclyRoutableAddress } from './safe-fetch';
import { fixedLookup, publicLookup } from './test-support';

const PUBLIC_URL = 'http://ocsp.example.test/';

const bodyOf = (length: number) => new Uint8Array(length).fill(0x41);

const respondWith = (body: Uint8Array, init: ResponseInit = {}) =>
  vi.fn(async () => new Response(body.slice() as unknown as BodyInit, { status: 200, ...init }));

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

const fetchOnce = async (fetchFn: typeof fetch, overrides: Partial<Parameters<typeof guardedFetch>[0]> = {}) =>
  await guardedFetch({
    url: PUBLIC_URL,
    method: 'GET',
    headers: {},
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
    fetchFn,
    lookup: publicLookup,
    ...overrides,
  });

describe('isPubliclyRoutableAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])('refuses %s', (address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '198.51.101.10', '2606:4700:4700::1111'])('allows %s', (address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(true);
  });

  it('refuses anything that is not an address', () => {
    expect(isPubliclyRoutableAddress('not-an-address')).toBe(false);
  });
});

describe('guardedFetch', () => {
  describe('the URL itself', () => {
    it.each([
      'ftp://ocsp.example.test/',
      'file:///etc/passwd',
      'gopher://ocsp.example.test/',
    ])('refuses the %s scheme', async (url) => {
      const fetchFn = respondWith(bodyOf(4));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch, { url })).rejects.toThrow(RevocationFetchError);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('allows plain http, which is how OCSP and CRL endpoints are published', async () => {
      const fetchFn = respondWith(bodyOf(4));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch)).resolves.toEqual(bodyOf(4));
    });

    it('refuses a host that resolves into a private range', async () => {
      const fetchFn = respondWith(bodyOf(4));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch, { lookup: fixedLookup('10.0.0.5') })).rejects.toThrow(
        /not publicly routable/,
      );

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('refuses a host that resolves to the cloud metadata address', async () => {
      const fetchFn = respondWith(bodyOf(4));

      await expect(
        fetchOnce(fetchFn as unknown as typeof fetch, { lookup: fixedLookup('169.254.169.254') }),
      ).rejects.toThrow(/169\.254\.169\.254/);

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('refuses a loopback literal without consulting DNS', async () => {
      const fetchFn = respondWith(bodyOf(4));

      const lookup = vi.fn(async () => ['198.51.101.10']);

      await expect(
        fetchOnce(fetchFn as unknown as typeof fetch, { url: 'http://127.0.0.1:8080/ocsp', lookup }),
      ).rejects.toThrow(/not publicly routable/);

      expect(lookup).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('refuses a host that does not resolve', async () => {
      const fetchFn = respondWith(bodyOf(4));

      const lookup = () => Promise.reject(new Error('ENOTFOUND'));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch, { lookup })).rejects.toThrow(/Could not resolve/);
    });
  });

  describe('redirects', () => {
    it('follows a redirect to the same host', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/second' } }))
        .mockResolvedValueOnce(new Response(bodyOf(8).slice() as unknown as BodyInit, { status: 200 }));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch)).resolves.toEqual(bodyOf(8));
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('refuses a redirect to another host', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://evil.example.test/' } }));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch)).rejects.toThrow(/cross-host redirects/);
    });

    it('refuses a redirect that downgrades https to http', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: 'http://ocsp.example.test/plain' } }),
        );

      await expect(
        fetchOnce(fetchFn as unknown as typeof fetch, { url: 'https://ocsp.example.test/' }),
      ).rejects.toThrow(/redirect from https/);
    });

    it('gives up rather than following a redirect loop', async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/again' } }));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch)).rejects.toThrow(/redirected more than/);
    });
  });

  describe('the response', () => {
    it('refuses a body that declares a length over the cap', async () => {
      const fetchFn = respondWith(bodyOf(64), { headers: { 'content-length': '99999' } });

      await expect(fetchOnce(fetchFn as unknown as typeof fetch, { maxResponseBytes: 32 })).rejects.toThrow(
        /over the 32 byte cap/,
      );
    });

    it('refuses a body that streams past the cap without declaring a length', async () => {
      const fetchFn = vi.fn(async () => new Response(streamOf([bodyOf(16), bodyOf(16), bodyOf(16)]), { status: 200 }));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch, { maxResponseBytes: 32 })).rejects.toThrow(
        /exceeds the 32 byte cap/,
      );
    });

    it('accepts a body exactly at the cap', async () => {
      const fetchFn = respondWith(bodyOf(32));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch, { maxResponseBytes: 32 })).resolves.toHaveLength(32);
    });

    it('refuses a non-2xx status', async () => {
      const fetchFn = vi.fn(async () => new Response('nope', { status: 503 }));

      await expect(fetchOnce(fetchFn as unknown as typeof fetch)).rejects.toThrow(/HTTP 503/);
    });

    it('gives up on a responder that never answers', async () => {
      const fetchFn = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );

      await expect(fetchOnce(fetchFn as unknown as typeof fetch, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    });
  });
});

describe('IPv4 addresses hiding inside IPv6', () => {
  // Node's URL canonicalises `http://[::ffff:127.0.0.1]/` to the hostname
  // `::ffff:7f00:1`. Matching only the dotted spelling meant loopback and the
  // instance metadata service both came back publicly routable, so a
  // certificate could name either as its OCSP responder and be believed.
  it.each([
    ['::ffff:7f00:1', '127.0.0.1 in hex'],
    ['::ffff:a9fe:a9fe', 'the instance metadata service'],
    ['::ffff:c0a8:1', 'a private 192.168 address'],
    ['::ffff:a00:1', 'a private 10.x address'],
  ])('blocks %s, which is %s', (address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(false);
  });

  it('still allows a mapped public address', () => {
    expect(isPubliclyRoutableAddress('::ffff:808:808')).toBe(true);
    expect(isPubliclyRoutableAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('agrees with itself across both spellings', () => {
    for (const [dotted, hex] of [
      ['::ffff:127.0.0.1', '::ffff:7f00:1'],
      ['::ffff:169.254.169.254', '::ffff:a9fe:a9fe'],
      ['::ffff:8.8.8.8', '::ffff:808:808'],
    ]) {
      expect(isPubliclyRoutableAddress(dotted)).toBe(isPubliclyRoutableAddress(hex));
    }
  });
});
