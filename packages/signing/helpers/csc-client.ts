/**
 * Minimal client for the Cloud Signature Consortium (CSC) API v2.0.
 *
 * This is an independent implementation written from the published CSC API
 * v2.0 specification. It has not been validated against a live trust service
 * provider. See the doc comment on `transports/csc.ts` for the list of things a
 * first integration should check.
 *
 * Only the four calls a server-side sealing session needs are implemented:
 *
 * 1. `POST {base}/oauth2/token`            obtain a service access token
 * 2. `POST {base}/csc/v2/credentials/info` read the certificate chain and key info
 * 3. `POST {base}/csc/v2/credentials/authorize` obtain Signature Activation Data
 * 4. `POST {base}/csc/v2/signatures/signHash`   sign the authorised hashes
 *
 * Transport rules that apply to every call:
 *
 * - the base URL must be https, because the bearer token and the Signature
 *   Activation Data both travel in the clear otherwise
 * - every request carries an abort timeout, so a hung provider cannot wedge a
 *   sealing job for ever
 * - redirects are refused outright rather than followed, which is a stricter
 *   reading than "do not follow redirects to a different host" and avoids
 *   having to trust a redirect chain with a bearer token attached
 * - nothing in this module logs, and no error message ever carries the bearer
 *   token, the Signature Activation Data or the PIN
 */

/** Wall-clock budget for a single provider call. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Longest slice of a token's life we are willing to give back to the clock. */
const MAX_TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Fallback lifetime when a provider omits `expires_in` from the token response. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Digest algorithm OIDs, keyed by the libpdf `DigestAlgorithm` name.
 *
 * These are the NIST hash OIDs under 2.16.840.1.101.3.4.2.
 */
export const DIGEST_ALGORITHM_OIDS = {
  'SHA-256': '2.16.840.1.101.3.4.2.1',
  'SHA-384': '2.16.840.1.101.3.4.2.2',
  'SHA-512': '2.16.840.1.101.3.4.2.3',
} as const;

/** PKCS#1 rsaEncryption, used by CSC providers to mean RSASSA-PKCS1-v1_5. */
export const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';

/** PKCS#1 id-RSASSA-PSS. */
export const OID_RSASSA_PSS = '1.2.840.113549.1.1.10';

/** ANSI X9.62 id-ecPublicKey, a key OID that does not name a digest. */
export const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';

/** ANSI X9.62 ecdsa-with-SHA256, which embeds its digest. */
export const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

/** ANSI X9.62 ecdsa-with-SHA384, which embeds its digest. */
export const OID_ECDSA_WITH_SHA384 = '1.2.840.10045.4.3.3';

/** ANSI X9.62 ecdsa-with-SHA512, which embeds its digest. */
export const OID_ECDSA_WITH_SHA512 = '1.2.840.10045.4.3.4';

/**
 * Anything the CSC provider or the transport got wrong.
 *
 * Carries the HTTP status where there was one, so a caller can tell a
 * configuration problem from a transient provider outage.
 */
export class CscError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CscError';
    this.status = status;
  }
}

export type CscClientOptions = {
  /** Provider base URL, https only, with or without a trailing slash. */
  baseUrl: string;
  /** OAuth client id of the service account registered with the provider. */
  clientId: string;
  /** OAuth client secret of that service account. */
  clientSecret: string;
  /**
   * Per-request timeout in milliseconds.
   *
   * @default 30000
   */
  requestTimeoutMs?: number;
};

/** Certificate chain and key metadata as reported by `credentials/info`. */
export type CscCredentialInfo = {
  /** DER certificates, leaf first, then any intermediates and the root. */
  certificates: Uint8Array[];
  /** Algorithm OIDs the credential's key can be used with. */
  keyAlgorithms: string[];
  /** Key length in bits, when the provider reports one. */
  keyLength?: number;
  /** Key lifecycle state, typically `enabled` or `disabled`. */
  keyStatus?: string;
  /** Named curve OID for an EC key, when the provider reports one. */
  keyCurve?: string;
};

export type CscAuthorizeOptions = {
  credentialID: string;
  /** Base64 digests this authorisation will cover, in signing order. */
  hashes: string[];
  /** PIN protecting the credential, when the provider requires one. */
  pin?: string;
  /** One-time password, when the provider's authorisation mode requires one. */
  otp?: string;
};

export type CscAuthorizeResult = {
  /** Signature Activation Data. Bound to the hashes it was issued for. */
  sad: string;
  /** Lifetime of the SAD in seconds, when the provider reports one. */
  expiresIn?: number;
};

export type CscSignHashOptions = {
  credentialID: string;
  /** Signature Activation Data from a matching `authorize` call. */
  sad: string;
  /** The same base64 digests that were passed to `authorize`. */
  hashes: string[];
  /**
   * Digest OID. Omitted when `signAlgorithmOid` already names a digest, which
   * the specification requires.
   */
  hashAlgorithmOid?: string;
  /** Signature algorithm OID, chosen from what the credential advertises. */
  signAlgorithmOid: string;
};

