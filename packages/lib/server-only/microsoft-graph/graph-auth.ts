import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';

/**
 * App-only (OAuth 2.0 client credentials) authentication for Microsoft Graph,
 * shared by every feature on this instance that talks to Graph.
 *
 * This was extracted from the Entra directory reconciliation client so that the
 * SharePoint archive does not open a second token endpoint with its own cache.
 * One cache keyed on tenant and client id means two features sharing an app
 * registration also share a token, and a rotated secret is picked up by both at
 * the same moment.
 *
 * Neither the client secret nor the bearer token is ever logged, returned in a
 * result, or included in a thrown error message. Errors carry the HTTP status
 * and the Graph error code only, because a Graph error body can echo the
 * request and the request carries the secret.
 */

const ENTRA_LOGIN_BASE_URL = 'https://login.microsoftonline.com';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/**
 * Refresh the cached token this long before it actually expires, so a run that
 * starts just under the wire does not lose its token halfway through paging or
 * halfway through a chunked upload.
 */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * How long the token request, its body included, may take before it is
 * abandoned, so a login endpoint that never answers fails the run rather than
 * holding it. The same bound as a Graph page.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 60_000;

export type MicrosoftGraphCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export type GraphFetchFn = typeof fetch;

const ZGraphTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const tokenCache = new Map<string, CachedToken>();

/**
 * Drop every cached access token. Exported for tests and for the rare case
 * where credentials are rotated inside a running process.
 */
export const clearGraphTokenCache = () => {
  tokenCache.clear();
};

/**
 * The shape of a Graph error code, such as `Authorization_RequestDenied` or
 * `itemNotFound`. Anything else in the code field is not a code Graph defines,
 * and could be an echoed token or secret.
 */
const GRAPH_ERROR_CODE_SHAPE = /^[A-Za-z_]{1,64}$/;

/**
 * Pull the Graph error code out of an error response body without echoing the
 * body itself, which keeps request identifiers and any echoed headers out of
 * the logs. A code that does not have the shape of a Graph error code is
 * reported as `unrecognised` rather than copied.
 */
export const readGraphErrorCode = async (response: Response): Promise<string> => {
  try {
    const body: unknown = await response.json();

    const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(body);

    if (!parsed.success) {
      return 'unknown';
    }

    return GRAPH_ERROR_CODE_SHAPE.test(parsed.data.error.code) ? parsed.data.error.code : 'unrecognised';
  } catch {
    return 'unparseable';
  }
};

export type GetGraphAccessTokenOptions = {
  credentials: MicrosoftGraphCredentials;
  /** Origin of the token endpoint. Defaults to Microsoft's. */
  loginBaseUrl?: string;
  fetchFn?: GraphFetchFn;
  now?: () => number;
};

/**
 * Acquire an app-only access token for Microsoft Graph, reusing the cached one
 * until it is within {@link TOKEN_REFRESH_SKEW_MS} of expiry.
 */
export const getGraphAccessToken = async ({
  credentials,
  loginBaseUrl = ENTRA_LOGIN_BASE_URL,
  fetchFn = fetch,
  now = () => Date.now(),
}: GetGraphAccessTokenOptions): Promise<string> => {
  // The token endpoint's path takes the tenant as a bare GUID (or a domain
  // name). A configured ` {6F1C...} ` is the same tenant, so it is reduced to
  // that form before it reaches the path or the cache key.
  const tenantId = credentials.tenantId
    .trim()
    .replace(/^\{(.*)\}$/, '$1')
    .trim()
    .toLowerCase();

  const cacheKey = `${loginBaseUrl}:${tenantId}:${credentials.clientId}`;

  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now()) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: 'client_credentials',
    scope: GRAPH_SCOPE,
  });

  const response = await fetchFn(`${loginBaseUrl}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    // The signal also bounds reading the response body below.
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The status alone is enough to diagnose this (401 means bad credentials,
    // 400 means a malformed tenant). The response body can echo the request,
    // so it is deliberately not included.
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: `Entra token request failed with status ${response.status}`,
    });
  }

  const parsed = ZGraphTokenResponseSchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new AppError(AppErrorCode.SCHEMA_FAILED, {
      message: 'Entra token response did not match the expected shape',
    });
  }

  tokenCache.set(cacheKey, {
    accessToken: parsed.data.access_token,
    expiresAtMs: now() + parsed.data.expires_in * 1000,
  });

  return parsed.data.access_token;
};
