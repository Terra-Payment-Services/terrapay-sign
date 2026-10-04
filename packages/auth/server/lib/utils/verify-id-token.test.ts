import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FetchImplementation, JWK } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pinSigningAlgorithms, verifyIdToken } from './verify-id-token';

const ISSUER = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0';
const AUDIENCE = '00000000-0000-0000-0000-000000000002';
const ALGORITHMS = ['RS256'];

const now = new Date('2026-09-15T12:00:00Z');
const seconds = Math.floor(now.getTime() / 1000);

type Signer = {
  kid: string;
  publicJwk: JWK;
  sign: (claims?: Record<string, unknown>, algorithm?: string) => Promise<string>;
};

/** A key pair plus a way to mint tokens with it, standing in for the authority. */
const createSigner = async (kid: string, algorithm = 'RS256'): Promise<Signer> => {
  const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true });

  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: algorithm, use: 'sig' };

  // The claims are built as a plain object so an override in a test wins. The
  // jose setters run after the constructor and would quietly replace one.
  const sign = async (claims: Record<string, unknown> = {}, signingAlgorithm = algorithm) =>
    new SignJWT({
      sub: 'a-stable-subject',
      iss: ISSUER,
      aud: AUDIENCE,
      iat: seconds - 60,
      exp: seconds + 3600,
      ...claims,
    })
      .setProtectedHeader({ alg: signingAlgorithm, kid })
      .sign(privateKey);

  return { kid, publicJwk, sign };
};

/**
 * Serves a key set without a network, and counts how often it is asked.
 *
 * The count is the point of the cooldown tests: a refetch that happens is not
 * the same as one that was suppressed, and only the counter can tell them apart.
 */
