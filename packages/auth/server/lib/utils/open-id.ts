import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import {
  type AddressLookup,
  assertUrlIsPubliclyFetchable,
  type GuardedFetchContext,
  guardedFetch,
  systemLookup,
} from '@documenso/lib/server-only/http/guarded-fetch';
import { env } from '@documenso/lib/utils/env';
import { z } from 'zod';

/**
 * The discovery fields we need, and the reason the signing ones are required.
 *
 * `issuer`, `jwks_uri` and `id_token_signing_alg_values_supported` are all
 * marked REQUIRED by OpenID Connect Discovery, and without them an ID token
 * from this authority cannot be verified at all. Parsing them as optional would
 * hand the callback an authority whose tokens we can only guess about, so a
 * provider that omits any of them fails here, at the first request, rather than
 * halfway through somebody's sign in.
 */
const ZOpenIdConfigurationSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string().url(),
  id_token_signing_alg_values_supported: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

type OpenIdConfiguration = z.infer<typeof ZOpenIdConfigurationSchema>;

export type GetOpenIdConfigurationOptions = {
  requiredScopes?: string[];
  /** Replaces the fetch used to retrieve the document. Overridden in tests. */
  fetchFn?: typeof fetch;
  /** Replaces DNS resolution for the address checks. Overridden in tests. */
  lookup?: AddressLookup;
};

/** Raised for every refusal in this file, so a caller can catch one type. */
export class OpenIdDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenIdDiscoveryError';
  }
}

/** How long to wait on the whole discovery exchange before giving up. */
const DISCOVERY_TIMEOUT_MS = 5 * 1000;

/**
 * Cap on the discovery document.
 *
 * Real documents run to a few kilobytes. Microsoft's is around 2 KB and
 * Google's is smaller. A generous ceiling still stops an authority streaming
 * the server out of memory.
 */
const DISCOVERY_MAX_BYTES = 256 * 1024;

/**
 * Whether this process may talk to an authority on a local or private address.
 *
 * A developer running Keycloak on their own machine needs this, and until now
 * it was granted by letting `localhost` and `127.0.0.1` through a hostname
 * string test. That reasoning was about eavesdropping, and it missed who
 * chooses the URL. An organisation manager types `wellKnownUrl` into the
 * enterprise SSO portal, so the address at the far end is attacker influenced
 * and a loopback exemption turns the production server into a probe for
 * whatever else is listening on it. The string test also missed `[::1]`,
 * `0.0.0.0`, `127.0.0.2` and the decimal and hex spellings of the same
 * addresses.
 *
 * So the decision moved off the URL and onto the environment. Opening it needs
 * a variable somebody set on purpose, on a deployment that is not running as
 * NODE_ENV production and is served over plain http. sign.example.com fails
 * both of those environment conditions on its own, and the second is there to
 * cover a deployment that forgot to set NODE_ENV at all.
 */
const allowsLocalAuthority = (): boolean =>
  env('NODE_ENV') !== 'production' &&
  !NEXT_PUBLIC_WEBAPP_URL().startsWith('https://') &&
  env('NEXT_PRIVATE_OIDC_ALLOW_LOCAL_AUTHORITY') === 'true';

/**
 * Which schemes and addresses this process will talk to an authority over.
 *
 * Discovery runs over https. An authority reached over plain http is one that
 * anyone on the path can impersonate, and every claim we then read about who is
 * signing in came from them. The escape hatch above relaxes this for a
 * developer working locally.
 *
 * Exported because the same policy has to hold for the other two requests the
 * sign in makes to the same authority, the token exchange and the key set
 * fetch. One authority reached three ways under two policies would mean the
 * strictest of them decides nothing.
 */
export const authorityAddressPolicy = (): Pick<GuardedFetchContext, 'allowedProtocols' | 'allowLocalAddresses'> => ({
  allowedProtocols: allowsLocalAuthority() ? (['http:', 'https:'] as const) : (['https:'] as const),
  allowLocalAddresses: allowsLocalAuthority(),
});

const discoveryFetchContext = () => ({
  subject: 'OpenID discovery',
  createError: (message: string) => new OpenIdDiscoveryError(message),
  isOwnError: (error: unknown) => error instanceof OpenIdDiscoveryError,
  ...authorityAddressPolicy(),
});

/**
 * The paths a discovery document is published at.
 *
 * The first is OpenID Connect Discovery's. The second is what RFC 8414 defines
 * for a plain OAuth authorisation server, and some providers answer on both.
 */
const WELL_KNOWN_PATHS = ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server'];

/**
 * The issuer paths that a retrieval URL implies, under each standard form.
 *
 * RFC 8414 section 3.1 defines two placements for the well-known segment.
 * Either it is appended to the issuer, which is what OpenID Connect Discovery
 * does, or it is inserted between the host and the issuer's path, which is the
 * form RFC 8414 prefers. Both are accepted, so both spellings are derived here
 * and the caller matches the issuer against whichever fits.
 *
 * An empty array means the URL carries no well-known segment at all, which is
 * not a shape the issuer can be bound to.
 */
