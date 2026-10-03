import { describe, expect, it, vi } from 'vitest';

import { exchangeAuthorizationCode } from './token-exchange';

const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const CLIENT_ID = '00000000-0000-0000-0000-000000000002';
const CLIENT_SECRET = 'the-client-secret';

/**
 * A resolver the address guard is happy with, except for names a test points
 * somewhere private. 198.51.101.10 sits outside every reserved block.
 */
const lookupWith = (overrides: Record<string, string> = {}) => {
  return async (hostname: string): Promise<string[]> => [overrides[hostname] ?? '198.51.101.10'];
};

const tokenResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const succeeds = () =>
  tokenResponse({
    token_type: 'Bearer',
    access_token: 'an-access-token',
    expires_in: 3600,
    id_token: 'header.payload.signature',
    scope: 'openid email profile',
  });

const exchange = async (
  fetchFn: unknown,
  { tokenEndpoint = TOKEN_ENDPOINT, addresses }: { tokenEndpoint?: string; addresses?: Record<string, string> } = {},
) =>
  exchangeAuthorizationCode({
    tokenEndpoint,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: 'https://sign.terrapay.com/api/auth/callback/microsoft',
    code: 'the-code',
    codeVerifier: 'the-verifier',
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    fetchFn: fetchFn as typeof fetch,
    lookup: lookupWith(addresses),
  });

/** The init a fake fetch was called with, which is where the request lives. */
const initOf = (fetchFn: ReturnType<typeof vi.fn>): RequestInit => fetchFn.mock.calls[0][1];

describe('exchangeAuthorizationCode', () => {
  it('redeems a code and returns what the callback writes down', async () => {
    const fetchFn = vi.fn(async () => succeeds());

    const before = Date.now();
    const tokens = await exchange(fetchFn);

    expect(tokens.accessToken).toBe('an-access-token');
    expect(tokens.idToken).toBe('header.payload.signature');
    expect(tokens.accessTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it('sends the code and the verifier, and the secret only as HTTP Basic', async () => {
    const fetchFn = vi.fn(async () => succeeds());

    await exchange(fetchFn);

    const init = initOf(fetchFn);
    const body = new URLSearchParams(String(init.body));

    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');

    // The body is what a 307 replays at whatever host a redirect names, so the
    // secret staying out of it is worth asserting rather than assuming.
    expect(String(init.body)).not.toContain(CLIENT_SECRET);

    const authorization = (init.headers as Record<string, string>).authorization;

    expect(Buffer.from(authorization.replace('Basic ', ''), 'base64').toString()).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);
  });

  it('refuses a redirect to the instance metadata service', async () => {
    const fetchFn = vi.fn(
      async () =>
        // A 307 is the one that matters: fetch replays the POST body at the
        // target, and the body is a live authorization code.
        new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );

    await expect(exchange(fetchFn)).rejects.toThrow(/Refusing a redirect/);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to another host, however ordinary it looks', async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/token' } }),
    );

    await expect(exchange(fetchFn)).rejects.toThrow(/Refusing a redirect/);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a token endpoint whose host resolves somewhere private', async () => {
    const fetchFn = vi.fn(async () => succeeds());

    await expect(
      exchange(fetchFn, {
        tokenEndpoint: 'https://sso.internal.example/oauth2/token',
        addresses: { 'sso.internal.example': '169.254.169.254' },
      }),
    ).rejects.toThrow(/not publicly routable/);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a token endpoint on plain http', async () => {
    const fetchFn = vi.fn(async () => succeeds());

    await expect(exchange(fetchFn, { tokenEndpoint: 'http://login.example/oauth2/token' })).rejects.toThrow(
      /only https are allowed/,
    );

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('carries the authority error code into the failure', async () => {
    // An operator needs to tell a stale code apart from a wrong secret, and the
    // code in the body is the only thing that says which.
    const fetchFn = vi.fn(async () =>
      tokenResponse({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' }, 400),
    );

    await expect(exchange(fetchFn)).rejects.toThrow(/invalid_grant/);
  });

  it('fails on an answer that is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>a proxy sign in page</html>', { status: 200 }));

    await expect(exchange(fetchFn)).rejects.toThrow(/not JSON/);
  });

  it('fails when the authority returns no id token', async () => {
    const fetchFn = vi.fn(async () => tokenResponse({ access_token: 'a', expires_in: 3600, token_type: 'Bearer' }));

    await expect(exchange(fetchFn)).rejects.toThrow(/no id_token/);
  });

  it('fails when the authority returns no expiry', async () => {
    // The row written for this account stores an expiry, so a missing one
    // cannot be guessed at without writing down something untrue.
    const fetchFn = vi.fn(async () => tokenResponse({ access_token: 'a', id_token: 'b.c.d', token_type: 'Bearer' }));

    await expect(exchange(fetchFn)).rejects.toThrow(/no expires_in/);
  });

  it('fails on a status the authority has no business returning', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 500 }));

    await expect(exchange(fetchFn)).rejects.toThrow(/HTTP 500/);
  });
});
