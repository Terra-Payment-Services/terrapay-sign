import { createHash, type KeyObject, verify, X509Certificate } from 'node:crypto';
import {
  NEXT_PRIVATE_SIGNING_REMOTE_CSC_BASE_URL,
  NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256,
  NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_ID,
  NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_SECRET,
  NEXT_PRIVATE_SIGNING_REMOTE_CSC_CREDENTIAL_ID,
  NEXT_PRIVATE_SIGNING_REMOTE_CSC_PIN,
} from '@documenso/lib/constants/app';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { env } from '@documenso/lib/utils/env';
import type { DigestAlgorithm, KeyType, SignatureAlgorithm, Signer } from '@libpdf/core';

import {
  type CscClient,
  CscError,
  createCscClient,
  DIGEST_ALGORITHM_OIDS,
  OID_EC_PUBLIC_KEY,
  OID_ECDSA_WITH_SHA256,
  OID_ECDSA_WITH_SHA384,
  OID_ECDSA_WITH_SHA512,
  OID_RSA_ENCRYPTION,
  OID_RSASSA_PSS,
} from '../helpers/csc-client';

/**
 * A libpdf `Signer` backed by a remote Cloud Signature Consortium (CSC) API
 * v2.0 provider, so that this build can seal documents with a key held by a
 * third-party trust service provider rather than a local PKCS#12 file.
 *
 * ## Provenance
 *
 * Written independently from the published CSC API v2.0 specification and the
 * `@libpdf/core` `Signer` interface. It has never been run against a live trust
 * service provider, so treat it as unvalidated. A first integration should
 * check, in this order:
 *
 * 1. that the token endpoint really is `{base}/oauth2/token` and accepts a
 *    `client_credentials` grant with `scope=service`; some providers mount it
 *    under `/csc/v2/oauth2/token` or require HTTP Basic authentication instead
 * 2. that `credentials/info` returns the chain under `cert.certificates`, leaf
 *    first, and that `key.algo` lists the OID we end up selecting
 * 3. that the provider accepts one `authorize` call per signature rather than
 *    requiring a batch, and that the returned SAD is accepted by `signHash`
 *    for exactly the hash it was issued against
 * 4. that the returned signature bytes are raw PKCS#1 v1.5 or a DER
 *    `SEQUENCE { r, s }` for ECDSA, which is what libpdf's CMS construction
 *    expects, rather than a complete CMS object or a P1363 pair
 * 5. that a signature produced this way validates in Adobe Acrobat and in the
 *    EU DSS validator, including the chain and any timestamp
 *
 * Point 4 no longer has to be discovered by inspecting a broken document.
 * Every signature this transport returns is verified against the certificate
 * the provider reported, before it leaves `sign`, so a provider whose encoding
 * or digest does not match what we are about to declare fails with a message
 * saying so. That check compares the provider's answer against the provider's
 * own certificate, so it carries weight only when the credential is pinned with
 * `NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256`. Production refuses to
 * build a signer without that pin. See `assertSignatureCoversData`.
 *
 * ## What this does and does not give you
 *
 * Using this transport does not by itself make a signature advanced or
 * qualified. A signature reaches the advanced tier only if the provider issues
 * a certificate to the individual signatory and authenticates that signatory
 * before releasing the key, and the qualified tier only if the provider is a
 * qualified trust service provider operating a qualified signature creation
 * device. Pointing this transport at a single organisational service-account
 * credential produces an organisational seal, not an advanced electronic
 * signature by a named person. The software is one part of the arrangement;
 * the provider's registration, identity proofing and sole-control measures are
 * the rest.
 */

type SignAlgorithmResolution = {
  /** The OID to send as `signAlgo`. */
  oid: string;
  /** Whether that OID already names a digest, which suppresses `hashAlgo`. */
  carriesDigest: boolean;
};

type KeyAlgorithmProfile = {
  keyType: KeyType;
  signatureAlgorithm: SignatureAlgorithm;
  /**
   * Resolve the `signAlgo` OID for a digest, or return null when the
   * credential's algorithm cannot be used with that digest.
   */
  resolve: (digest: DigestAlgorithm) => SignAlgorithmResolution | null;
};

