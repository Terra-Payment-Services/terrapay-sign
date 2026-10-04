import { AppError } from '@documenso/lib/errors/app-error';
import {
  type AddressLookup,
  assertUrlIsPubliclyFetchable,
  readCappedBody,
  systemLookup,
} from '@documenso/lib/server-only/http/guarded-fetch';
import { type PinnedTransport, pinnedFetch } from '@documenso/lib/server-only/http/pinned-fetch';

import { AuthenticationErrorCode } from '../errors/error-codes';
import { authorityAddressPolicy } from './open-id';

/**
 * Redeeming an authorization code, on terms this codebase sets.
 *
 * `arctic` did this until now, and it does it well enough. What it does not
 * offer is any way in: `OAuth2Client.validateAuthorizationCode` builds a
 * `Request` and hands it to the global `fetch`, with no fetch parameter, no
 * dispatcher and no redirect setting. Read `node_modules/arctic/dist/client.js`
 * and `request.js` and there is nothing to pass.
 *
 * That matters because `token_endpoint` comes out of a discovery document, and
 * for the enterprise SSO portal the document is at a URL an organisation
 * manager typed. Its address is checked when discovery is read. Left to the
 * default, fetch then follows whatever the endpoint answers with, and a 307 or
 * 308 replays the POST body at the hop's target. The body carries the
 * authorization code and the PKCE verifier, which is a live credential for the
 * few seconds before it is redeemed, and the request itself becomes a POST from
 * inside the network to an address the hop chose.
 *
 * The client secret is not in the body. Arctic sends it as HTTP Basic, and
 * fetch strips Authorization on a cross-origin hop, so that one is already
 * covered by the standard. The code, the verifier and the redirect target are
 * not.
 *
 * So the exchange is a form POST this file makes itself. It is a dozen lines of
 * request building and a JSON parse, which is a smaller thing to own than a
 * fork of the library, and `packages/lib/server-only/email/microsoft-graph-mail.ts`
 * already owns the same shape of request for the same reason. Arctic stays for
 * the authorization URL and for the CSC signing client.
 *
 * What it keeps from arctic, because callers depend on it: the 400 and 401
 * error-response shape, with the `error` code in the message; `expires_in` read
 * as a number and turned into a wall-clock expiry; and a missing or malformed
 * field failing the sign in rather than being guessed at.
 */

/** Ceiling on the whole exchange, request and body read together. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 10 * 1000;

/**
 * Cap on the token response.
 *
 * An ID token from Entra with a long group claim is a few kilobytes. This sits
 * far above that and still stops a hostile endpoint streaming indefinitely.
 */
const TOKEN_RESPONSE_MAX_BYTES = 256 * 1024;

export type ExchangedTokens = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  idToken: string;
};

export type ExchangeAuthorizationCodeOptions = {
  /** `token_endpoint` from the authority's discovery document. */
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The code the authority sent back to the callback. */
  code: string;
  /** The PKCE verifier held in a cookie since the authorize request. */
  codeVerifier: string;
  /** Replaces the outbound fetch. Overridden in tests. */
  fetchFn?: typeof fetch;
  /** Replaces DNS resolution for the address check. Overridden in tests. */
  lookup?: AddressLookup;
  /** @default 10000, covering the lookup, the request and the body read. Overridden in tests. */
  timeoutMs?: number;
};

const refuse = (message: string) => new AppError(AuthenticationErrorCode.InvalidRequest, { message });

const exchangeContext = () => ({
  subject: 'token endpoint',
  createError: refuse,
  ...authorityAddressPolicy(),
});

/**
 * HTTP Basic client authentication, spelled the way arctic spells it.
 *
 * RFC 6749 section 2.3.1 asks for the id and the secret to be form-urlencoded
 * before they are joined and base64ed. Arctic does not do that, and the
 * deployment authenticates against Entra today, so copying arctic keeps a
 * working sign in working. A secret carrying a character that needs encoding
 * would have been broken before this change too.
 */
const basicCredentials = (clientId: string, clientSecret: string): string =>
  Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

