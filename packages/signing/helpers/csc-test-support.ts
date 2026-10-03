import { constants, createHash, createPrivateKey, sign } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { vi } from 'vitest';

/**
 * Test-only mock of a Cloud Signature Consortium provider.
 *
 * Stubs the global `fetch` and routes on the request path, recording every
 * call so a test can assert on what was sent as well as what came back. Not
 * part of the shipped surface of this package.
 */

export type CscMockRequest = {
  path: string;
  /** Parsed request body: an object for JSON, a field map for form posts. */
  body: Record<string, unknown>;
  authorization: string | null;
};

export type CscMockResponse = {
  /** @default 200 */
  status?: number;
  /** Serialised as JSON. Ignored when `rawBody` is given. */
  body?: unknown;
  /** Sent verbatim, for testing malformed responses. */
  rawBody?: string;
};

export type CscMockRoute = (request: CscMockRequest) => CscMockResponse;

export type CscMockProvider = {
  /** Every request the client made, in order. */
  requests: CscMockRequest[];
  /** The requests made to one path. */
  requestsTo: (path: string) => CscMockRequest[];
};

const parseBody = (body: unknown, contentType: string): Record<string, unknown> => {
  if (typeof body !== 'string' || body.length === 0) {
    return {};
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }

  try {
    const parsed: unknown = JSON.parse(body);

    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Install a mock CSC provider for the duration of a test.
 *
 * @param routes - map of request path to a handler producing the response
 * @returns a handle for inspecting the requests the client made
 */
export const installCscMockProvider = (routes: Record<string, CscMockRoute>): CscMockProvider => {
  const requests: CscMockRequest[] = [];

  const respond = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers = new Headers(init?.headers);

    const request: CscMockRequest = {
      path: url.pathname,
      body: parseBody(init?.body, headers.get('content-type') ?? ''),
      authorization: headers.get('authorization'),
    };

    requests.push(request);

    const route = routes[url.pathname];

    if (!route) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const result = route(request);
    const status = result.status ?? 200;
    const body = result.rawBody ?? JSON.stringify(result.body ?? {});

    // A 3xx with no body still needs to look like a redirect to the client.
    if (status >= 300 && status < 400) {
      return new Response(null, { status, headers: { location: 'https://elsewhere.example/token' } });
    }

    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };

  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => Promise.resolve(respond(input, init)));

  vi.stubGlobal('fetch', fetchMock);

  return {
    requests,
    requestsTo: (path: string) => requests.filter((request) => request.path === path),
  };
};

/**
 * A real key and certificate for the mock provider to sign with.
 *
 * The signer verifies every signature against the certificate the provider
 * reported, so a mock that returns arbitrary bytes can no longer stand in for a
 * working provider. These are generated per test run rather than checked in,
 * which keeps the fixtures out of the repository and lets a test say "a
 * different key" by asking for another one.
 */
export type TestSigningCredential = {
  /** DER of the self-signed certificate, for `credentials/info` to report. */
  certificateDer: Uint8Array;
  /** The `key.algo` OID a provider would advertise for this credential. */
  keyAlgorithmOid: string;
  /**
   * Sign `data` the way a compliant provider would, returning raw bytes.
   *
   * `saltLength` applies to the RSA-PSS profile and defaults to the digest
   * length, which is what the signer verifies at. Pass something else to
   * imitate a provider that salts differently.
   */
  sign: (data: Uint8Array, algorithm: TestDigestAlgorithm, saltLength?: number) => Uint8Array;
};

export type TestDigestAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512';

export type TestCredentialProfile = 'rsa-pkcs1' | 'rsa-pss' | 'rsa-pss-restricted' | 'ecdsa';

const OID_COMMON_NAME = '2.5.4.3';