const ECDSA_OIDS_BY_DIGEST: Record<DigestAlgorithm, string> = {
  'SHA-256': OID_ECDSA_WITH_SHA256,
  'SHA-384': OID_ECDSA_WITH_SHA384,
  'SHA-512': OID_ECDSA_WITH_SHA512,
};

const fixedEcdsaProfile = (oid: string, digest: DigestAlgorithm): KeyAlgorithmProfile => ({
  keyType: 'EC',
  signatureAlgorithm: 'ECDSA',
  resolve: (requested) => (requested === digest ? { oid, carriesDigest: true } : null),
});

const KEY_ALGORITHM_PROFILES: Record<string, KeyAlgorithmProfile> = {
  [OID_RSA_ENCRYPTION]: {
    keyType: 'RSA',
    signatureAlgorithm: 'RSASSA-PKCS1-v1_5',
    resolve: () => ({ oid: OID_RSA_ENCRYPTION, carriesDigest: false }),
  },
  [OID_EC_PUBLIC_KEY]: {
    keyType: 'EC',
    signatureAlgorithm: 'ECDSA',
    resolve: (digest) => ({ oid: ECDSA_OIDS_BY_DIGEST[digest], carriesDigest: true }),
  },
  [OID_ECDSA_WITH_SHA256]: fixedEcdsaProfile(OID_ECDSA_WITH_SHA256, 'SHA-256'),
  [OID_ECDSA_WITH_SHA384]: fixedEcdsaProfile(OID_ECDSA_WITH_SHA384, 'SHA-384'),
  [OID_ECDSA_WITH_SHA512]: fixedEcdsaProfile(OID_ECDSA_WITH_SHA512, 'SHA-512'),
};

/**
 * Order in which we pick from the algorithms a credential advertises.
 *
 * PKCS#1 v1.5 comes first because it is what `@libpdf/core` declares for any
 * RSA key, whatever the signer says, so choosing it keeps the bytes and the
 * label in agreement. EC keys come after it because they are rarer in this
 * setting.
 */
const KEY_ALGORITHM_PREFERENCE = [
  OID_RSA_ENCRYPTION,
  OID_EC_PUBLIC_KEY,
  OID_ECDSA_WITH_SHA256,
  OID_ECDSA_WITH_SHA384,
  OID_ECDSA_WITH_SHA512,
];

/**
 * Algorithms a credential may advertise that this transport refuses, with the
 * reason to hand back to whoever configured it.
 *
 * `@libpdf/core` derives the CMS `signatureAlgorithm` from the signer's key
 * type alone. Every RSA signer is written as `sha256WithRSAEncryption` or its
 * 384 and 512 siblings, emitted as a bare `AlgorithmIdentifier` with no
 * parameters, and the signer's own `signatureAlgorithm` field is never read.
 * See `getSignatureAlgorithmOid` in `@libpdf/core/dist/index.mjs`. RSASSA-PSS
 * carries its digest, its mask generation function and its salt length in
 * exactly those absent parameters, so libpdf has nowhere to put them. A PSS
 * credential would yield PSS signature bytes under a PKCS#1 v1.5 label, which
 * Acrobat and the EU DSS validator both reject. Failing at startup is the
 * kinder outcome.
 */
const REFUSED_KEY_ALGORITHMS: Record<string, string> = {
  [OID_RSASSA_PSS]:
    'RSASSA-PSS cannot be expressed in the CMS structure @libpdf/core builds, which labels every RSA ' +
    'signature as PKCS#1 v1.5 regardless of what the signer reports. PSS bytes under that label verify ' +
    'nowhere, so this transport will not use a PSS credential.',
};