/** Pulls the `error` code out of an error response, when there is one to pull. */
const describeOAuthError = (payload: unknown): string => {
  if (typeof payload !== 'object' || payload === null) {
    return 'no error code';
  }

  const { error, error_description: description } = payload as Record<string, unknown>;

  if (typeof error !== 'string') {
    return 'no error code';
  }

  return typeof description === 'string' ? `${error}: ${description}` : error;
};

const parseJson = (body: Uint8Array, host: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw refuse(`The token endpoint at ${host} answered with something that is not JSON`);
  }
};

const readString = (payload: unknown, field: string, host: string): string => {
  const value = (payload as Record<string, unknown>)[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw refuse(`The token endpoint at ${host} returned no ${field}`);
  }

  return value;
};

/**
 * Redeem an authorization code for tokens.
 *
 * @throws {AppError} when the endpoint is not one we will post to, when it
 *   redirects, when it refuses the code, or when what comes back is missing a
 *   field the sign in reads.
 */
export const exchangeAuthorizationCode = async (
  options: ExchangeAuthorizationCodeOptions,
): Promise<ExchangedTokens> => {
  const { tokenEndpoint, clientId, clientSecret, redirectUri, code, codeVerifier } = options;

  const fetchFn: PinnedTransport = options.fetchFn ?? pinnedFetch;
  const lookup = options.lookup ?? systemLookup;
  const timeoutMs = options.timeoutMs ?? TOKEN_EXCHANGE_TIMEOUT_MS;

  let endpoint: URL;

  try {
    endpoint = new URL(tokenEndpoint);
  } catch {
    throw refuse(`The identity provider published a token_endpoint that is not a URL: ${tokenEndpoint}`);
  }

  // Checked again here rather than trusting the check discovery did. Discovery
  // may have run against a document fetched some time ago, and a name can be
  // repointed between the two. The request below connects only to the
  // addresses checked here, so the name cannot be repointed after it either.
  //
  // The deadline starts before the lookup, so a resolver that never answers
  // cannot hold the sign in open past it.
  const signal = AbortSignal.timeout(timeoutMs);
  let addresses: string[];

  try {
    addresses = await assertUrlIsPubliclyFetchable(endpoint, lookup, exchangeContext(), signal);
  } catch (error) {
    if (signal.aborted) {
      throw refuse(`The token request to ${endpoint.host} timed out after ${timeoutMs}ms resolving the host`);
    }

    throw error;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  let response: Response;

  try {
    response = await fetchFn(
      endpoint.toString(),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          authorization: `Basic ${basicCredentials(clientId, clientSecret)}`,
        },
        body: body.toString(),
        // Nothing is followed. A token endpoint answers with the tokens, so a 3xx
        // means something took the request on the way out, and the request is a
        // live authorization code.
        redirect: 'manual',
        signal,
      },
      addresses,
    );
  } catch (error) {
    throw refuse(
      `The token request to ${endpoint.host} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);

    throw refuse(
      `Refusing a redirect from the token endpoint at ${endpoint.host} to ` +
        `${response.headers.get('location') ?? 'an unnamed location'}`,
    );
  }

  if (response.status === 400 || response.status === 401) {
    const payload = parseJson(
      await readCappedBody(response, TOKEN_RESPONSE_MAX_BYTES, exchangeContext()),
      endpoint.host,
    );

    throw refuse(
      `The token endpoint at ${endpoint.host} refused the authorization code (${describeOAuthError(payload)})`,
    );
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);

    throw refuse(`The token endpoint at ${endpoint.host} answered HTTP ${response.status}`);
  }

  const payload = parseJson(await readCappedBody(response, TOKEN_RESPONSE_MAX_BYTES, exchangeContext()), endpoint.host);

  if (typeof payload !== 'object' || payload === null) {
    throw refuse(`The token endpoint at ${endpoint.host} answered with JSON that is not an object`);
  }

  const expiresIn = (payload as Record<string, unknown>).expires_in;

  if (typeof expiresIn !== 'number') {
    throw refuse(`The token endpoint at ${endpoint.host} returned no expires_in`);
  }

  return {
    accessToken: readString(payload, 'access_token', endpoint.host),
    accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
    idToken: readString(payload, 'id_token', endpoint.host),
  };
};
