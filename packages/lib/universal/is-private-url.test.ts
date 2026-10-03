import { describe, expect, it } from 'vitest';

import { isPrivateUrl } from './is-private-url';

describe('isPrivateUrl', () => {
  describe('ranges this check used to call public', () => {
    // Each of these was accepted before the predicate moved onto the shared
    // one. The first is the one that matters most here: AWS hands out
    // 100.64.0.0/10, so a webhook aimed into it reaches somebody else's
    // workload rather than the internet.
    it.each([
      ['carrier grade NAT', '100.64.1.1'],
      ['benchmarking', '198.18.0.1'],
      ['TEST-NET-1', '192.0.2.1'],
      ['multicast', '224.0.0.1'],
      ['reserved', '240.0.0.1'],
      ['0.0.0.0/8', '0.1.2.3'],
    ])('refuses %s at %s', (_name, address) => {
      expect(isPrivateUrl(`http://${address}`)).toBe(true);
    });
  });

  describe('localhost', () => {
    it('should detect localhost', () => {
      expect(isPrivateUrl('http://localhost')).toBe(true);
      expect(isPrivateUrl('http://localhost:3000')).toBe(true);
      expect(isPrivateUrl('https://localhost/path')).toBe(true);
    });

    it('should detect localhost with trailing dot', () => {
      expect(isPrivateUrl('http://localhost.')).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(isPrivateUrl('http://LOCALHOST')).toBe(true);
      expect(isPrivateUrl('http://Localhost:8080')).toBe(true);
    });
  });

  describe('IPv4 loopback', () => {
    it('should detect 127.0.0.1', () => {
      expect(isPrivateUrl('http://127.0.0.1')).toBe(true);
      expect(isPrivateUrl('http://127.0.0.1:8080')).toBe(true);
    });

    it('should detect the full 127.x.x.x range', () => {
      expect(isPrivateUrl('http://127.0.0.2')).toBe(true);
      expect(isPrivateUrl('http://127.255.255.255')).toBe(true);
    });
  });

  describe('IPv4 private ranges', () => {
    it('should detect 10.x.x.x', () => {
      expect(isPrivateUrl('http://10.0.0.1')).toBe(true);
      expect(isPrivateUrl('http://10.255.255.255')).toBe(true);
    });

    it('should detect 172.16.0.0/12', () => {
      expect(isPrivateUrl('http://172.16.0.1')).toBe(true);
      expect(isPrivateUrl('http://172.31.255.255')).toBe(true);
    });

    it('should not flag 172.x outside the /12 range', () => {
      expect(isPrivateUrl('http://172.15.0.1')).toBe(false);
      expect(isPrivateUrl('http://172.32.0.1')).toBe(false);
    });

    it('should detect 192.168.x.x', () => {
      expect(isPrivateUrl('http://192.168.0.1')).toBe(true);
      expect(isPrivateUrl('http://192.168.255.255')).toBe(true);
    });

    it('should detect link-local 169.254.x.x', () => {
      expect(isPrivateUrl('http://169.254.1.1')).toBe(true);
    });

    it('should detect 0.0.0.0', () => {
      expect(isPrivateUrl('http://0.0.0.0')).toBe(true);
    });
  });

  describe('IPv6', () => {
    it('should detect ::1 loopback', () => {
      expect(isPrivateUrl('http://[::1]')).toBe(true);
      expect(isPrivateUrl('http://[::1]:3000')).toBe(true);
    });

    it('should detect :: unspecified', () => {
      expect(isPrivateUrl('http://[::]')).toBe(true);
    });

    it('should detect link-local fe80:', () => {
      expect(isPrivateUrl('http://[fe80::1]')).toBe(true);
    });

    it('should detect unique local fc/fd', () => {
      expect(isPrivateUrl('http://[fc00::1]')).toBe(true);
      expect(isPrivateUrl('http://[fd12::1]')).toBe(true);
    });

    it('should detect private IPv4-mapped IPv6 addresses (URL parser normalizes to hex)', () => {
      // new URL() normalizes "::ffff:127.0.0.1" to the hex form "::ffff:7f00:1",
      // so the embedded IPv4 must be decoded and re-checked. Otherwise a literal
      // host such as http://[::ffff:127.0.0.1] bypasses every dotted-decimal
      // check above (SSRF, see #2901).
      expect(isPrivateUrl('http://[::ffff:127.0.0.1]')).toBe(true);
      expect(isPrivateUrl('http://[::ffff:10.0.0.1]')).toBe(true);
      expect(isPrivateUrl('http://[::ffff:192.168.0.1]')).toBe(true);
      expect(isPrivateUrl('http://[::ffff:169.254.169.254]')).toBe(true);
    });

    it('should still allow public IPv4-mapped IPv6 addresses', () => {
      expect(isPrivateUrl('http://[::ffff:8.8.8.8]')).toBe(false);
      expect(isPrivateUrl('http://[::ffff:1.1.1.1]')).toBe(false);
    });
  });

  describe('public URLs', () => {
    it('should allow public hostnames', () => {
      expect(isPrivateUrl('https://example.com')).toBe(false);
      expect(isPrivateUrl('https://api.documenso.com/webhook')).toBe(false);
    });

    // 203.0.113.1 used to stand in for a public address here. It is TEST-NET-3,
    // which RFC 5737 reserves for documentation and which must never appear on
    // the public internet, so refusing it is right and the example was wrong.
    it('should allow public IP addresses', () => {
      expect(isPrivateUrl('http://8.8.8.8')).toBe(false);
      expect(isPrivateUrl('http://1.1.1.1')).toBe(false);
      expect(isPrivateUrl('http://93.184.216.34')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return false for invalid URLs', () => {
      expect(isPrivateUrl('not-a-url')).toBe(false);
      expect(isPrivateUrl('')).toBe(false);
    });
  });
});
