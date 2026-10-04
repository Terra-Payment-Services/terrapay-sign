import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CscError } from '../helpers/csc-client';
import {
  type CscMockRoute,
  createSignHashRoute,
  createTestSigningCredential,
  installCscMockProvider,
} from '../helpers/csc-test-support';
import { CscSigner } from './csc';

const BASE_URL = 'https://csc.example.test';

const SIGNER_OPTIONS = {
  baseUrl: BASE_URL,
  clientId: 'service-account',
  clientSecret: 'service-secret',
  credentialId: 'cred-1',
};

const DOCUMENT_BYTES = new TextEncoder().encode('the bytes libpdf wants covered');
const OTHER_DOCUMENT_BYTES = new TextEncoder().encode('a different document');

// Real keys, because the signer verifies every signature against the
// certificate the provider reported. Generated once for the file; RSA key
// generation is slow enough to be worth not repeating per test.
const rsaCredential = await createTestSigningCredential('rsa-pkcs1');
const pssCredential = await createTestSigningCredential('rsa-pss');
const pssRestrictedCredential = await createTestSigningCredential('rsa-pss-restricted');
const ecCredential = await createTestSigningCredential('ecdsa');
const strangerCredential = await createTestSigningCredential('rsa-pkcs1');

const DOCUMENTS = [DOCUMENT_BYTES, OTHER_DOCUMENT_BYTES];

const LEAF_DER = rsaCredential.certificateDer;
const INTERMEDIATE_DER = new Uint8Array([0x30, 0x82, 0x01, 0x02]);
const ROOT_DER = new Uint8Array([0x30, 0x82, 0x01, 0x03]);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const fingerprint = (der: Uint8Array) => createHash('sha256').update(der).digest('hex');

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_RSASSA_PSS = '1.2.840.113549.1.1.10';
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_CURVE_P256 = '1.2.840.10045.3.1.7';
const OID_CURVE_P384 = '1.3.132.0.34';

const expectedDigest = (algorithm: 'sha256' | 'sha384' | 'sha512' = 'sha256') =>
  createHash(algorithm).update(DOCUMENT_BYTES).digest('base64');

const tokenRoute: CscMockRoute = () => ({ body: { access_token: 'bearer-1', expires_in: 3600 } });

const infoRoute =
  (key: Record<string, unknown>, certificates = [LEAF_DER, INTERMEDIATE_DER, ROOT_DER]): CscMockRoute =>
  () => ({ body: { cert: { certificates: certificates.map(base64) }, key } });

const rsaInfoRoute = infoRoute({ status: 'enabled', algo: [rsaCredential.keyAlgorithmOid], len: 2048 });

const authorizeRoute: CscMockRoute = () => ({ body: { SAD: 'sad-value', expiresIn: 300 } });

const signHashRoute = createSignHashRoute({ credential: rsaCredential, documents: DOCUMENTS });

const happyPathRoutes = {
  '/oauth2/token': tokenRoute,
  '/csc/v2/credentials/info': rsaInfoRoute,
  '/csc/v2/credentials/authorize': authorizeRoute,
  '/csc/v2/signatures/signHash': signHashRoute,
};

/**
 * Re-encode a DER ECDSA signature as the raw r||s pair some providers return.
 *
 * libpdf's CMS construction expects DER, so a provider doing this produces a
 * document that validates nowhere. The test wants that caught here.
 */
const derEcdsaToRawPair = (der: Uint8Array): Uint8Array => {
  let offset = 2;

  const readInteger = (): Uint8Array => {
    offset += 1;

    const length = der[offset];

    offset += 1;

    const value = der.slice(offset, offset + length);

    offset += length;

    return value;
  };

  const pad = (value: Uint8Array): Uint8Array => {
    const trimmed = value[0] === 0 ? value.slice(1) : value;
    const padded = new Uint8Array(32);

    padded.set(trimmed, 32 - trimmed.length);

    return padded;
  };

  const r = pad(readInteger());
  const sValue = pad(readInteger());

  return Uint8Array.from([...r, ...sValue]);
};

