import { describe, expect, it } from 'vitest';

import { assertIdTokenClaims } from './id-token-claims';

const TENANT = '00000000-0000-0000-0000-000000000001';
const AUDIENCE = '00000000-0000-0000-0000-000000000002';
const now = new Date('2026-09-15T12:00:00Z');
const seconds = Math.floor(now.getTime() / 1000);

const claims = (overrides: Record<string, unknown> = {}) => ({
  aud: AUDIENCE,
  tid: TENANT,
  sub: 'a-stable-subject',
  exp: seconds + 3600,
  iat: seconds - 60,
  ...overrides,
});

const check = (over: Record<string, unknown> = {}, tenantId: string | null = TENANT) =>
  assertIdTokenClaims(claims(over), { audience: AUDIENCE, tenantId, now });

describe('assertIdTokenClaims', () => {
  it('accepts a token issued for this application by this directory', () => {
    expect(() => check()).not.toThrow();
  });

  it('accepts an audience array that contains us', () => {
    expect(() => check({ aud: ['someone-else', AUDIENCE] })).not.toThrow();
  });

  it('refuses a token issued for another application', () => {
    // A real token from the same authority, for a different client. It says
    // nothing about anyone signing in to this one.
    expect(() => check({ aud: 'another-application' })).toThrow(/different application/);
  });

  it('refuses a token from another directory', () => {
    // Pinning the tenant in the discovery URL decides where we send people.
    // It does not decide where the answer comes back from.
    expect(() => check({ tid: '11111111-2222-3333-4444-555555555555' })).toThrow(/different directory/);
  });

  it('ignores the directory when no tenant is expected', () => {
    expect(() => check({ tid: 'anything' }, null)).not.toThrow();
  });

  it('refuses an expired token', () => {
    expect(() => check({ exp: seconds - 3600 })).toThrow(/expired/);
  });

  it('refuses a token with no expiry at all', () => {
    expect(() => check({ exp: undefined })).toThrow(/no expiry/);
  });

  it('refuses a token that is not valid yet', () => {
    expect(() => check({ nbf: seconds + 3600 })).toThrow(/not valid yet/);
  });

  it('allows ordinary clock skew in both directions', () => {
    expect(() => check({ exp: seconds - 100 })).not.toThrow();
    expect(() => check({ nbf: seconds + 100 })).not.toThrow();
  });

  it('refuses an empty or missing subject', () => {
    // The subject is half the key an account is stored under, so an empty one
    // would collapse separate people onto one row.
    expect(() => check({ sub: '' })).toThrow(/no subject/);
    expect(() => check({ sub: '   ' })).toThrow(/no subject/);
    expect(() => check({ sub: undefined })).toThrow(/no subject/);
  });

  it('refuses a subject longer than OIDC allows', () => {
    expect(() => check({ sub: 'x'.repeat(256) })).toThrow(/implausible subject/);
  });
});
