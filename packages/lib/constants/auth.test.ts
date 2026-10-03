import { afterEach, describe, expect, it } from 'vitest';

import { isEmailDomainAllowedForSignup, isPasskeyEnabled, isSignupEnabledForProvider } from './auth';

/**
 * The deployment these guard is internet facing and authenticates against one
 * Entra tenant. Each of these flags is the difference between a service only
 * TerraPay staff can enter and one anybody can, so they are worth pinning.
 */

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DISABLE_PASSKEY;
  delete process.env.NEXT_PUBLIC_DISABLE_SIGNUP;
  delete process.env.NEXT_PUBLIC_DISABLE_MICROSOFT_SIGNUP;
  delete process.env.NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS;
});

describe('isPasskeyEnabled', () => {
  it('is on by default, which is upstream behaviour', () => {
    expect(isPasskeyEnabled()).toBe(true);
  });

  it('is off only for the exact string, not for anything truthy', () => {
    process.env.NEXT_PUBLIC_DISABLE_PASSKEY = 'true';
    expect(isPasskeyEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_DISABLE_PASSKEY = '1';
    expect(isPasskeyEnabled()).toBe(true);
  });
});

describe('the deployed signup policy', () => {
  it('lets a terrapay address in through Microsoft', () => {
    process.env.NEXT_PUBLIC_DISABLE_SIGNUP = 'false';
    process.env.NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS = 'terrapay.com';

    expect(isSignupEnabledForProvider('microsoft')).toBe(true);
    expect(isEmailDomainAllowedForSignup('staff@terrapay.com')).toBe(true);
  });

  it('keeps every other domain out, including a lookalike', () => {
    process.env.NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS = 'terrapay.com';

    expect(isEmailDomainAllowedForSignup('someone@gmail.com')).toBe(false);
    // A suffix match rather than an exact one would admit this.
    expect(isEmailDomainAllowedForSignup('someone@notterrapay.com')).toBe(false);
    expect(isEmailDomainAllowedForSignup('someone@terrapay.com.example.net')).toBe(false);
  });

  it('admits every domain when no allowlist is configured, which is why one is set', () => {
    expect(isEmailDomainAllowedForSignup('someone@gmail.com')).toBe(true);
  });

  it('refuses email and password signup even while Microsoft signup is open', () => {
    process.env.NEXT_PUBLIC_DISABLE_SIGNUP = 'false';
    process.env.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP = 'true';

    expect(isSignupEnabledForProvider('email')).toBe(false);
    expect(isSignupEnabledForProvider('microsoft')).toBe(true);

    delete process.env.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP;
  });
});
