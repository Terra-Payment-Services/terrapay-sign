import { describe, expect, it } from 'vitest';

import { formatMicrosoftWellKnownUrl, resolveMicrosoftEmailVerificationBypass } from './config';

describe('formatMicrosoftWellKnownUrl', () => {
  it('builds a tenant specific discovery URL from a tenant GUID', () => {
    expect(formatMicrosoftWellKnownUrl('72f988bf-86f1-41af-91ab-2d7cd011db47')).toBe(
      'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0/.well-known/openid-configuration',
    );
  });

  it('keeps the multi-tenant authority for the literal tenants', () => {
    expect(formatMicrosoftWellKnownUrl('common')).toBe(
      'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    );

    expect(formatMicrosoftWellKnownUrl('organizations')).toBe(
      'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration',
    );

    expect(formatMicrosoftWellKnownUrl('consumers')).toBe(
      'https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration',
    );
  });

  it('accepts a verified domain name', () => {
    expect(formatMicrosoftWellKnownUrl('contoso.onmicrosoft.com')).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0/.well-known/openid-configuration',
    );
  });

  it('rejects a tenant that would redirect discovery to another host', () => {
    expect(() => formatMicrosoftWellKnownUrl('common/../../evil.example.com')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);

    expect(() => formatMicrosoftWellKnownUrl('evil.example.com/path')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);

    expect(() => formatMicrosoftWellKnownUrl('//evil.example.com')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);
  });

  it('rejects whitespace, empty and otherwise malformed tenants', () => {
    expect(() => formatMicrosoftWellKnownUrl('')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);
    expect(() => formatMicrosoftWellKnownUrl(' common ')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);
    expect(() => formatMicrosoftWellKnownUrl('my tenant')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);
    expect(() => formatMicrosoftWellKnownUrl('contoso')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);
    expect(() => formatMicrosoftWellKnownUrl('https://evil.example.com')).toThrow(/NEXT_PRIVATE_MICROSOFT_TENANT/);
  });

  it('names the offending value so the failure is diagnosable', () => {
    expect(() => formatMicrosoftWellKnownUrl('evil.example.com/path')).toThrow(/evil\.example\.com\/path/);
  });
});

describe('resolveMicrosoftEmailVerificationBypass', () => {
  const withSkipVerify = (value: string | undefined, run: () => void) => {
    const previous = process.env.NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY;

    if (value === undefined) {
      delete process.env.NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY;
    } else {
      process.env.NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY = value;
    }

    try {
      run();
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY;
      } else {
        process.env.NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY = previous;
      }
    }
  };

  it('allows the bypass against a specific tenant, which is the Entra case it exists for', () => {
    withSkipVerify('true', () => {
      expect(resolveMicrosoftEmailVerificationBypass('72f988bf-86f1-41af-91ab-2d7cd011db47')).toBe(true);
      expect(resolveMicrosoftEmailVerificationBypass('contoso.onmicrosoft.com')).toBe(true);
    });
  });

  it('refuses the bypass on a multi-tenant authority, where any tenant could assert any address', () => {
    withSkipVerify('true', () => {
      for (const tenant of ['common', 'organizations', 'consumers']) {
        expect(() => resolveMicrosoftEmailVerificationBypass(tenant)).toThrow(/NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY/);
      }
    });
  });

  it('leaves a multi-tenant authority usable while verification is still enforced', () => {
    withSkipVerify(undefined, () => {
      expect(resolveMicrosoftEmailVerificationBypass('common')).toBe(false);
    });

    withSkipVerify('false', () => {
      expect(resolveMicrosoftEmailVerificationBypass('common')).toBe(false);
    });
  });
});
