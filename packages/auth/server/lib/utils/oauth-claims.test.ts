import { describe, expect, it } from 'vitest';

import { extractEmailFromClaims, extractNameFromClaims } from './oauth-claims';

describe('extractEmailFromClaims', () => {
  it('prefers the email claim when present', () => {
    expect(
      extractEmailFromClaims(
        {
          email: 'first@example.com',
          preferred_username: 'second@example.com',
          upn: 'third@example.com',
        },
        'microsoft',
      ),
    ).toBe('first@example.com');
  });

  it('falls back to preferred_username when Entra omits email', () => {
    expect(
      extractEmailFromClaims(
        {
          preferred_username: 'user@contoso.com',
          upn: 'other@contoso.com',
        },
        'microsoft',
      ),
    ).toBe('user@contoso.com');
  });

  it('falls back to upn when preferred_username is not an email address', () => {
    expect(
      extractEmailFromClaims(
        {
          preferred_username: 'CONTOSO\\jsmith',
          upn: 'jsmith@contoso.com',
        },
        'microsoft',
      ),
    ).toBe('jsmith@contoso.com');
  });

  it('skips an email claim that is not a well-formed address', () => {
    expect(
      extractEmailFromClaims(
        {
          email: 'not-an-email',
          upn: 'jsmith@contoso.com',
        },
        'microsoft',
      ),
    ).toBe('jsmith@contoso.com');
  });

  it('trims surrounding whitespace from an accepted claim', () => {
    expect(extractEmailFromClaims({ preferred_username: '  jsmith@contoso.com  ' }, 'microsoft')).toBe(
      'jsmith@contoso.com',
    );
  });

  it('returns null when no claim holds an address', () => {
    expect(extractEmailFromClaims({}, 'microsoft')).toBeNull();
    expect(extractEmailFromClaims({ preferred_username: 'jsmith', upn: '' }, 'microsoft')).toBeNull();
    expect(extractEmailFromClaims({ email: 42, preferred_username: null }, 'microsoft')).toBeNull();
  });
});

describe('extractNameFromClaims', () => {
  it('uses the name claim when present', () => {
    expect(extractNameFromClaims({ name: 'Jane Smith' }, 'jsmith@contoso.com')).toBe('Jane Smith');
  });

  it('falls back to preferred_username, then to the resolved email', () => {
    expect(extractNameFromClaims({ preferred_username: 'jsmith@contoso.com' }, 'jsmith@contoso.com')).toBe(
      'jsmith@contoso.com',
    );

    expect(extractNameFromClaims({}, 'jsmith@contoso.com')).toBe('jsmith@contoso.com');
    expect(extractNameFromClaims({ name: '   ' }, 'jsmith@contoso.com')).toBe('jsmith@contoso.com');
  });
});

describe('provider scoping of the non-standard claims', () => {
  // The regression this scoping exists for. Microsoft omits `email` unless the
  // optional claim is configured, so the fallbacks are necessary there and the
  // pinned tenant makes them tolerable. Applying them to every provider meant
  // any accepted OIDC authority could assert someone else's address in a claim
  // Microsoft itself documents as mutable, and be linked to that account.
  const impersonation = { email: null, preferred_username: 'victim@terrapay.com', upn: 'victim@terrapay.com' };

  it('takes the Entra fallbacks for Microsoft, which needs them', () => {
    expect(extractEmailFromClaims(impersonation, 'microsoft')).toBe('victim@terrapay.com');
  });

  it('refuses them for generic OIDC', () => {
    expect(extractEmailFromClaims(impersonation, 'oidc')).toBeNull();
  });

  it('refuses them for Google', () => {
    expect(extractEmailFromClaims(impersonation, 'google')).toBeNull();
  });

  it('refuses them when no provider is named', () => {
    expect(extractEmailFromClaims(impersonation)).toBeNull();
  });

  it('still takes a standard email claim from any provider', () => {
    expect(extractEmailFromClaims({ email: 'real@terrapay.com' }, 'oidc')).toBe('real@terrapay.com');
  });
});