export type CscClient = {
  getAccessToken: () => Promise<string>;
  getCredentialInfo: (credentialID: string) => Promise<CscCredentialInfo>;
  authorize: (options: CscAuthorizeOptions) => Promise<CscAuthorizeResult>;
  signHash: (options: CscSignHashOptions) => Promise<Uint8Array[]>;
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode a base64 value the provider sent us, rejecting anything malformed.
 *
 * `Buffer.from` silently discards characters it does not recognise, so a
 * corrupted certificate or signature would otherwise arrive as a short buffer
 * rather than an error.
 *
 * @param value - the base64 text
 * @param label - what the value is, used in the error message
 * @returns the decoded bytes
 */
const decodeBase64 = (value: unknown, label: string): Uint8Array => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CscError(`CSC provider returned a ${label} that is not a non-empty string.`);
  }

  const compact = value.replace(/\s+/g, '');

  if (!BASE64_PATTERN.test(compact)) {
    throw new CscError(`CSC provider returned a ${label} that is not valid base64.`);
  }

  const decoded = new Uint8Array(Buffer.from(compact, 'base64'));

  if (decoded.length === 0) {
    throw new CscError(`CSC provider returned an empty ${label}.`);
  }

  return decoded;
};

/**
 * Normalise and validate the configured provider base URL.
 *
 * @param baseUrl - the raw configured value
 * @returns the base URL with any trailing slashes removed
 */
const assertHttpsBaseUrl = (baseUrl: string): string => {
  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CscError(`CSC base URL is not a valid URL: "${baseUrl}".`);
  }

  if (parsed.protocol !== 'https:') {
    throw new CscError(
      `CSC base URL must use https, got "${parsed.protocol.replace(':', '')}". The bearer token and the ` +
        'Signature Activation Data must not travel over an unencrypted link.',
    );
  }

  return baseUrl.replace(/\/+$/, '');
};

/**
 * Pull a human-readable reason out of a provider error body without leaking
 * anything we sent. Only the `error` and `error_description` fields defined by
 * the specification are read; the rest of the body is ignored.
 *
 * @param body - the raw response body
 * @returns a short suffix for the error message, or an empty string
 */
const describeErrorBody = (body: string): string => {
  if (!body) {
    return '';
  }

  try {
    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== 'object' || parsed === null) {
      return '';
    }

    const { error, error_description: description } = parsed as {
      error?: unknown;
      error_description?: unknown;
    };

    const parts = [error, description].filter((part): part is string => typeof part === 'string' && part.length > 0);

    return parts.length > 0 ? ` (${parts.join(': ')})` : '';
  } catch {
    return '';
  }
};

/**
 * Create a CSC API client.
 *
 * The returned client caches the service access token in memory and refreshes
 * it shortly before it expires. It holds no other state; in particular it does
 * not cache Signature Activation Data, which is bound to a specific set of
 * hashes and must be obtained afresh for every signature.
 *
 * @param options - provider base URL and service account credentials
 * @returns a client exposing the four calls a sealing session needs
 * @throws {CscError} if the base URL is missing, malformed or not https
 */
