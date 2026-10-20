import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@documenso/prisma', () => ({ prisma: { recipient: { findFirst: vi.fn() } } }));

const {
  createRecipientAccess2FACookie,
  hasRecipientAccess2FACookie,
  isRecipientAccess2FASatisfied,
  RECIPIENT_ACCESS_2FA_COOKIE_MAX_AGE_SECONDS,
} = await import('./recipient-access-2fa-cookie');

/**
 * The cookie is all that stands between a forwarded signing link and the
 * document once the recipient has entered their code, so it must only ever
 * vouch for the recipient it was issued to, and only for a short time.
 */

/** Turn a Set-Cookie header into the Cookie header a browser would send back. */
const asRequestHeaders = (setCookie: string) => new Headers({ cookie: setCookie.split(';')[0] });

describe('recipient access code cookie', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-that-is-long-enough-to-sign');
  });

  it('vouches for the recipient it was issued to', async () => {
    const headers = asRequestHeaders(await createRecipientAccess2FACookie({ recipientId: 7 }));

    expect(await hasRecipientAccess2FACookie({ headers, recipientId: 7 })).toBe(true);
  });

  it('is HttpOnly and expires', async () => {
    const setCookie = await createRecipientAccess2FACookie({ recipientId: 7 });

    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain(`Max-Age=${RECIPIENT_ACCESS_2FA_COOKIE_MAX_AGE_SECONDS}`);
  });

  it('cannot be renamed onto another recipient', async () => {
    const issued = (await createRecipientAccess2FACookie({ recipientId: 7 })).split(';')[0];
    const value = issued.slice(issued.indexOf('=') + 1);
    const headers = new Headers({ cookie: `recipientAccess2FA-8=${value}` });

    expect(await hasRecipientAccess2FACookie({ headers, recipientId: 8 })).toBe(false);
  });

  it('is refused once it has expired', async () => {
    const now = Date.now();
    const headers = asRequestHeaders(await createRecipientAccess2FACookie({ recipientId: 7, now }));
    const later = now + RECIPIENT_ACCESS_2FA_COOKIE_MAX_AGE_SECONDS * 1000 + 1;

    expect(await hasRecipientAccess2FACookie({ headers, recipientId: 7, now: later })).toBe(false);
  });

  it('is refused when signed with another secret', async () => {
    const headers = asRequestHeaders(await createRecipientAccess2FACookie({ recipientId: 7 }));

    vi.stubEnv('NEXTAUTH_SECRET', 'a-different-secret-entirely-for-signing');

    expect(await hasRecipientAccess2FACookie({ headers, recipientId: 7 })).toBe(false);
  });

  it('is only required when the recipient access auth asks for a code', async () => {
    const headers = new Headers();

    expect(
      await isRecipientAccess2FASatisfied({
        headers,
        documentAuthOptions: null,
        recipient: { id: 7, authOptions: null },
      }),
    ).toBe(true);

    expect(
      await isRecipientAccess2FASatisfied({
        headers,
        documentAuthOptions: null,
        recipient: { id: 7, authOptions: { accessAuth: ['TWO_FACTOR_AUTH'], actionAuth: [] } },
      }),
    ).toBe(false);
  });
});

/**
 * Attributes of the Set-Cookie header in each environment. The constants that
 * pick them are fixed at module load, so each case stubs the environment,
 * resets the module registry and imports a fresh copy.
 */
const issueCookieFor = async (environment: Record<string, string>) => {
  for (const [key, value] of Object.entries({
    ...environment,
    NEXTAUTH_SECRET: 'test-secret-that-is-long-enough-to-sign',
  })) {
    vi.stubEnv(key, value);
  }

  vi.resetModules();
  vi.doMock('@documenso/prisma', () => ({ prisma: { recipient: { findFirst: vi.fn() } } }));

  const fresh = await import('./recipient-access-2fa-cookie');
  const [pair, ...rest] = (await fresh.createRecipientAccess2FACookie({ recipientId: 7 }))
    .split(';')
    .map((part) => part.trim());

  return {
    name: pair.slice(0, pair.indexOf('=')),
    attributes: new Map(
      rest.map((part) => {
        const index = part.indexOf('=');

        return index === -1 ? [part.toLowerCase(), ''] : [part.slice(0, index).toLowerCase(), part.slice(index + 1)];
      }),
    ),
  };
};

describe('recipient access code cookie attributes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('AC5: stays SameSite=None; Secure; Partitioned in production, for the cross-site embed', async () => {
    const { name, attributes } = await issueCookieFor({
      NODE_ENV: 'production',
      NEXT_PUBLIC_WEBAPP_URL: 'https://sign.example.com',
    });

    expect(name).toBe('__Secure-recipientAccess2FA-7');
    expect(attributes.get('samesite')?.toLowerCase()).toBe('none');
    expect(attributes.has('secure')).toBe(true);
    expect(attributes.has('partitioned')).toBe(true);
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.get('path')).toBe('/');
    expect(attributes.get('max-age')).toBe('1800');
  });

  it('AC6: is plain SameSite=Lax over http in development', async () => {
    const { name, attributes } = await issueCookieFor({
      NODE_ENV: 'test',
      NEXT_PUBLIC_WEBAPP_URL: 'http://localhost:3000',
    });

    expect(name).toBe('recipientAccess2FA-7');
    expect(attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.has('secure')).toBe(false);
    expect(attributes.has('partitioned')).toBe(false);
  });
});
