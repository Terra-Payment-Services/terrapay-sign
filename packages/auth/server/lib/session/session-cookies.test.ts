import { Hono } from 'hono';
import { serializeSigned } from 'hono/utils/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Session and CSRF cookie attributes, read off real Set-Cookie headers.
 *
 * `useSecureCookies` and `sessionCookieOptions` are fixed when the module
 * loads, so each scenario stubs the environment, resets the module registry
 * and imports the code afterwards. The real `auth` router cannot be imported
 * here, because its email routes pull in Lingui macros that this package's
 * vitest config does not compile. Sign-out therefore mounts the real
 * `signOutRoute`, sign-in runs the real `onAuthorize` and the CSRF cookie runs
 * the real `setCsrfCookie`, each on a throwaway Hono app that mirrors the
 * route in `server/index.ts`.
 */

const SECRET = 'test-secret-that-is-long-enough-to-sign';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

const validateSessionToken = vi.fn();

type StoredSession = { id: string; userId: number };

/** In-memory stand-in for the session table, shared by the prisma and invalidateSessions fakes. */
let sessionStore: StoredSession[] = [];

const invalidateSessions = vi.fn(({ userId, sessionIds }: { userId: number; sessionIds: string[] }) => {
  sessionStore = sessionStore.filter((row) => !(row.userId === userId && sessionIds.includes(row.id)));

  return Promise.resolve();
});

const PRODUCTION = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_WEBAPP_URL: 'https://sign.example.com',
};

const DEVELOPMENT = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_WEBAPP_URL: 'http://localhost:3000',
};

const load = async (environment: Record<string, string>) => {
  for (const [key, value] of Object.entries({
    ...environment,
    NEXTAUTH_SECRET: SECRET,
  })) {
    vi.stubEnv(key, value);
  }

  vi.resetModules();

  vi.doMock('@documenso/prisma', () => ({
    prisma: {
      session: {
        findMany: async ({ where }: { where: { userId: number; id: { not: string } } }) =>
          sessionStore
            .filter((row) => row.userId === where.userId && row.id !== where.id.not)
            .map((row) => ({ id: row.id })),
        deleteMany: async () => ({ count: 0 }),
      },
    },
  }));
  vi.doMock('@documenso/lib/server-only/user/assert-user-not-disabled', () => ({
    assertUserNotDisabledById: vi.fn(),
  }));
  vi.doMock('./session', async () => ({
    ...(await vi.importActual<object>('./session')),
    createSession: vi.fn(),
    validateSessionToken: (...args: unknown[]) => validateSessionToken(...args),
    invalidateSessions: (...args: Parameters<typeof invalidateSessions>) => invalidateSessions(...args),
  }));

  const { onAuthorize } = await import('../utils/authorizer');
  const { setCsrfCookie } = await import('./session-cookies');
  const { signOutRoute } = await import('../../routes/sign-out');

  const auth = new Hono()
    .use(async (c, next) => {
      c.set('requestMetadata' as never, {} as never);
      await next();
    })
    .get('/csrf', async (c) => c.json({ csrfToken: await setCsrfCookie(c) }))
    .route('/', signOutRoute as never);

  return { auth, onAuthorize };
};

type ParsedCookie = {
  name: string;
  attributes: Map<string, string>;
};