const impliedIssuerPaths = (retrievedPath: string): string[] => {
  const paths: string[] = [];

  for (const wellKnownPath of WELL_KNOWN_PATHS) {
    if (retrievedPath.endsWith(wellKnownPath)) {
      paths.push(retrievedPath.slice(0, -wellKnownPath.length));
    }

    if (retrievedPath.startsWith(wellKnownPath)) {
      paths.push(retrievedPath.slice(wellKnownPath.length));
    }
  }

  return paths;
};

const pathSegments = (path: string): string[] => path.split('/').filter((segment) => segment.length > 0);

/**
 * Compare two paths, allowing the tenant segment to have been resolved.
 *
 * The standards want these identical. Microsoft does not publish them that way,
 * which was established by fetching the live documents rather than by reading
 * the documentation. On `login.microsoftonline.com`, both the `common` and the
 * `organizations` authorities answer with the literal template
 * `.../{tenantid}/v2.0`, placeholder braces and all. An authority named by
 * verified domain answers with the directory's GUID instead, so
 * `/contoso.com/v2.0` gives back `/00000000-0000-0000-0000-000000000001/v2.0`,
 * and `/consumers` gives back `/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0`.
 * Only an authority written as its GUID matches character for character.
 *
 * Demanding an identical path would therefore lock out every member of staff at
 * a deployment configured by domain name, which is the common way to write it.
 * So one segment is allowed to differ, and the host, the port, the scheme, the
 * segment count and every other segment must still agree.
 *
 * That keeps what the check is for. Metadata impersonation is a document at one
 * authority claiming to be a different authority, and the origin comparison the
 * caller does is what refuses it. Within a single origin, an attacker who can
 * publish a document at one path can usually publish it at the path that
 * matches exactly, so path-level exactness was never what stood in their way.
 */
const matchesAllowingTenantSubstitution = (issuerPath: string, impliedPath: string): boolean => {
  const issuerSegments = pathSegments(issuerPath);
  const impliedSegments = pathSegments(impliedPath);

  if (issuerSegments.length !== impliedSegments.length) {
    return false;
  }

  const differences = issuerSegments.filter((segment, index) => segment !== impliedSegments[index]).length;

  return differences <= 1;
};

/**
 * Bind the issuer a document claims to the URL the document came from.
 *
 * RFC 8414 section 3.3 and OpenID Connect Discovery section 4.3 both require
 * this, and they require it for one reason. A discovery document is fetched
 * from wherever configuration points, and it names its own `issuer` and its own
 * `jwks_uri`. Unbound, a document at an attacker's host can claim to be
 * somebody else's authority while publishing keys the attacker holds. Every
 * token minted with those keys then verifies, because `verifyIdToken` is told
 * to expect exactly the issuer this document named. Combined with the account
 * linking by email address further down the callback, that is a takeover of any
 * account whose address the attacker knows.
 *
 * @param issuer - The `issuer` field as published in the document.
 * @param wellKnownUrl - The URL the document was retrieved from.
 * @throws {OpenIdDiscoveryError} when the issuer does not correspond to the
 *   retrieval URL, which means the document is speaking for somebody else.
 */
export const assertIssuerMatchesRetrievalUrl = (issuer: string, wellKnownUrl: string): void => {
  let issuerUrl: URL;

  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new OpenIdDiscoveryError(`The identity provider published an issuer that is not a URL: ${issuer}`);
  }

  let retrievedUrl: URL;

  try {
    retrievedUrl = new URL(wellKnownUrl);
  } catch {
    throw new OpenIdDiscoveryError(`The configured discovery URL is not a URL: ${wellKnownUrl}`);
  }

  // RFC 8414 section 2: an issuer identifier carries no query and no fragment.
  // Allowing either would let one issuer be written several ways, and the
  // comparison below would then depend on which spelling was used.
  if (issuerUrl.search !== '' || issuerUrl.hash !== '') {
    throw new OpenIdDiscoveryError(`The identity provider published an issuer carrying a query or fragment: ${issuer}`);
  }

  // A scheme with no host behind it, such as `urn:`, has an opaque origin that
  // cannot be compared with anything. OpenID Connect Discovery wants the issuer
  // to be an https URL, and the origin comparison below is what enforces the
  // scheme, since the document was retrieved over https.
  if (issuerUrl.origin === 'null') {
    throw new OpenIdDiscoveryError(
      `The identity provider published an issuer that is not an http or https URL: ${issuer}`,
    );
  }

  // The part that stops impersonation. Scheme, host and port together.
  if (issuerUrl.origin !== retrievedUrl.origin) {
    throw new OpenIdDiscoveryError(
      `The identity provider at ${retrievedUrl.origin} published an issuer belonging to ${issuerUrl.origin}. ` +
        'A discovery document may only speak for the host it was served from.',
    );
  }

  // The retrieved URL's query is ignored. Microsoft documents an `?appid=`
  // parameter on the common endpoint that returns application-specific keys,
  // and that is the same document either way.
  const implied = impliedIssuerPaths(retrievedUrl.pathname);

  if (implied.length === 0) {
    throw new OpenIdDiscoveryError(
      `The discovery URL ${wellKnownUrl} does not carry a well-known path, so the issuer cannot be bound to it. ` +
        `Use one of: ${WELL_KNOWN_PATHS.join(', ')}.`,
    );
  }

  if (!implied.some((impliedPath) => matchesAllowingTenantSubstitution(issuerUrl.pathname, impliedPath))) {
    throw new OpenIdDiscoveryError(
      `The identity provider published the issuer ${issuer}, which does not correspond to the document ` +
        `retrieved from ${wellKnownUrl}.`,
    );
  }
};

