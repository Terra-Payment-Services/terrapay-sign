import { AppError } from '@documenso/lib/errors/app-error';
import { type AddressLookup, guardedFetch, systemLookup } from '@documenso/lib/server-only/http/guarded-fetch';
import type { FetchImplementation, JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify } from 'jose';

import { AuthenticationErrorCode } from '../errors/error-codes';
import { CLOCK_SKEW_SECONDS } from './id-token-claims';
import { authorityAddressPolicy } from './open-id';

/**
 * Checking that an ID token was signed by the authority we sent the person to.
 *
 * The keys come from the `jwks_uri` in the authority's own discovery document,
 * so nothing about the signing key is written down here. Rotate a key at the
 * authority and this follows, because the only thing pinned locally is which
 * discovery URL to believe.
 *
 * `jose` does the cryptography. It arrived in the tree with `@documenso/lib`
 * and it is the library `createRemoteJWKSet` belongs to, so there is no new
 * dependency to weigh.
 */

/** How long a fetched key set is used before it is refreshed. */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The floor on how often an unrecognised `kid` may cause a refetch.
 *
 * A token naming a key we have not seen makes us refetch the key set, which is
 * what lets a rotation at the authority take effect without a restart. Left
 * ungoverned it is also a way to make us hammer the authority, since anyone who
 * can reach the callback can present a token with an invented `kid`. Within
 * this window of the last successful fetch the unknown key is refused from the
 * cache and no request goes out, so the worst an attacker can drive is one
 * fetch every thirty seconds.
 */
const JWKS_REFETCH_COOLDOWN_MS = 30 * 1000;

/** How long to wait on the JWKS endpoint before giving up on the sign in. */
const JWKS_FETCH_TIMEOUT_MS = 5 * 1000;

/**
 * Cap on a key set.
 *
 * Microsoft's runs to a few kilobytes and holds six keys. A ceiling well above
 * any real one still stops an authority streaming the server out of memory.
 */
const JWKS_MAX_BYTES = 128 * 1024;

/** Raised when the key set is somewhere we will not fetch from. */
export class JwksFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksFetchError';
  }
}

const jwksFetchContext = () => ({
  subject: 'JWKS',
  createError: (message: string) => new JwksFetchError(message),
  isOwnError: (error: unknown) => error instanceof JwksFetchError,
  ...authorityAddressPolicy(),
});

/**
 * The fetch that goes out and gets the key set.
 *
 * `jwks_uri` is checked once, when the discovery document that published it is
 * read. That check is a long way from this request. The key set is fetched
 * lazily, refreshed every ten minutes for the life of the process, and fetched
 * again whenever a token names a key we have not seen, so a name that resolved
 * to a public address at discovery time and resolves to 169.254.169.254 an hour
 * later is fetched with nobody looking. Going through `guardedFetch` re-resolves
 * the host on every one of those requests and re-checks each redirect hop.
 *
 * jose does refuse a redirect on its own: it passes `redirect: 'manual'` and
 * insists on a 200. That is a choice inside a library which older majors made
 * differently, and it is not the kind of thing an upgrade announces. Owning the
 * rule here means an upgrade cannot quietly take it away.
 *
 * jose's own abort signal is dropped, because `guardedFetch` runs the same
 * five-second budget over the request and the body read together.
 *
 * @param fetchFn - Replaces the outbound fetch. Injected by the tests.
 * @param lookup - Replaces DNS resolution. Injected by the tests.
 */
export const createGuardedJwksFetch = (fetchFn: typeof fetch, lookup: AddressLookup): FetchImplementation => {
  return async (url, options) => {
    const headers: Record<string, string> = {};

    options.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const body = await guardedFetch({
      url,
      method: 'GET',
      headers,
      timeoutMs: JWKS_FETCH_TIMEOUT_MS,
      maxResponseBytes: JWKS_MAX_BYTES,
      fetchFn,
      lookup,
      ...jwksFetchContext(),
    });

    // jose wants a Response and reads only the status and the JSON body from
    // it, so this is the shape it expects rather than a copy of what came back.
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
};

/**
 * The signature algorithms we will verify an ID token with.
 *
 * Every one is asymmetric. A JWKS carries public keys, and a public key is
 * published, so an HMAC algorithm verified against one would accept a token
 * signed by anybody who downloaded it. That is the RS/HS confusion attack, and
 * the guard against it is refusing the whole HMAC family here rather than
 * trusting the token's header to be honest about what it is.
 *
 * `none` is absent for the same reason it has always been a bad idea.
 */
const VERIFIABLE_ALGORITHMS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
]);

/**
 * Narrow what the authority advertises down to what we are willing to verify.
 *
 * The allowlist handed to `jwtVerify` has to come from somewhere other than the
 * token, because a token that chooses its own algorithm chooses whether it gets
 * checked at all. It comes from `id_token_signing_alg_values_supported` in the
 * discovery document, intersected with the asymmetric algorithms above.
 *
 * @param advertised - `id_token_signing_alg_values_supported` as published by
 *   the authority.
 * @throws {AppError} when the authority advertises nothing we can verify, which
 *   means tokens from it cannot be trusted and the sign in must stop.
 */