// Creating an unpinned signer warns, by design, and every test here but one
// creates an unpinned signer. Silenced so the warning stays readable where a
// test is looking for it.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CscSigner', () => {
  describe('happy path', () => {
    it('runs token, credentials/info, authorize and signHash, and returns the decoded signature', async () => {
      const provider = installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);
      const signature = await signer.sign(DOCUMENT_BYTES, 'SHA-256');

      expect(signature).toEqual(rsaCredential.sign(DOCUMENT_BYTES, 'SHA-256'));

      expect(provider.requests.map((request) => request.path)).toEqual([
        '/oauth2/token',
        '/csc/v2/credentials/info',
        '/csc/v2/credentials/authorize',
        '/csc/v2/signatures/signHash',
      ]);
    });

    it('exposes the leaf certificate and the rest of the chain separately', async () => {
      installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      expect(signer.certificate).toEqual(LEAF_DER);
      expect(signer.certificateChain).toEqual([INTERMEDIATE_DER, ROOT_DER]);
    });

    it('reports no chain when the provider returns only a leaf certificate', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ algo: [rsaCredential.keyAlgorithmOid] }, [LEAF_DER]),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      expect(signer.certificateChain).toBeUndefined();
    });
  });

  describe('digest binding', () => {
    it('digests the data libpdf passed and authorises that exact hash', async () => {
      const provider = installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await signer.sign(DOCUMENT_BYTES, 'SHA-256');

      const authorize = provider.requestsTo('/csc/v2/credentials/authorize')[0];

      expect(authorize.body.hash).toEqual([expectedDigest()]);
    });

    it('sends the same hash to signHash that it sent to authorize', async () => {
      const provider = installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await signer.sign(DOCUMENT_BYTES, 'SHA-256');

      const authorize = provider.requestsTo('/csc/v2/credentials/authorize')[0];
      const signHash = provider.requestsTo('/csc/v2/signatures/signHash')[0];

      expect(signHash.body.hash).toEqual(authorize.body.hash);
      expect(signHash.body.SAD).toBe('sad-value');
    });

    it('uses the digest algorithm libpdf asked for', async () => {
      const provider = installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await signer.sign(DOCUMENT_BYTES, 'SHA-512');

      const signHash = provider.requestsTo('/csc/v2/signatures/signHash')[0];

      expect(signHash.body.hash).toEqual([expectedDigest('sha512')]);
      expect(signHash.body.hashAlgo).toBe('2.16.840.1.101.3.4.2.3');
    });

    it('obtains fresh Signature Activation Data for every signature', async () => {
      const provider = installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await signer.sign(DOCUMENT_BYTES, 'SHA-256');
      await signer.sign(OTHER_DOCUMENT_BYTES, 'SHA-256');

      expect(provider.requestsTo('/csc/v2/credentials/authorize')).toHaveLength(2);
      expect(provider.requestsTo('/csc/v2/credentials/authorize')[0].body.hash).not.toEqual(
        provider.requestsTo('/csc/v2/credentials/authorize')[1].body.hash,
      );
    });

    it('reuses the bearer token across signatures', async () => {
      const provider = installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await signer.sign(DOCUMENT_BYTES, 'SHA-256');
      await signer.sign(DOCUMENT_BYTES, 'SHA-256');

      expect(provider.requestsTo('/oauth2/token')).toHaveLength(1);
    });
  });

  describe('algorithm derivation', () => {
    it('derives RSASSA-PKCS1-v1_5 from an rsaEncryption credential', async () => {
      const provider = installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      expect(signer.keyType).toBe('RSA');
      expect(signer.signatureAlgorithm).toBe('RSASSA-PKCS1-v1_5');

      await signer.sign(DOCUMENT_BYTES, 'SHA-256');

      expect(provider.requestsTo('/csc/v2/signatures/signHash')[0].body).toMatchObject({
        signAlgo: '1.2.840.113549.1.1.1',
        hashAlgo: '2.16.840.1.101.3.4.2.1',
      });
    });

    it('refuses a credential that advertises only RSASSA-PSS, naming the reason', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [pssCredential.keyAlgorithmOid] }, [
          pssCredential.certificateDer,
        ]),
        '/csc/v2/signatures/signHash': createSignHashRoute({ credential: pssCredential, documents: DOCUMENTS }),
      });

      // libpdf labels every RSA signature PKCS#1 v1.5, so a PSS credential
      // would seal documents whose bytes and label disagree. Startup is the
      // place to find that out.
      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(CscError);
      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/RSASSA-PSS cannot be expressed/);
    });

    it('never hands libpdf a signer that declares RSA-PSS', async () => {
      // The invariant behind finding 1: libpdf labels RSA signatures PKCS#1
      // v1.5 from the key type alone, so a signer declaring PSS is a document
      // whose bytes and label disagree. Either the credential is refused or it
      // comes back as something else.
      for (const algo of [[OID_RSASSA_PSS], [OID_RSASSA_PSS, OID_RSA_ENCRYPTION]]) {
        installCscMockProvider({
          ...happyPathRoutes,
          '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo }),
        });

        const signer = await CscSigner.create(SIGNER_OPTIONS).catch(() => null);

        expect(signer?.signatureAlgorithm).not.toBe('RSA-PSS');
      }
    });

    it('reaches signHash with the PKCS#1 v1.5 OID when both RSA modes are on offer', async () => {
      const provider = installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({
          status: 'enabled',
          algo: [OID_RSASSA_PSS, OID_RSA_ENCRYPTION],
        }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await signer.sign(DOCUMENT_BYTES, 'SHA-256');

      expect(provider.requestsTo('/csc/v2/signatures/signHash')[0].body.signAlgo).toBe(OID_RSA_ENCRYPTION);
    });

    it('prefers PKCS#1 v1.5 when a credential offers both RSA padding modes', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({
          status: 'enabled',
          algo: ['1.2.840.113549.1.1.10', '1.2.840.113549.1.1.1'],
        }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      expect(signer.signatureAlgorithm).toBe('RSASSA-PKCS1-v1_5');
    });

    it('derives ECDSA from an id-ecPublicKey credential and omits hashAlgo', async () => {
      const provider = installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute(
          {
            status: 'enabled',
            algo: [ecCredential.keyAlgorithmOid],
            curve: '1.2.840.10045.3.1.7',
          },
          [ecCredential.certificateDer],
        ),
        '/csc/v2/signatures/signHash': createSignHashRoute({ credential: ecCredential, documents: DOCUMENTS }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      expect(signer.keyType).toBe('EC');
      expect(signer.signatureAlgorithm).toBe('ECDSA');

      await signer.sign(DOCUMENT_BYTES, 'SHA-384');

      const signHash = provider.requestsTo('/csc/v2/signatures/signHash')[0];

      expect(signHash.body.signAlgo).toBe('1.2.840.10045.4.3.3');
      expect(signHash.body).not.toHaveProperty('hashAlgo');
    });

    it('fails loudly at signer creation when no advertised algorithm is supported', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: ['1.2.840.113549.1.1.11'] }),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(CscError);
      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/no signature algorithm this build supports/);
    });

    it('fails at signer creation when the credential key is not enabled', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'disabled', algo: ['1.2.840.113549.1.1.1'] }),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/key status "disabled"/);
    });

    it('throws rather than signing when the credential algorithm fixes a different digest', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: ['1.2.840.10045.4.3.2'] }, [
          ecCredential.certificateDer,
        ]),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-512')).rejects.toThrow(/cannot sign a SHA-512 digest/);
    });
  });

  describe('configuration failures', () => {
    it('rejects a non-https provider base URL', async () => {
      installCscMockProvider(happyPathRoutes);

      await expect(CscSigner.create({ ...SIGNER_OPTIONS, baseUrl: 'http://csc.example.test' })).rejects.toThrow(
        /must use https/,
      );
    });
  });

  describe('failure paths never yield bytes', () => {
    it('throws when the token request fails', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/oauth2/token': () => ({ status: 401, body: { error: 'invalid_client' } }),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(CscError);
    });

    it('throws when the token expires between creation and signing', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      let tokenCalls = 0;

      installCscMockProvider({
        ...happyPathRoutes,
        '/oauth2/token': () => {
          tokenCalls += 1;

          return tokenCalls === 1
            ? { body: { access_token: 'bearer-1', expires_in: 3600 } }
            : { status: 400, body: { error: 'invalid_grant', error_description: 'the service account was revoked' } };
        },
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(/invalid_grant/);

      vi.useRealTimers();
    });

    it('throws when authorisation is refused', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/authorize': () => ({ status: 403, body: { error: 'invalid_pin' } }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(/HTTP 403/);
    });

    it('throws when signHash fails', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/signatures/signHash': () => ({ status: 500, body: { error: 'internal_error' } }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(/HTTP 500/);
    });

    it('throws when the provider returns no signatures', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/signatures/signHash': () => ({ body: { signatures: [] } }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(CscError);
    });

    it('throws when the provider returns an empty signature value', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/signatures/signHash': () => ({ body: { signatures: [''] } }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(CscError);
    });

    it('throws when the network call itself fails', async () => {
      installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('socket hang up'))),
      );

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(/could not be completed: socket hang up/);
    });
  });

  describe('the provider answer is verified before it is embedded', () => {
    it('rejects a signature made by a key that is not the credential key', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/signatures/signHash': createSignHashRoute({
          credential: strangerCredential,
          documents: DOCUMENTS,
        }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(/does not verify against/);
    });

    it('rejects a signature over bytes other than the ones libpdf asked to cover', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/signatures/signHash': () => ({
          body: {
            signatures: [base64(rsaCredential.sign(OTHER_DOCUMENT_BYTES, 'SHA-256'))],
          },
        }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(CscError);
    });

    it('rejects a signature with a single flipped byte', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/signatures/signHash': createSignHashRoute({
          credential: rsaCredential,
          documents: DOCUMENTS,
          corrupt: (signature) => {
            const mangled = Uint8Array.from(signature);

            mangled[0] ^= 0xff;

            return mangled;
          },
        }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(/does not verify against/);
    });

    it('rejects an ECDSA signature encoded as a raw pair rather than DER', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [ecCredential.keyAlgorithmOid] }, [
          ecCredential.certificateDer,
        ]),
        '/csc/v2/signatures/signHash': createSignHashRoute({
          credential: ecCredential,
          documents: DOCUMENTS,
          corrupt: derEcdsaToRawPair,
        }),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).rejects.toThrow(CscError);
    });

    it('fails at signer creation when the leaf is not a certificate', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [rsaCredential.keyAlgorithmOid] }, [
          new Uint8Array([0x30, 0x82, 0x01, 0x01]),
        ]),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/could not be parsed/);
    });
  });

  describe('the certificate is held against what the provider advertised', () => {
    it('refuses an EC leaf behind an RSA advertisement', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        // The signature would verify: Node reads the real key out of the
        // certificate. libpdf would still label ECDSA bytes with an RSA OID.
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [OID_RSA_ENCRYPTION] }, [
          ecCredential.certificateDer,
        ]),
        '/csc/v2/signatures/signHash': createSignHashRoute({ credential: ecCredential, documents: DOCUMENTS }),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/advertises RSA as its key type/);
    });

    it('refuses an RSA leaf behind an EC advertisement', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [OID_EC_PUBLIC_KEY] }, [LEAF_DER]),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/advertises EC as its key type/);
    });

    it('refuses a leaf whose key is restricted to RSASSA-PSS, whatever the advertisement says', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [OID_RSA_ENCRYPTION] }, [
          pssRestrictedCredential.certificateDer,
        ]),
        '/csc/v2/signatures/signHash': createSignHashRoute({
          credential: pssRestrictedCredential,
          documents: DOCUMENTS,
        }),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/restricts its key to RSASSA-PSS/);
    });

    it('refuses an EC leaf on a curve other than the advertised one', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [OID_EC_PUBLIC_KEY], curve: OID_CURVE_P384 }, [
          ecCredential.certificateDer,
        ]),
      });

      await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(/advertises curve 1\.3\.132\.0\.34/);
    });

    it('accepts an EC leaf on the curve the provider advertised', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [OID_EC_PUBLIC_KEY], curve: OID_CURVE_P256 }, [
          ecCredential.certificateDer,
        ]),
      });

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      expect(signer.keyType).toBe('EC');
    });
  });

  describe('pinning the credential certificate', () => {
    const substitutedProviderRoutes = {
      ...happyPathRoutes,
      // A provider, or anything able to answer as one, returning its own
      // certificate and signing with the matching key. Every internal check
      // passes: the response agrees with itself.
      '/csc/v2/credentials/info': infoRoute({ status: 'enabled', algo: [OID_RSA_ENCRYPTION] }, [
        strangerCredential.certificateDer,
      ]),
      '/csc/v2/signatures/signHash': createSignHashRoute({ credential: strangerCredential, documents: DOCUMENTS }),
    };

    it('signs with a substituted certificate when nothing is pinned', async () => {
      installCscMockProvider(substitutedProviderRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).resolves.toBeInstanceOf(Uint8Array);
      expect(signer.certificate).toEqual(strangerCredential.certificateDer);
    });

    it('refuses that same substitution once the credential is pinned', async () => {
      installCscMockProvider(substitutedProviderRoutes);

      await expect(
        CscSigner.create({ ...SIGNER_OPTIONS, expectedCertificateSha256: fingerprint(LEAF_DER) }),
      ).rejects.toThrow(/Refusing to sign/);
    });

    it('accepts the leaf that matches the pin', async () => {
      installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create({
        ...SIGNER_OPTIONS,
        expectedCertificateSha256: fingerprint(LEAF_DER),
      });

      expect(signer.certificate).toEqual(LEAF_DER);
    });

    it('accepts a pin written the way openssl prints one', async () => {
      installCscMockProvider(happyPathRoutes);

      const openssl = (fingerprint(LEAF_DER).match(/../g) ?? []).join(':').toUpperCase();

      await expect(CscSigner.create({ ...SIGNER_OPTIONS, expectedCertificateSha256: openssl })).resolves.toBeInstanceOf(
        CscSigner,
      );
    });

    it('refuses a pin that is not a SHA-256 fingerprint rather than failing every signature later', async () => {
      installCscMockProvider(happyPathRoutes);

      await expect(CscSigner.create({ ...SIGNER_OPTIONS, expectedCertificateSha256: 'deadbeef' })).rejects.toThrow(
        /must be a SHA-256 fingerprint/,
      );
    });

    it('says so when the credential is left unpinned', async () => {
      installCscMockProvider(happyPathRoutes);

      await CscSigner.create(SIGNER_OPTIONS);

      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/is not pinned/));
    });

    it('stays quiet when the credential is pinned', async () => {
      installCscMockProvider(happyPathRoutes);

      await CscSigner.create({ ...SIGNER_OPTIONS, expectedCertificateSha256: fingerprint(LEAF_DER) });

      expect(console.warn).not.toHaveBeenCalled();
    });

    describe('in production', () => {
      beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'production');
      });

      it('refuses to build an unpinned signer, naming the variable to set', async () => {
        installCscMockProvider(happyPathRoutes);

        await expect(CscSigner.create(SIGNER_OPTIONS)).rejects.toThrow(
          /NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256/,
        );
      });

      it('signs with the leaf that matches the pin', async () => {
        installCscMockProvider(happyPathRoutes);

        const signer = await CscSigner.create({ ...SIGNER_OPTIONS, expectedCertificateSha256: fingerprint(LEAF_DER) });

        await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).resolves.toBeInstanceOf(Uint8Array);
      });

      it('still refuses a substituted certificate once pinned', async () => {
        installCscMockProvider(substitutedProviderRoutes);

        await expect(
          CscSigner.create({ ...SIGNER_OPTIONS, expectedCertificateSha256: fingerprint(LEAF_DER) }),
        ).rejects.toThrow(/Refusing to sign/);
      });
    });

    it('builds an unpinned signer outside production, as before', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      installCscMockProvider(happyPathRoutes);

      const signer = await CscSigner.create(SIGNER_OPTIONS);

      await expect(signer.sign(DOCUMENT_BYTES, 'SHA-256')).resolves.toBeInstanceOf(Uint8Array);
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/is not pinned/));
    });
  });

  describe('secret hygiene', () => {
    it('never puts the configured PIN into an error message', async () => {
      installCscMockProvider({
        ...happyPathRoutes,
        '/csc/v2/credentials/authorize': () => ({
          status: 403,
          body: { error: 'invalid_pin', error_description: 'the PIN was rejected' },
        }),
      });

      const signer = await CscSigner.create({ ...SIGNER_OPTIONS, pin: 'hunter2' });

      const error = await signer.sign(DOCUMENT_BYTES, 'SHA-256').catch((err: unknown) => err);

      expect(String(error)).not.toContain('hunter2');
    });
  });
});