const NODE_DIGEST_NAMES: Record<TestDigestAlgorithm, string> = {
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

const PSS_SALT_LENGTHS: Record<TestDigestAlgorithm, number> = {
  'SHA-256': 32,
  'SHA-384': 48,
  'SHA-512': 64,
};

const KEY_ALGORITHM_OIDS: Record<TestCredentialProfile, string> = {
  'rsa-pkcs1': '1.2.840.113549.1.1.1',
  'rsa-pss': '1.2.840.113549.1.1.10',
  'rsa-pss-restricted': '1.2.840.113549.1.1.10',
  ecdsa: '1.2.840.10045.2.1',
};

const WEB_CRYPTO_KEY_PARAMS: Record<TestCredentialProfile, EcKeyGenParams | RsaHashedKeyGenParams> = {
  'rsa-pkcs1': {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  'rsa-pss': {
    name: 'RSA-PSS',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  'rsa-pss-restricted': {
    name: 'RSA-PSS',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  ecdsa: { name: 'ECDSA', namedCurve: 'P-256' },
};

/**
 * Build a self-signed credential a mock provider can sign with.
 *
 * The certificate is minimal on purpose. Nothing under test reads its subject,
 * its validity or its extensions; what matters is that the public key inside it
 * is the one that made the signature.
 *
 * `rsa-pss-restricted` differs from `rsa-pss` in the certificate rather than
 * the key: its SubjectPublicKeyInfo declares `id-RSASSA-PSS`, so the
 * certificate itself limits the key to PSS. Node reports that key as `rsa-pss`,
 * which is how a transport can tell the two apart.
 *
 * @param profile - which key and padding the imagined provider holds
 * @returns the certificate and a signing function
 */
export const createTestSigningCredential = async (
  profile: TestCredentialProfile = 'rsa-pkcs1',
): Promise<TestSigningCredential> => {
  const crypto = pkijs.getCrypto(true);

  const keys = await crypto.generateKey(WEB_CRYPTO_KEY_PARAMS[profile], true, ['sign', 'verify']);

  const name = new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: OID_COMMON_NAME,
        value: new asn1js.PrintableString({ value: 'CSC test credential' }),
      }),
    ],
  });

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: 1 });
  certificate.subject = name;
  certificate.issuer = name;
  certificate.notBefore.value = new Date(Date.now() - 86_400_000);
  certificate.notAfter.value = new Date(Date.now() + 86_400_000);

  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey, crypto);

  if (profile === 'rsa-pss-restricted') {
    certificate.subjectPublicKeyInfo.algorithm.algorithmId = KEY_ALGORITHM_OIDS['rsa-pss'];
    certificate.subjectPublicKeyInfo.algorithm.algorithmParams = undefined;
  }

  await certificate.sign(keys.privateKey, 'SHA-256', crypto);

  const pkcs8 = await crypto.exportKey('pkcs8', keys.privateKey);
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });

  return {
    certificateDer: new Uint8Array(certificate.toSchema(true).toBER(false)),
    keyAlgorithmOid: KEY_ALGORITHM_OIDS[profile],
    sign: (data, algorithm, saltLength) =>
      new Uint8Array(
        sign(
          NODE_DIGEST_NAMES[algorithm],
          data,
          profile === 'rsa-pss' || profile === 'rsa-pss-restricted'
            ? {
                key: privateKey,
                padding: constants.RSA_PKCS1_PSS_PADDING,
                saltLength: saltLength ?? PSS_SALT_LENGTHS[algorithm],
              }
            : privateKey,
        ),
      ),
  };
};

export type SignHashRouteOptions = {
  /** The credential the provider signs with. */
  credential: TestSigningCredential;
  /**
   * Every document the test might ask to have signed.
   *
   * A CSC provider is handed a digest, never the document, so the mock has to
   * be told in advance what it might be asked about. It digests each document
   * under each algorithm and looks the request up in that table.
   */
  documents: Uint8Array[];
  /** Mangle the signature on the way out, for testing what the signer rejects. */
  corrupt?: (signature: Uint8Array) => Uint8Array;
};

/**
 * A `signHash` route backed by a real key.
 *
 * @param options - the credential, the documents it may be asked about
 * @returns a route for {@link installCscMockProvider}
 */
export const createSignHashRoute = ({ credential, documents, corrupt }: SignHashRouteOptions): CscMockRoute => {
  const algorithms: TestDigestAlgorithm[] = ['SHA-256', 'SHA-384', 'SHA-512'];

  const bySentDigest = new Map<string, { data: Uint8Array; algorithm: TestDigestAlgorithm }>();

  for (const data of documents) {
    for (const algorithm of algorithms) {
      const digest = createHash(NODE_DIGEST_NAMES[algorithm]).update(data).digest('base64');

      bySentDigest.set(digest, { data, algorithm });
    }
  }

  return (request) => {
    const hashes = Array.isArray(request.body.hash) ? (request.body.hash as string[]) : [];

    const signatures = hashes.map((hash) => {
      const match = bySentDigest.get(hash);

      if (!match) {
        throw new Error('The mock CSC provider was asked to sign a digest it was not told about.');
      }

      const signature = credential.sign(match.data, match.algorithm);

      return Buffer.from(corrupt ? corrupt(signature) : signature).toString('base64');
    });

    return { body: { signatures } };
  };
};