/**
 * Refuse an endpoint the discovery document points at.
 *
 * Every URL in the document is chosen by whoever set `wellKnownUrl`, which for
 * the enterprise portal is an organisation manager rather than an operator.
 * Three of them are fetched or posted to, so each is checked for scheme and for
 * a publicly routable address before anything is sent to it.
 *
 * The token endpoint is the one worth naming. It receives the client secret as
 * HTTP Basic credentials, and its body carries a live authorization code with
 * its PKCE verifier. An earlier note here said the secret was in the body; it
 * is in the header, which is why fetch would strip it on a cross-origin
 * redirect while replaying the code.
 *
 * @param rawUrl - The endpoint as published in the document.
 * @param role - The field name, so an operator reading the log knows which one.
 * @param lookup - How to resolve a hostname. Injected by the tests.
 * @throws {OpenIdDiscoveryError} when the endpoint is not one we will contact.
 */
const assertEndpointIsSafe = async (rawUrl: string, role: string, lookup: AddressLookup): Promise<void> => {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new OpenIdDiscoveryError(`The identity provider published a ${role} that is not a URL: ${rawUrl}`);
  }

  try {
    await assertUrlIsPubliclyFetchable(url, lookup, discoveryFetchContext());
  } catch (error) {
    throw new OpenIdDiscoveryError(
      `The identity provider published a ${role} we will not contact. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
};

/**
 * Fetch and check an authority's discovery document.
 *
 * @param wellKnownUrl - Where to fetch from. Operator configuration for the
 *   built-in providers, and organisation manager input for the enterprise
 *   portal, which is why it is treated as untrusted either way.
 * @param options - Required scopes, and the seams the tests inject through.
 * @throws {OpenIdDiscoveryError} when the document cannot be fetched safely,
 *   does not parse, speaks for an issuer it has no right to, points an endpoint
 *   somewhere we will not go, or omits a scope the sign in needs.
 */
export const getOpenIdConfiguration = async (
  wellKnownUrl: string,
  options: GetOpenIdConfigurationOptions = {},
): Promise<OpenIdConfiguration> => {
  const fetchFn = options.fetchFn;
  const lookup = options.lookup ?? systemLookup;

  const body = await guardedFetch({
    url: wellKnownUrl,
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    maxResponseBytes: DISCOVERY_MAX_BYTES,
    fetchFn,
    lookup,
    ...discoveryFetchContext(),
  });

  let rawConfig: unknown;

  try {
    rawConfig = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new OpenIdDiscoveryError(`The discovery document at ${wellKnownUrl} is not JSON`);
  }

  const config = ZOpenIdConfigurationSchema.parse(rawConfig);

  // Validate required endpoints
  if (!config.authorization_endpoint) {
    throw new OpenIdDiscoveryError('Missing authorization_endpoint in OIDC configuration');
  }

  assertIssuerMatchesRetrievalUrl(config.issuer, wellKnownUrl);

  // The token endpoint first, because that is the one the client secret goes
  // to. A manager who edits only `wellKnownUrl` keeps the stored secret, and
  // without this the callback would post it, under HTTP Basic, wherever the new
  // document said. The portal now also refuses that edit without a fresh
  // secret; this is the second of the two locks.
  await assertEndpointIsSafe(config.token_endpoint, 'token_endpoint', lookup);
  await assertEndpointIsSafe(config.jwks_uri, 'jwks_uri', lookup);

  const supportedScopes = config.scopes_supported ?? [];
  const requiredScopes = options.requiredScopes ?? [];

  const unsupportedScopes = requiredScopes.filter((scope) => !supportedScopes.includes(scope));

  if (unsupportedScopes.length > 0) {
    throw new OpenIdDiscoveryError(`Requested scopes not supported by provider: ${unsupportedScopes.join(', ')}`);
  }

  return config;
};