const createJwksEndpoint = (keys: JWK[]) => {
  const state = { calls: 0, keys };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const fetchImplementation = (() => {
    state.calls += 1;

    return Promise.resolve(
      new Response(JSON.stringify({ keys: state.keys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as FetchImplementation;

  return { state, fetchImplementation };
};

// The key set is cached per URL for the lifetime of the process, so every test
// that wants a clean cache needs a URL of its own.
let uriCounter = 0;
const nextJwksUri = () => {
  uriCounter += 1;

  return `https://keys.example.com/${uriCounter}/jwks.json`;
};

/**
 * Move the wall clock forward past the refetch cooldown.
 *
 * Only Date is faked. The cooldown is measured with `Date.now()` inside jose,
 * while the claim checks read the fixed `now` above, so the two do not collide.
 */
const passTheCooldown = () => {
  vi.setSystemTime(new Date(Date.now() + 31 * 1000));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('pinSigningAlgorithms', () => {
  it('keeps the asymmetric algorithms the authority advertises', () => {
    expect(pinSigningAlgorithms(['RS256', 'ES256', 'PS256'])).toEqual(['RS256', 'ES256', 'PS256']);
  });

  it('drops the HMAC family, which a published key would verify for anybody', () => {
    expect(pinSigningAlgorithms(['RS256', 'HS256'])).toEqual(['RS256']);
  });

  it('drops none', () => {
    expect(pinSigningAlgorithms(['RS256', 'none'])).toEqual(['RS256']);
  });

  it('refuses to proceed when nothing advertised can be verified', () => {
    expect(() => pinSigningAlgorithms(['HS256', 'none'])).toThrow(/no signature algorithm/);
  });

  it('refuses to proceed when the authority advertises nothing at all', () => {
    expect(() => pinSigningAlgorithms([])).toThrow(/no signature algorithm/);
  });
});

describe('verifyIdToken', () => {
  const verify = async (
    idToken: string,
    jwksUri: string,
    fetchImplementation: FetchImplementation,
    overrides: { issuer?: string; audience?: string; advertisedSigningAlgorithms?: string[] } = {},
  ) =>
    verifyIdToken({
      idToken,
      issuer: overrides.issuer ?? ISSUER,
      audience: overrides.audience ?? AUDIENCE,
      jwksUri,
      advertisedSigningAlgorithms: overrides.advertisedSigningAlgorithms ?? ALGORITHMS,
      now,
      fetchImplementation,
    });

  it('accepts a token signed by a key the authority publishes', async () => {
    const signer = await createSigner('key-1');
    const { state, fetchImplementation } = createJwksEndpoint([signer.publicJwk]);
    const jwksUri = nextJwksUri();

    const claims = await verify(await signer.sign(), jwksUri, fetchImplementation);

    expect(claims.sub).toBe('a-stable-subject');
    expect(claims.iss).toBe(ISSUER);
    expect(state.calls).toBe(1);
  });

  it('refuses a token signed by a key the authority does not publish', async () => {
    const authority = await createSigner('key-1');
    const attacker = await createSigner('key-1');
    const { fetchImplementation } = createJwksEndpoint([authority.publicJwk]);

    // Same kid, different private key. This is the case the whole change exists
    // for, and before it the token was believed on sight.
    await expect(verify(await attacker.sign(), nextJwksUri(), fetchImplementation)).rejects.toThrow(
      /failed verification/,
    );
  });

  it('refuses a tampered payload', async () => {
    const signer = await createSigner('key-1');
    const { fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    const [header, , signature] = (await signer.sign()).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', iss: ISSUER, aud: AUDIENCE }))
      .toString('base64url')
      .replace(/=+$/, '');

    await expect(verify(`${header}.${forged}.${signature}`, nextJwksUri(), fetchImplementation)).rejects.toThrow(
      /failed verification/,
    );
  });

  it('refuses an unsigned token', async () => {
    const signer = await createSigner('key-1');
    const { fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    const header = Buffer.from(JSON.stringify({ alg: 'none' }))
      .toString('base64url')
      .replace(/=+$/, '');
    const payload = Buffer.from(JSON.stringify({ sub: 'someone-else', iss: ISSUER, aud: AUDIENCE }))
      .toString('base64url')
      .replace(/=+$/, '');

    await expect(verify(`${header}.${payload}.`, nextJwksUri(), fetchImplementation)).rejects.toThrow(
      /failed verification|signing key/,
    );
  });

  it('refuses an algorithm the authority does not advertise', async () => {
    const signer = await createSigner('key-1', 'ES256');
    const { fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    // A real signature by a key in the real key set. The header asks for a
    // family the allowlist does not contain, and the allowlist wins.
    await expect(
      verify(await signer.sign(), nextJwksUri(), fetchImplementation, { advertisedSigningAlgorithms: ['RS256'] }),
    ).rejects.toThrow(/failed verification/);
  });

  it('refuses an HMAC token signed with the published public key', async () => {
    const signer = await createSigner('key-1');
    const { fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    // The RS to HS confusion, spelled out: the attacker downloads the public
    // key and uses it as an HMAC secret. Nothing in the allowlist matches, so
    // the token never reaches a key lookup.
    const secret = new TextEncoder().encode(String(signer.publicJwk.n));
    const token = await new SignJWT({ sub: 'someone-else' })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(seconds + 3600)
      .sign(secret);

    await expect(verify(token, nextJwksUri(), fetchImplementation)).rejects.toThrow(/failed verification/);
  });

  it('refuses a token from another issuer', async () => {
    const signer = await createSigner('key-1');
    const { fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    await expect(
      verify(await signer.sign(), nextJwksUri(), fetchImplementation, { issuer: 'https://accounts.google.com' }),
    ).rejects.toThrow(/failed verification/);
  });

  it('refuses a token for another application', async () => {
    const signer = await createSigner('key-1');
    const { fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    await expect(
      verify(await signer.sign(), nextJwksUri(), fetchImplementation, { audience: 'another-application' }),
    ).rejects.toThrow(/failed verification/);
  });

  it('refuses an expired token', async () => {
    const signer = await createSigner('key-1');
    const { fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    await expect(
      verify(await signer.sign({ exp: seconds - 7200 }), nextJwksUri(), fetchImplementation),
    ).rejects.toThrow(/failed verification/);
  });

  it('reuses the cached key set across sign ins', async () => {
    const signer = await createSigner('key-1');
    const { state, fetchImplementation } = createJwksEndpoint([signer.publicJwk]);
    const jwksUri = nextJwksUri();

    await verify(await signer.sign(), jwksUri, fetchImplementation);
    await verify(await signer.sign(), jwksUri, fetchImplementation);
    await verify(await signer.sign(), jwksUri, fetchImplementation);

    expect(state.calls).toBe(1);
  });

  it('will not let an unknown kid drive the JWKS endpoint', async () => {
    const signer = await createSigner('key-1');
    const unknown = await createSigner('key-2');
    const { state, fetchImplementation } = createJwksEndpoint([signer.publicJwk]);
    const jwksUri = nextJwksUri();

    vi.useFakeTimers({ toFake: ['Date'] });

    await verify(await signer.sign(), jwksUri, fetchImplementation);
    expect(state.calls).toBe(1);

    // Anyone who can reach the callback can invent a kid. Inside the cooldown
    // none of these reaches the authority.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(verify(await unknown.sign(), jwksUri, fetchImplementation)).rejects.toThrow(/signing key/);
    }

    expect(state.calls).toBe(1);

    // Past the cooldown one refetch is allowed, which is what makes rotation
    // work. The next run of attempts is held off again by the same floor.
    passTheCooldown();

    await expect(verify(await unknown.sign(), jwksUri, fetchImplementation)).rejects.toThrow(/signing key/);
    await expect(verify(await unknown.sign(), jwksUri, fetchImplementation)).rejects.toThrow(/signing key/);

    expect(state.calls).toBe(2);
  });

  it('picks up a rotated key once the cooldown has passed', async () => {
    const signer = await createSigner('key-1');
    const rotated = await createSigner('key-2');
    const endpoint = createJwksEndpoint([signer.publicJwk]);
    const jwksUri = nextJwksUri();

    vi.useFakeTimers({ toFake: ['Date'] });

    await verify(await signer.sign(), jwksUri, endpoint.fetchImplementation);

    endpoint.state.keys = [signer.publicJwk, rotated.publicJwk];
    passTheCooldown();

    const claims = await verify(await rotated.sign(), jwksUri, endpoint.fetchImplementation);

    expect(claims.sub).toBe('a-stable-subject');
    expect(endpoint.state.calls).toBe(2);
  });

  it('reports a key set it cannot fetch as a key problem', async () => {
    const signer = await createSigner('key-1');

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const failing = (() => Promise.resolve(new Response('nope', { status: 500 }))) as unknown as FetchImplementation;

    await expect(verify(await signer.sign(), nextJwksUri(), failing)).rejects.toThrow(/signing key/);
  });

  it('refuses when the authority advertises no verifiable algorithm', async () => {
    const signer = await createSigner('key-1');
    const { state, fetchImplementation } = createJwksEndpoint([signer.publicJwk]);

    await expect(
      verify(await signer.sign(), nextJwksUri(), fetchImplementation, { advertisedSigningAlgorithms: ['HS256'] }),
    ).rejects.toThrow(/no signature algorithm/);

    // Refused before any key was fetched, so there is no path where an
    // unverifiable configuration turns into a sign in.
    expect(state.calls).toBe(0);
  });
});

/**
 * A resolver the address guard is happy with, except for names a test points
 * somewhere private. 198.51.101.10 sits outside every reserved block, so it
 * stands in for a real identity provider.
 */
const lookupWith = (overrides: Record<string, string> = {}) => {
  return async (hostname: string): Promise<string[]> => [overrides[hostname] ?? '198.51.101.10'];
};

const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });

const keySet = (keys: JWK[]) => new Response(JSON.stringify({ keys }), { status: 200 });

describe('the guarded fetch behind the key set', () => {
  const verifyThrough = async (
    idToken: string,
    jwksUri: string,
    fetchFn: unknown,
    addresses: Record<string, string> = {},
  ) =>
    verifyIdToken({
      idToken,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri,
      advertisedSigningAlgorithms: ALGORITHMS,
      now,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      fetchFn: fetchFn as typeof fetch,
      lookup: lookupWith(addresses),
    });

  it('verifies a token when the key set is somewhere we will go', async () => {
    const signer = await createSigner('key-1');
    const fetchFn = vi.fn(async () => keySet([signer.publicJwk]));

    const claims = await verifyThrough(await signer.sign(), nextJwksUri(), fetchFn);

    expect(claims.sub).toBe('a-stable-subject');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not follow a redirect to the instance metadata service', async () => {
    const signer = await createSigner('key-1');

    // The whole attack in one response. The pre-flight check passed, because
    // the host it checked is a real one on the open internet.
    const fetchFn = vi.fn(async () => redirectTo('http://169.254.169.254/latest/meta-data/iam/'));

    await expect(verifyThrough(await signer.sign(), nextJwksUri(), fetchFn)).rejects.toThrow(/signing key/);

    // The refusal has to happen before the request, not after it. One call means
    // nothing was ever sent to 169.254.169.254.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not follow a redirect to a host that resolves somewhere private', async () => {
    const signer = await createSigner('key-1');
    const fetchFn = vi.fn(async () => redirectTo('https://keys.internal.example/jwks.json'));

    await expect(
      verifyThrough(await signer.sign(), nextJwksUri(), fetchFn, { 'keys.internal.example': '172.16.4.9' }),
    ).rejects.toThrow(/signing key/);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not follow a redirect from https down to http', async () => {
    const signer = await createSigner('key-1');
    const jwksUri = nextJwksUri();
    const downgraded = new URL(jwksUri);

    downgraded.protocol = 'http:';

    // Same host, so the cross-host rule does not catch this one. Plain http is
    // a key set anyone on the path can replace, and a replaced key set is a
    // signature check that passes for anybody.
    const fetchFn = vi.fn(async () => redirectTo(downgraded.toString()));

    await expect(verifyThrough(await signer.sign(), jwksUri, fetchFn)).rejects.toThrow(/signing key/);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a key set on a host that resolves somewhere private', async () => {
    const signer = await createSigner('key-1');
    const fetchFn = vi.fn(async () => keySet([signer.publicJwk]));

    await expect(
      verifyThrough(await signer.sign(), 'https://keys.internal.example/1/jwks.json', fetchFn, {
        'keys.internal.example': '127.0.0.1',
      }),
    ).rejects.toThrow(/signing key/);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('checks the address again when the key set is refetched', async () => {
    const signer = await createSigner('key-1');
    const unknown = await createSigner('key-2');
    const jwksUri = 'https://keys.rebound.example/jwks.json';

    const fetchFn = vi.fn(async () => keySet([signer.publicJwk]));
    const addresses: Record<string, string> = {};

    const verify = async (idToken: string) =>
      verifyIdToken({
        idToken,
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri,
        advertisedSigningAlgorithms: ALGORITHMS,
        now,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        fetchFn: fetchFn as unknown as typeof fetch,
        lookup: lookupWith(addresses),
      });

    vi.useFakeTimers({ toFake: ['Date'] });

    expect((await verify(await signer.sign())).sub).toBe('a-stable-subject');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // The name is repointed after the discovery document was read and after the
    // first fetch. A check that ran once, at discovery, would never see this.
    addresses['keys.rebound.example'] = '169.254.169.254';
    passTheCooldown();

    await expect(verify(await unknown.sign())).rejects.toThrow(/signing key/);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('the key set without an injected fetch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fetches through the pinned transport, connecting to the address the lookup returned', async () => {
    // `.invalid` never resolves, so the key set arrives only if the request
    // went to the checked address. A fallback to the global fetch would fail
    // to resolve the name and the token would not verify. The local authority
    // setting lets the check accept loopback and http.
    vi.stubEnv('NEXT_PRIVATE_OIDC_ALLOW_LOCAL_AUTHORITY', 'true');

    const signer = await createSigner('key-pinned');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [signer.publicJwk] }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address() as AddressInfo;

      const claims = await verifyIdToken({
        idToken: await signer.sign(),
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: `http://keys.invalid:${port}/jwks.json`,
        advertisedSigningAlgorithms: ALGORITHMS,
        now,
        lookup: async () => ['127.0.0.1'],
      });

      expect(claims.sub).toBe('a-stable-subject');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