const NODE_DIGEST_NAMES: Record<DigestAlgorithm, string> = {
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

/**
 * Node's name for the key type an advertised profile implies.
 *
 * `rsa-pss` is missing on purpose. Node reports it for a certificate whose
 * SubjectPublicKeyInfo declares `id-RSASSA-PSS`, which restricts the key to PSS
 * and lands where an advertised PSS algorithm lands: libpdf would label the
 * result PKCS#1 v1.5 over bytes that are nothing of the kind.
 */
const NODE_KEY_TYPES: Record<KeyType, string> = {
  RSA: 'rsa',
  EC: 'ec',
};

/**
 * Curve OIDs by the name Node reports for them.
 *
 * Covers the NIST curves and the brainpool curves, which is what a European
 * trust service provider is likely to hold.
 */
const CURVE_OIDS_BY_NODE_NAME: Record<string, string> = {
  prime256v1: '1.2.840.10045.3.1.7',
  secp384r1: '1.3.132.0.34',
  secp521r1: '1.3.132.0.35',
  secp256k1: '1.3.132.0.10',
  brainpoolP256r1: '1.3.36.3.3.2.8.1.1.7',
  brainpoolP384r1: '1.3.36.3.3.2.8.1.1.11',
  brainpoolP512r1: '1.3.36.3.3.2.8.1.1.13',
};

/** A SHA-256 fingerprint, once the separators have been taken out. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Hold the provider's leaf certificate against the one the operator expects.
 *
 * Without this, every check in this file draws its key material from the same
 * response it is checking. Whoever controls the provider's answers can return a
 * certificate of their own, sign with the matching key, and satisfy all of it.
 * A fingerprint configured out of band is what ties the response back to the
 * credential you bought.
 *
 * Only the leaf is pinned. It carries the key that makes the signature, and the
 * intermediates can change under a renewal without the credential changing.
 *
 * @param options - the credential id, the leaf the provider returned and the configured fingerprint
 * @throws {CscError} when the fingerprint is malformed or does not match
 */
const assertCertificateIsPinned = (options: {
  credentialId: string;
  certificate: Uint8Array;
  expectedSha256: string;
}): void => {
  const expected = options.expectedSha256.replace(/[\s:]/g, '').toLowerCase();

  if (!FINGERPRINT_PATTERN.test(expected)) {
    throw new CscError(
      'NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256 must be a SHA-256 fingerprint of the leaf ' +
        'certificate: 64 hex characters, colons optional. Take it from ' +
        '`openssl x509 -noout -fingerprint -sha256`.',
    );
  }

  const actual = createHash('sha256').update(options.certificate).digest('hex');

  if (actual !== expected) {
    throw new CscError(
      `CSC credential "${options.credentialId}" returned a leaf certificate with SHA-256 fingerprint ` +
        `${actual}, and the configured pin is ${expected}. Refusing to sign. Either the credential was ` +
        'renewed and the pin needs updating, or this response did not come from the provider you configured.',
    );
  }
};

/**
 * Hold the leaf certificate's key against the algorithm the provider
 * advertised for the credential.
 *
 * `credentials/info` reports the algorithms, and the same response carries the
 * certificate holding the key those algorithms are supposed to describe.
 * Nothing in the protocol makes the two agree, and a disagreement is silent
 * where it matters. The key decides what the signature bytes are; the
 * advertised algorithm decides what libpdf declares them to be. An EC key
 * behind an RSA advertisement produces ECDSA bytes under an RSA OID, and the
 * verification in `sign` still passes, because Node reads the real key out of
 * the certificate and picks its behaviour from that. The document would be
 * invalid with nothing on the signing path having noticed.
 *
 * @param options - the credential id, the chosen profile, the leaf key and the curve the provider advertised
 * @throws {CscError} when the certificate's key contradicts the advertisement
 */
const assertCertificateMatchesProfile = (options: {
  credentialId: string;
  profile: KeyAlgorithmProfile;
  publicKey: KeyObject;
  advertisedCurveOid?: string;
}): void => {
  const { credentialId, profile, publicKey, advertisedCurveOid } = options;
  const keyType = publicKey.asymmetricKeyType;

  if (keyType === 'rsa-pss') {
    throw new CscError(
      `CSC credential "${credentialId}" returned a leaf certificate that restricts its key to RSASSA-PSS. ` +
        REFUSED_KEY_ALGORITHMS[OID_RSASSA_PSS],
    );
  }

  if (keyType !== NODE_KEY_TYPES[profile.keyType]) {
    const carried = keyType ? `an ${keyType} key` : 'a key of a type this build cannot read';

    throw new CscError(
      `CSC credential "${credentialId}" advertises ${profile.keyType} as its key type, and the leaf ` +
        `certificate it returned carries ${carried}. Refusing to sign. libpdf takes the algorithm it ` +
        'declares from the advertisement while the signature bytes come from the key, so a document sealed ' +
        'under this credential would name an algorithm it did not use.',
    );
  }

  if (profile.keyType !== 'EC' || !advertisedCurveOid) {
    return;
  }

  const namedCurve = publicKey.asymmetricKeyDetails?.namedCurve ?? 'an unnamed curve';
  const certificateCurveOid = CURVE_OIDS_BY_NODE_NAME[namedCurve];

  // An unmapped curve fails here too. The comparison is the point, and a curve
  // this build cannot put an OID to is one it cannot compare.
  if (certificateCurveOid !== advertisedCurveOid) {
    const carried = certificateCurveOid
      ? `${namedCurve} (${certificateCurveOid})`
      : `${namedCurve}, which this build holds no OID for`;

    throw new CscError(
      `CSC credential "${credentialId}" advertises curve ${advertisedCurveOid}, and the leaf certificate it ` +
        `returned is on ${carried}. The provider's description of this credential disagrees with the key it ` +
        'handed over, so neither can be relied on.',
    );
  }
};

export type CreateCscSignerOptions = {
  /** Provider base URL, https only. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** The `credentialID` identifying the signing key held by the provider. */
  credentialId: string;
  /** PIN protecting the credential, when the provider requires one. */
  pin?: string;
  /**
   * SHA-256 fingerprint of the leaf certificate this credential must present,
   * as hex, colons optional.
   *
   * Required when `NODE_ENV` is `production`; elsewhere an unpinned signer is
   * built with a warning. Everything else this transport checks is checked
   * against material the provider itself returned. See
   * {@link assertCertificateIsPinned}.
   */
  expectedCertificateSha256?: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
};

export class CscSigner implements Signer {
  readonly certificate: Uint8Array;
  readonly certificateChain?: Uint8Array[];
  readonly keyType: KeyType;
  readonly signatureAlgorithm: SignatureAlgorithm;

  private readonly client: CscClient;
  private readonly credentialId: string;
  private readonly pin?: string;
  private readonly profile: KeyAlgorithmProfile;
  private readonly publicKey: KeyObject;

  private constructor(options: {
    client: CscClient;
    credentialId: string;
    pin?: string;
    certificate: Uint8Array;
    certificateChain?: Uint8Array[];
    profile: KeyAlgorithmProfile;
    publicKey: KeyObject;
  }) {
    this.client = options.client;
    this.credentialId = options.credentialId;
    this.pin = options.pin;
    this.certificate = options.certificate;
    this.certificateChain = options.certificateChain;
    this.profile = options.profile;
    this.publicKey = options.publicKey;
    this.keyType = options.profile.keyType;
    this.signatureAlgorithm = options.profile.signatureAlgorithm;
  }

  /**
   * Build a signer for a provider-held credential.
   *
   * Calls `credentials/info` so that the certificate, the chain, the key type
   * and the signature algorithm all come from what the provider reports rather
   * than from an assumption baked into this file. A credential whose key is
   * disabled, or whose advertised algorithms libpdf cannot construct CMS for,
   * fails here rather than at sealing time.
   *
   * Three things have to line up before this returns. The advertised algorithm
   * must be one libpdf can label correctly, the leaf certificate must match the
   * configured pin, and the key inside that certificate must be the key the
   * advertisement describes. Outside production the pin may be left unset, in
   * which case the leaf is taken on trust and a warning is logged.
   *
   * @param options - provider endpoint, service account, credential id and certificate pin
   * @returns a ready signer
   * @throws {AppError} with `MISSING_ENV_VAR` in production when no pin is configured
   * @throws {CscError} if the credential is unusable or the provider call fails
   */
  static async create(options: CreateCscSignerOptions): Promise<CscSigner> {
    // Checked before any provider call, so a production deployment without a pin
    // fails on configuration alone rather than after talking to the provider.
    if (!options.expectedCertificateSha256 && env('NODE_ENV') === 'production') {
      throw new AppError(AppErrorCode.MISSING_ENV_VAR, {
        message:
          `The remote-csc credential "${options.credentialId}" is not pinned, and production refuses to sign ` +
          'with an unpinned credential. Set NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256 to the SHA-256 ' +
          'fingerprint of the leaf certificate you expect, from `openssl x509 -noout -fingerprint -sha256`.',
      });
    }

    const client = createCscClient({
      baseUrl: options.baseUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      requestTimeoutMs: options.requestTimeoutMs,
    });

    const info = await client.getCredentialInfo(options.credentialId);

    if (info.keyStatus && info.keyStatus !== 'enabled') {
      throw new CscError(
        `CSC credential "${options.credentialId}" has key status "${info.keyStatus}" and cannot be used to sign.`,
      );
    }

    const selectedOid = KEY_ALGORITHM_PREFERENCE.find((oid) => info.keyAlgorithms.includes(oid));

    if (!selectedOid) {
      const refusal = info.keyAlgorithms.map((oid) => REFUSED_KEY_ALGORITHMS[oid]).find(Boolean);

      if (refusal) {
        throw new CscError(
          `CSC credential "${options.credentialId}" advertises only algorithms this transport refuses ` +
            `[${info.keyAlgorithms.join(', ')}]. ${refusal}`,
        );
      }

      throw new CscError(
        `CSC credential "${options.credentialId}" advertises no signature algorithm this build supports. ` +
          `The provider reported [${info.keyAlgorithms.join(', ')}]; supported are ` +
          `[${KEY_ALGORITHM_PREFERENCE.join(', ')}].`,
      );
    }

    const [certificate, ...chain] = info.certificates;

    if (options.expectedCertificateSha256) {
      assertCertificateIsPinned({
        credentialId: options.credentialId,
        certificate,
        expectedSha256: options.expectedCertificateSha256,
      });
    } else {
      console.warn(
        `[signing] the remote-csc credential "${options.credentialId}" is not pinned. Its certificate, and ` +
          'therefore the key every signature is verified against, is whatever the provider returned. Set ' +
          'NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256 to the fingerprint of the leaf certificate ' +
          'you expect.',
      );
    }

    // Parsed once, at startup, for two reasons. Every signature is verified
    // against this key before it is returned, and bytes that are not a
    // certificate at all should stop the process here rather than at the first
    // document somebody tries to seal.
    let publicKey: KeyObject;

    try {
      publicKey = new X509Certificate(Buffer.from(certificate)).publicKey;
    } catch (error) {
      throw new CscError(
        `CSC credential "${options.credentialId}" returned a leaf certificate that could not be parsed: ` +
          `${error instanceof Error ? error.message : String(error)}.`,
      );
    }

    const profile = KEY_ALGORITHM_PROFILES[selectedOid];

    assertCertificateMatchesProfile({
      credentialId: options.credentialId,
      profile,
      publicKey,
      advertisedCurveOid: info.keyCurve,
    });

    return new CscSigner({
      client,
      credentialId: options.credentialId,
      pin: options.pin,
      certificate,
      certificateChain: chain.length > 0 ? chain : undefined,
      profile,
      publicKey,
    });
  }

  /**
   * Hash the data libpdf handed us, have the provider authorise that exact
   * hash, then have it sign the hash.
   *
   * The ordering is forced by the protocol rather than chosen. Signature
   * Activation Data is bound to the hashes it was issued for, so it cannot be
   * obtained ahead of time and kept warm: the hash covers the PDF byte ranges,
   * which do not exist until libpdf has laid out the signature placeholder and
   * called us. Authorising earlier would mean authorising a hash we have not
   * computed yet. Every signature therefore costs one `authorize` round trip
   * followed by one `signHash` round trip.
   *
   * Nothing here returns bytes on a failure path. An error at any step throws,
   * because a signer that returns something plausible on failure produces a
   * document that looks signed and is not.
   *
   * @param data - the bytes to sign, which this signer hashes itself
   * @param algorithm - the digest algorithm libpdf wants used
   * @returns the raw signature bytes, PKCS#1 v1.5 or DER ECDSA
   * @throws {CscError} on any configuration, provider or protocol failure
   */
  async sign(data: Uint8Array, algorithm: DigestAlgorithm): Promise<Uint8Array> {
    const nodeDigestName = NODE_DIGEST_NAMES[algorithm];

    if (!nodeDigestName) {
      throw new CscError(`Unsupported digest algorithm for CSC signing: "${algorithm}".`);
    }

    const resolution = this.profile.resolve(algorithm);

    if (!resolution) {
      throw new CscError(
        `CSC credential "${this.credentialId}" cannot sign a ${algorithm} digest with its ` +
          `${this.signatureAlgorithm} key.`,
      );
    }

    const hash = createHash(nodeDigestName).update(data).digest('base64');

    const { sad } = await this.client.authorize({
      credentialID: this.credentialId,
      hashes: [hash],
      pin: this.pin,
    });

    const signatures = await this.client.signHash({
      credentialID: this.credentialId,
      sad,
      hashes: [hash],
      hashAlgorithmOid: resolution.carriesDigest ? undefined : DIGEST_ALGORITHM_OIDS[algorithm],
      signAlgorithmOid: resolution.oid,
    });

    if (signatures.length !== 1) {
      throw new CscError(`CSC provider returned ${signatures.length} signatures for a single hash.`);
    }

    this.assertSignatureCoversData(data, algorithm, signatures[0]);

    return signatures[0];
  }

  /**
   * Check the provider's answer against what it was asked to sign.
   *
   * Everything before this point establishes only that the response was well
   * formed: JSON, one blob, decodable base64. A provider bug, a credential that
   * has been rekeyed underneath us, or anything sitting between us and the
   * provider can meet all of that and still return a signature over different
   * bytes or made with a different key. libpdf embeds whatever a signer hands
   * back, so the first person to find out would be whoever opened the document
   * months later and discovered it does not validate.
   *
   * What this establishes: the signature we are about to embed verifies against
   * the certificate we are about to embed beside it, over the data libpdf gave
   * us, under the digest libpdf asked for. Encoding, padding and digest all have
   * to line up for that to hold.
   *
   * What it does not establish: that the credential you configured produced it.
   * The key comes from the certificate the provider returned at
   * `credentials/info`, so whoever controls those responses controls both sides
   * of the comparison and can satisfy it with a key of their own. Pinning the
   * leaf certificate is what closes that, and `create` refuses a leaf that does
   * not match the pin. Unpinned, which only a non-production build allows, read
   * this as an internal consistency check on one provider response.
   *
   * This costs no round trip and no money. It is a local public key operation
   * on a signature we have already paid for.
   *
   * @param data - the bytes libpdf asked to have covered
   * @param algorithm - the digest libpdf asked for
   * @param signature - what the provider returned
   * @throws {CscError} when the signature does not verify
   */
  private assertSignatureCoversData(data: Uint8Array, algorithm: DigestAlgorithm, signature: Uint8Array): void {
    let verified = false;

    try {
      verified = verify(NODE_DIGEST_NAMES[algorithm], data, this.publicKey, signature);
    } catch {
      // Node throws rather than returning false on bytes it cannot even parse
      // as a signature, such as a raw P1363 pair where DER was expected. That
      // is a failure like any other here.
      verified = false;
    }

    if (!verified) {
      throw new CscError(
        `CSC provider returned a signature for credential "${this.credentialId}" that does not verify against ` +
          `that credential's certificate under ${algorithm}. Refusing to embed it. Likely causes are a provider ` +
          'that signed a different hash, a certificate that no longer matches the signing key, or an ECDSA ' +
          'signature encoded as a raw pair rather than DER.',
      );
    }
  }
}

/**
 * Build a {@link CscSigner} from the `NEXT_PRIVATE_SIGNING_REMOTE_CSC_*`
 * environment variables.
 *
 * @returns a signer for the configured provider credential
 * @throws {CscError} if any required variable is unset
 */
export const createCscSigner = async (): Promise<CscSigner> => {
  const baseUrl = NEXT_PRIVATE_SIGNING_REMOTE_CSC_BASE_URL();
  const clientId = NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_ID();
  const clientSecret = NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_SECRET();
  const credentialId = NEXT_PRIVATE_SIGNING_REMOTE_CSC_CREDENTIAL_ID();

  const missing = [
    !baseUrl && 'NEXT_PRIVATE_SIGNING_REMOTE_CSC_BASE_URL',
    !clientId && 'NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_ID',
    !clientSecret && 'NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_SECRET',
    !credentialId && 'NEXT_PRIVATE_SIGNING_REMOTE_CSC_CREDENTIAL_ID',
  ].filter((name): name is string => typeof name === 'string');

  if (missing.length > 0) {
    throw new CscError(`The remote-csc signing transport is missing required configuration: ${missing.join(', ')}.`);
  }

  return await CscSigner.create({
    baseUrl: baseUrl as string,
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    credentialId: credentialId as string,
    pin: NEXT_PRIVATE_SIGNING_REMOTE_CSC_PIN() || undefined,
    expectedCertificateSha256: NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256() || undefined,
  });
};