export const pinSigningAlgorithms = (advertised: string[]): string[] => {
  const pinned = advertised.filter((algorithm) => VERIFIABLE_ALGORITHMS.has(algorithm));

  if (pinned.length === 0) {
    throw new AppError(AuthenticationErrorCode.NotSetup, {
      message:
        'The identity provider advertises no signature algorithm that can be verified against a published key set',
    });
  }

  return pinned;
};

/**
 * The key sets in use, one per `jwks_uri`.
 *
 * `createRemoteJWKSet` holds the fetched keys and the cooldown clock inside the
 * object it returns. Building a fresh one per sign in would throw both away, so
 * every callback would fetch the key set and the cooldown would never govern
 * anything. The map is what makes the caching above real.
 */
const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * The fetch is captured by the first call for a given URL and kept, along with
 * the keys and the cooldown clock. In the running server there is one fetch and
 * the point does not arise. A test that wants a fetch of its own needs a URL of
 * its own, which is what `nextJwksUri` in the tests is for.
 */
const resolveJwkSet = (jwksUri: string, fetchImplementation: FetchImplementation) => {
  const existing = jwkSets.get(jwksUri);

  if (existing) {
    return existing;
  }

  const created = createRemoteJWKSet(new URL(jwksUri), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_REFETCH_COOLDOWN_MS,
    timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
    [customFetch]: fetchImplementation,
  });

  jwkSets.set(jwksUri, created);

  return created;
};

/** The jose error code where there is one, so a log line says what went wrong. */
const failureCode = (error: unknown): string => {
  if (error instanceof joseErrors.JOSEError) {
    return error.code;
  }

  return error instanceof Error ? error.name : 'UNKNOWN';
};

const asAuthenticationError = (error: unknown, cameFromKeyLookup: boolean): AppError => {
  if (cameFromKeyLookup) {
    // Separated out so an operator reading the log knows whether to go and
    // look at the authority's JWKS endpoint. A key set that cannot be fetched
    // lands here, as does one that parses but holds nothing matching the kid
    // the token names.
    return new AppError(AuthenticationErrorCode.InvalidRequest, {
      message: `The signing key for the identity token could not be resolved (${failureCode(error)})`,
    });
  }

  return new AppError(AuthenticationErrorCode.InvalidRequest, {
    message: `The identity token failed verification (${failureCode(error)})`,
  });
};

export type VerifyIdTokenOptions = {
  /** The compact JWS as it came back from the token endpoint. */
  idToken: string;
  /** The `issuer` the discovery document publishes. `iss` must equal it. */
  issuer: string;
  /** The application the token must have been minted for. */
  audience: string;
  /** The `jwks_uri` from the same discovery document. */
  jwksUri: string;
  /** `id_token_signing_alg_values_supported` from the same discovery document. */
  advertisedSigningAlgorithms: string[];
  /** Overridden in tests. */
  now?: Date;
  /**
   * Replaces the whole retrieval of the key set, address guard included. Left
   * undefined outside the tests, which use it to serve a key set without a
   * network when the guard is not what is under test.
   */
  fetchImplementation?: FetchImplementation;
  /**
   * Replaces the outbound fetch underneath the address guard. Overridden in
   * tests, which use it to answer a guarded request with a redirect.
   */
  fetchFn?: typeof fetch;
  /** Replaces DNS resolution for the address checks. Overridden in tests. */
  lookup?: AddressLookup;
};

/**
 * Verify an ID token's signature and return its payload.
 *
 * The algorithm allowlist, the issuer and the key set all come from the
 * discovery document of the authority named in configuration, which is why a
 * deployment with no OIDC configuration cannot reach this code and quietly skip
 * it. Discovery is fetched before this call and fails loudly when it is absent.
 *
 * @throws {AppError} when the signature does not verify, when the key cannot be
 *   resolved, or when `iss`, `aud`, `exp` or `nbf` disagree with the authority.
 */
export const verifyIdToken = async (options: VerifyIdTokenOptions): Promise<Record<string, unknown>> => {
  const { idToken, issuer, audience, jwksUri, advertisedSigningAlgorithms, now, fetchImplementation } = options;

  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const lookup = options.lookup ?? systemLookup;

  const algorithms = pinSigningAlgorithms(advertisedSigningAlgorithms);
  const keys = resolveJwkSet(jwksUri, fetchImplementation ?? createGuardedJwksFetch(fetchFn, lookup));

  // Tagging failures as they leave the key lookup, because from outside
  // `jwtVerify` a JWKS endpoint returning a 500 and a forged signature are the
  // same rejected promise, and they call for different people to be woken up.
  let cameFromKeyLookup = false;

  const getKey: JWTVerifyGetKey = async (header, token) => {
    try {
      return await keys(header, token);
    } catch (error) {
      cameFromKeyLookup = true;

      throw error;
    }
  };

  try {
    const { payload } = await jwtVerify(idToken, getKey, {
      algorithms,
      issuer,
      audience,
      clockTolerance: CLOCK_SKEW_SECONDS,
      currentDate: now,
    });

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return payload as Record<string, unknown>;
  } catch (error) {
    throw asAuthenticationError(error, cameFromKeyLookup);
  }
};
