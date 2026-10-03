import { afterEach, describe, expect, it, vi } from 'vitest';

import { getClientIpFromForwardedFor, getIpAddress, getTrustedProxyHops } from './get-ip-address';

/**
 * Sign sits behind one AWS load balancer, which appends the address it saw to
 * X-Forwarded-For. Anything to the left of that entry came from the client,
 * who can write whatever they like there. The address ends up on the signing
 * certificate and keys the per-IP rate limiters, so reading the left-most entry
 * let a client choose both.
 */

const requestWith = (headers: Record<string, string>) => new Request('https://sign.example.com/', { headers });

describe('getIpAddress', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores addresses the client put in front of the one the load balancer appended', () => {
    const req = requestWith({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' });

    expect(getIpAddress(req)).toBe('203.0.113.9');
  });

  it('returns the only entry when the client sent no header of its own', () => {
    expect(getIpAddress(requestWith({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('skips the configured number of trusted proxies from the right', () => {
    vi.stubEnv('NEXT_PRIVATE_TRUSTED_PROXY_HOPS', '2');

    const req = requestWith({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.5' });

    expect(getIpAddress(req)).toBe('203.0.113.9');
  });

  it('falls back to the left-most entry when the header is shorter than the hop count', () => {
    vi.stubEnv('NEXT_PRIVATE_TRUSTED_PROXY_HOPS', '3');

    expect(getIpAddress(requestWith({ 'x-forwarded-for': '203.0.113.9, 10.0.0.5' }))).toBe('203.0.113.9');
  });

  it('falls back to other headers when X-Forwarded-For holds nothing usable', () => {
    const req = requestWith({ 'x-forwarded-for': ' , ', 'x-real-ip': '203.0.113.9' });

    expect(getIpAddress(req)).toBe('203.0.113.9');
  });

  it('throws when no header carries an address', () => {
    expect(() => getIpAddress(requestWith({}))).toThrow();
  });
});

describe('getClientIpFromForwardedFor', () => {
  it('tolerates whitespace and empty entries', () => {
    expect(getClientIpFromForwardedFor(' 1.2.3.4 ,, 203.0.113.9 ', 1)).toBe('203.0.113.9');
  });
});

describe('getTrustedProxyHops', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, '', '0', '-1', '1.5', 'two'])('defaults to one for %s', (value) => {
    vi.stubEnv('NEXT_PRIVATE_TRUSTED_PROXY_HOPS', value);

    expect(getTrustedProxyHops()).toBe(1);
  });
});