const parseSetCookie = (header: string): ParsedCookie => {
  const [pair, ...rest] = header.split(';').map((part) => part.trim());

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

const cookiesNamed = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map(parseSetCookie)
    .filter((cookie) => cookie.name === name);

const only = (response: Response, name: string) => {
  const matches = cookiesNamed(response, name);

  expect(matches, `Set-Cookie for ${name} in ${JSON.stringify(response.headers.getSetCookie())}`).toHaveLength(1);

  return matches[0].attributes;
};

const signIn = async (onAuthorize: (user: { userId: number }, c: never) => Promise<void>) => {
  const app = new Hono();

  app.post('/sign-in', async (c) => {
    c.set('requestMetadata' as never, {} as never);
    await onAuthorize({ userId: 7 }, c as never);

    return c.text('ok');
  });

  return await app.request('/sign-in', { method: 'POST' });
};

const signOut = async (auth: Hono<never>, cookieName: string, path = '/signout', body?: unknown) => {
  const signed = (
    await serializeSigned(cookieName, 'session-token', SECRET, {
      secure: cookieName.startsWith('__Secure-'),
    })
  ).split(';')[0];

  return await auth.request(path, {
    method: 'POST',
    headers: { cookie: signed, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
};

afterEach(() => {
  sessionStore = [];
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('production cookies (https, NODE_ENV=production)', () => {
  it('AC1: sign-in sets __Secure-sessionId as SameSite=Lax', async () => {
    const { onAuthorize } = await load(PRODUCTION);
    const before = Date.now();

    const response = await signIn(onAuthorize);
    const attributes = only(response, '__Secure-sessionId');

    expect(attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(attributes.has('secure')).toBe(true);
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.get('path')).toBe('/');
    expect(attributes.get('domain')).toBe('sign.example.com');
    expect(attributes.has('partitioned')).toBe(false);

    const expires = new Date(attributes.get('expires') ?? '').getTime();

    expect(Math.abs(expires - (before + EIGHT_HOURS_MS))).toBeLessThan(60_000);
  });

  it.each([
    ['a valid session', { session: { id: 'sid', userId: 7 } }],
    ['no session', { session: null }],
  ])('AC3: sign-out with %s clears __Secure-sessionId as SameSite=Lax', async (_label, validated) => {
    const { auth, onAuthorize } = await load(PRODUCTION);

    validateSessionToken.mockResolvedValue(validated);

    const issued = only(await signIn(onAuthorize), '__Secure-sessionId');
    const attributes = only(await signOut(auth as never, '__Secure-sessionId'), '__Secure-sessionId');

    expect(attributes.get('max-age')).toBe('0');
    expect(attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(attributes.has('secure')).toBe(true);
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.get('path')).toBe('/');
    expect(attributes.get('domain')).toBe('sign.example.com');

    // Same name, domain and path as the issued cookie is what lets a browser delete it.
    expect(attributes.get('domain')).toBe(issued.get('domain'));
    expect(attributes.get('path')).toBe(issued.get('path'));
  });

  it('AC4: GET /csrf sets __Secure-csrfToken as SameSite=Lax and session-lived', async () => {
    const { auth } = await load(PRODUCTION);

    const response = await auth.request('/csrf');
    const attributes = only(response, '__Secure-csrfToken');

    expect(attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(attributes.has('secure')).toBe(true);
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.get('path')).toBe('/');
    expect(attributes.has('expires')).toBe(false);
    expect(attributes.has('max-age')).toBe(false);
  });
});

describe('sign-out answers through the context and clears the cookie on every branch', () => {
  const VALID = { session: { id: 'sid', userId: 7 } };
  const INVALID = { session: null };

  const expectCleared = (response: Response) => {
    const attributes = only(response, '__Secure-sessionId');

    expect(attributes.get('max-age')).toBe('0');
    expect(attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(attributes.has('secure')).toBe(true);
    expect(attributes.get('path')).toBe('/');
    expect(attributes.get('domain')).toBe('sign.example.com');
  };

  it('AC12: /signout with a valid session answers 200 and clears the cookie', async () => {
    const { auth } = await load(PRODUCTION);

    validateSessionToken.mockResolvedValue(VALID);

    const response = await signOut(auth as never, '__Secure-sessionId', '/signout');

    expect(response.status).toBe(200);
    expectCleared(response);
  });

  it('AC13: /signout-all with a valid session revokes the other sessions, keeps the current one and its cookie', async () => {
    const { auth } = await load(PRODUCTION);

    sessionStore = [
      { id: 'sid', userId: 7 },
      { id: 'other-1', userId: 7 },
      { id: 'other-2', userId: 7 },
      { id: 'someone-else', userId: 8 },
    ];
    validateSessionToken.mockResolvedValue(VALID);

    const response = await signOut(auth as never, '__Secure-sessionId', '/signout-all');

    expect(response.status).toBe(200);
    expect(cookiesNamed(response, '__Secure-sessionId')).toHaveLength(0);
    expect(invalidateSessions).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, sessionIds: ['other-1', 'other-2'], isRevoke: true }),
    );
    expect(sessionStore.map((row) => row.id)).toEqual(['sid', 'someone-else']);
  });

  it.each([
    '/signout',
    '/signout-all',
  ])('AC13: %s with an invalid or revoked session answers 401 and clears the cookie', async (path) => {
    const { auth } = await load(PRODUCTION);

    validateSessionToken.mockResolvedValue(INVALID);

    const response = await signOut(auth as never, '__Secure-sessionId', path);

    expect(response.status).toBe(401);
    expectCleared(response);
  });

  describe('POST /signout-session', () => {
    const revoke = async (auth: Hono<never>, sessionId: string) =>
      await signOut(auth as never, '__Secure-sessionId', '/signout-session', { sessionId });

    it('refuses an invalid or revoked session with 401 and clears the cookie', async () => {
      const { auth } = await load(PRODUCTION);

      validateSessionToken.mockResolvedValue(INVALID);

      const response = await revoke(auth as never, 'other-1');

      expect(response.status).toBe(401);
      expectCleared(response);
      expect(invalidateSessions).not.toHaveBeenCalled();
    });

    it('refuses a request with no session cookie with 401', async () => {
      const { auth } = await load(PRODUCTION);

      const response = await (auth as Hono<never>).request('/signout-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'other-1' }),
      });

      expect(response.status).toBe(401);
      expect(invalidateSessions).not.toHaveBeenCalled();
    });

    it('revoking the current session answers 200, clears the cookie and invalidates it', async () => {
      const { auth } = await load(PRODUCTION);

      sessionStore = [
        { id: 'sid', userId: 7 },
        { id: 'other-1', userId: 7 },
      ];
      validateSessionToken.mockResolvedValue(VALID);

      const response = await revoke(auth as never, 'sid');

      expect(response.status).toBe(200);
      expectCleared(response);
      expect(sessionStore.map((row) => row.id)).toEqual(['other-1']);
    });

    it('revoking another session answers 200, keeps the cookie and the current session', async () => {
      const { auth } = await load(PRODUCTION);

      sessionStore = [
        { id: 'sid', userId: 7 },
        { id: 'other-1', userId: 7 },
      ];
      validateSessionToken.mockResolvedValue(VALID);

      const response = await revoke(auth as never, 'other-1');

      expect(response.status).toBe(200);
      expect(cookiesNamed(response, '__Secure-sessionId')).toHaveLength(0);
      expect(sessionStore.map((row) => row.id)).toEqual(['sid']);
    });
  });
});

describe('development cookies (http://localhost, NODE_ENV=test)', () => {
  const expectPlainLax = (attributes: Map<string, string>) => {
    expect(attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.has('secure')).toBe(false);
    expect(attributes.has('partitioned')).toBe(false);
  };

  it('AC6: sign-in sets sessionId as plain SameSite=Lax', async () => {
    const { onAuthorize } = await load(DEVELOPMENT);

    expectPlainLax(only(await signIn(onAuthorize), 'sessionId'));
  });

  it('AC6: GET /csrf sets csrfToken as plain SameSite=Lax', async () => {
    const { auth } = await load(DEVELOPMENT);

    expectPlainLax(only(await auth.request('/csrf'), 'csrfToken'));
  });

  it('AC6: sign-out clears sessionId as plain SameSite=Lax', async () => {
    const { auth } = await load(DEVELOPMENT);

    validateSessionToken.mockResolvedValue({
      session: { id: 'sid', userId: 7 },
    });

    const attributes = only(await signOut(auth as never, 'sessionId'), 'sessionId');

    expect(attributes.get('max-age')).toBe('0');
    expectPlainLax(attributes);
  });
});