export const createCscClient = ({
  baseUrl,
  clientId,
  clientSecret,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: CscClientOptions): CscClient => {
  const normalisedBaseUrl = assertHttpsBaseUrl(baseUrl);

  let cachedToken: { value: string; expiresAt: number } | null = null;

  const request = async <T>(path: string, init: { body: BodyInit; headers: Record<string, string> }): Promise<T> => {
    let response: Response;

    try {
      response = await fetch(`${normalisedBaseUrl}${path}`, {
        method: 'POST',
        body: init.body,
        headers: { Accept: 'application/json', ...init.headers },
        // Refuse redirects rather than follow them. A 3xx with a bearer token
        // attached is either a provider misconfiguration or an attempt to
        // harvest the token, and neither is worth chasing.
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';

      throw new CscError(`CSC request to ${path} could not be completed: ${reason}.`);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new CscError(
        `CSC request to ${path} was redirected (HTTP ${response.status}). Redirects are refused because the ` +
          'request carries credentials.',
        response.status,
      );
    }

    const body = await response.text();

    if (!response.ok) {
      throw new CscError(
        `CSC request to ${path} failed with HTTP ${response.status}${describeErrorBody(body)}.`,
        response.status,
      );
    }

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new CscError(`CSC request to ${path} returned a body that is not JSON.`, response.status);
    }
  };

  const getAccessToken = async (): Promise<string> => {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
      return cachedToken.value;
    }

    // The client credentials are sent as form parameters rather than HTTP
    // Basic. The specification permits either; form parameters are what CSC
    // provider documentation overwhelmingly shows, and they avoid a second
    // encoding of a secret that may contain non-ASCII characters.
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'service',
    });

    const response = await request<{ access_token?: unknown; expires_in?: unknown }>('/oauth2/token', {
      body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
      throw new CscError('CSC token endpoint returned no access token.');
    }

    const lifetimeSeconds =
      typeof response.expires_in === 'number' && response.expires_in > 0
        ? response.expires_in
        : DEFAULT_TOKEN_LIFETIME_SECONDS;

    const lifetimeMs = lifetimeSeconds * 1000;
    const skewMs = Math.min(MAX_TOKEN_EXPIRY_SKEW_MS, lifetimeMs / 2);

    cachedToken = { value: response.access_token, expiresAt: Date.now() + lifetimeMs - skewMs };

    return cachedToken.value;
  };

  const authenticatedRequest = async <T>(path: string, payload: Record<string, unknown>): Promise<T> => {
    const accessToken = await getAccessToken();

    return await request<T>(path, {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    });
  };

  const getCredentialInfo = async (credentialID: string): Promise<CscCredentialInfo> => {
    const response = await authenticatedRequest<{
      cert?: { certificates?: unknown };
      certificates?: unknown;
      key?: { algo?: unknown; len?: unknown; status?: unknown; curve?: unknown };
    }>('/csc/v2/credentials/info', {
      credentialID,
      certificates: 'chain',
      certInfo: true,
    });

    // The specification nests the chain under `cert.certificates`. Some
    // provider sandboxes return it at the top level instead, so accept both
    // rather than fail on a cosmetic difference.
    const rawCertificates = response.cert?.certificates ?? response.certificates;

    if (!Array.isArray(rawCertificates) || rawCertificates.length === 0) {
      throw new CscError(`CSC credential "${credentialID}" returned no certificates.`);
    }

    const rawAlgorithms = response.key?.algo;

    if (!Array.isArray(rawAlgorithms) || rawAlgorithms.length === 0) {
      throw new CscError(`CSC credential "${credentialID}" reported no key algorithms.`);
    }

    const keyAlgorithms = rawAlgorithms.filter((algo): algo is string => typeof algo === 'string' && algo.length > 0);

    if (keyAlgorithms.length === 0) {
      throw new CscError(`CSC credential "${credentialID}" reported no usable key algorithm OIDs.`);
    }

    return {
      certificates: rawCertificates.map((certificate) => decodeBase64(certificate, 'certificate')),
      keyAlgorithms,
      keyLength: typeof response.key?.len === 'number' ? response.key.len : undefined,
      keyStatus: typeof response.key?.status === 'string' ? response.key.status : undefined,
      keyCurve: typeof response.key?.curve === 'string' ? response.key.curve : undefined,
    };
  };

  const authorize = async ({ credentialID, hashes, pin, otp }: CscAuthorizeOptions): Promise<CscAuthorizeResult> => {
    if (hashes.length === 0) {
      throw new CscError('CSC authorisation requires at least one hash.');
    }

    const response = await authenticatedRequest<{ SAD?: unknown; expiresIn?: unknown }>(
      '/csc/v2/credentials/authorize',
      {
        credentialID,
        numSignatures: hashes.length,
        hash: hashes,
        ...(pin ? { PIN: pin } : {}),
        ...(otp ? { OTP: otp } : {}),
      },
    );

    if (typeof response.SAD !== 'string' || response.SAD.length === 0) {
      throw new CscError(`CSC credential "${credentialID}" returned no Signature Activation Data.`);
    }

    return {
      sad: response.SAD,
      expiresIn: typeof response.expiresIn === 'number' ? response.expiresIn : undefined,
    };
  };

  const signHash = async ({
    credentialID,
    sad,
    hashes,
    hashAlgorithmOid,
    signAlgorithmOid,
  }: CscSignHashOptions): Promise<Uint8Array[]> => {
    if (hashes.length === 0) {
      throw new CscError('CSC signing requires at least one hash.');
    }

    const response = await authenticatedRequest<{ signatures?: unknown }>('/csc/v2/signatures/signHash', {
      credentialID,
      SAD: sad,
      hash: hashes,
      // The specification says `hashAlgo` is only carried when `signAlgo` does
      // not already name a digest, so the caller decides whether to supply it.
      ...(hashAlgorithmOid ? { hashAlgo: hashAlgorithmOid } : {}),
      signAlgo: signAlgorithmOid,
    });

    if (!Array.isArray(response.signatures) || response.signatures.length !== hashes.length) {
      throw new CscError(
        `CSC provider returned ${Array.isArray(response.signatures) ? response.signatures.length : 0} signatures ` +
          `for ${hashes.length} hashes.`,
      );
    }

    return response.signatures.map((signature) => decodeBase64(signature, 'signature'));
  };

  return { getAccessToken, getCredentialInfo, authorize, signHash };
};
