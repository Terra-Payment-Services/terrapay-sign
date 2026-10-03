import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CertificateRevokedError, RevocationDataUnavailableError } from './errors';
import { createValidatingRevocationProvider } from './provider';
import {
  buildCrl,
  buildOcspResponse,
  createIdentity,
  createTestPki,
  fixedLookup,
  publicLookup,
  type TestIdentity,
  type TestPki,
} from './test-support';

const OCSP_URL = 'http://ocsp.example.test/';
const CRL_URL = 'http://crl.example.test/ca.crl';

let pki: TestPki;

beforeAll(async () => {
  pki = await createTestPki({ ocspUrl: OCSP_URL, crlUrl: CRL_URL });
});

type Routes = Record<string, () => Response>;

const router = (routes: Routes) =>
  vi.fn((url: string, _init?: RequestInit) => {
    const route = routes[url];

    return route ? Promise.resolve(route()) : Promise.reject(new Error(`unexpected request to ${url}`));
  });

const derResponse = (bytes: Uint8Array) => () => new Response(bytes.slice() as unknown as BodyInit, { status: 200 });

const createProvider = (fetchFn: ReturnType<typeof router>, overrides = {}) =>
  createValidatingRevocationProvider({
    mode: 'strict',
    fetchFn: fetchFn as unknown as typeof fetch,
    lookup: publicLookup,
    ...overrides,
  });

/**
 * The library wraps every provider call in a catch that discards the error, so
 * a test that wants to model what `pdf.sign()` does has to discard it too.
 */
const asTheLibraryWould = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch {
    // swallowed, exactly as LtvDataGatherer.gatherRevocationData does
  }
};

describe('createValidatingRevocationProvider', () => {
  describe('OCSP', () => {
    it('returns a verified good response and completes', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
      });

      const fetchFn = router({ [OCSP_URL]: derResponse(response) });
      const provider = createProvider(fetchFn);

      await expect(provider.getOCSP(pki.leaf.der, pki.ca.der)).resolves.toEqual(response);
      expect(() => provider.assertComplete()).not.toThrow();
      expect(provider.outcomes()).toMatchObject([{ status: 'good', subject: 'Example Signer' }]);
    });

    it('sends the request as an OCSP POST', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
      });

      const fetchFn = router({ [OCSP_URL]: derResponse(response) });

      await createProvider(fetchFn).getOCSP(pki.leaf.der, pki.ca.der);

      const [, init] = fetchFn.mock.calls[0];

      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(Uint8Array);
    });

    it('throws on a revoked certificate rather than embedding the proof of it', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        status: 'revoked',
        revokedAt: new Date('2026-03-04T05:06:07Z'),
      });

      const fetchFn = router({ [OCSP_URL]: derResponse(response) });
      const provider = createProvider(fetchFn);

      await expect(provider.getOCSP(pki.leaf.der, pki.ca.der)).rejects.toThrow(CertificateRevokedError);
    });

    it('still stops the signing operation when the library swallows the throw', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        status: 'revoked',
      });

      const fetchFn = router({ [OCSP_URL]: derResponse(response) });
      const provider = createProvider(fetchFn);

      await asTheLibraryWould(provider.getOCSP(pki.leaf.der, pki.ca.der));

      expect(() => provider.assertComplete()).toThrow(CertificateRevokedError);
      expect(() => provider.assertComplete()).toThrow(/Example Signer/);
    });

    it('refuses to be talked out of a revocation verdict by a later CRL', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        status: 'revoked',
      });

      const crl = await buildCrl({ issuer: pki.ca });

      const fetchFn = router({ [OCSP_URL]: derResponse(response), [CRL_URL]: derResponse(crl) });
      const provider = createProvider(fetchFn);

      await asTheLibraryWould(provider.getOCSP(pki.leaf.der, pki.ca.der));
      await expect(provider.getCRL(pki.leaf.der)).rejects.toThrow(CertificateRevokedError);
      expect(() => provider.assertComplete()).toThrow(CertificateRevokedError);
    });

    it('returns nothing when the responder is not authorised, and fails the assertion', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.unauthorisedResponder,
      });

      const fetchFn = router({ [OCSP_URL]: derResponse(response), [CRL_URL]: () => new Response('', { status: 404 }) });
      const provider = createProvider(fetchFn);

      await expect(provider.getOCSP(pki.leaf.der, pki.ca.der)).resolves.toBeNull();
      expect(() => provider.assertComplete()).toThrow(RevocationDataUnavailableError);
      expect(() => provider.assertComplete()).toThrow(/id-kp-OCSPSigning/);
    });

    it('refuses a responder URL that resolves into a private range', async () => {
      const internal = await createIdentity({
        commonName: 'Internally Checked Signer',
        serialNumber: 5001,
        issuer: pki.ca,
        ocspUrl: 'http://ocsp.internal.example/',
      });

      const fetchFn = router({});
      const provider = createProvider(fetchFn, { lookup: fixedLookup('127.0.0.1') });

      await expect(provider.getOCSP(internal.der, pki.ca.der)).resolves.toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved' }]);
      expect(() => provider.assertComplete()).toThrow(/not publicly routable/);
    });

    it('refuses a response larger than the cap', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
      });

      const fetchFn = router({ [OCSP_URL]: derResponse(response) });
      const provider = createProvider(fetchFn, { maxOcspResponseBytes: 16 });

      await expect(provider.getOCSP(pki.leaf.der, pki.ca.der)).resolves.toBeNull();
      expect(() => provider.assertComplete()).toThrow(/16 byte cap/);
    });

    it('records an unresolved status when the responder is unreachable', async () => {
      const fetchFn = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

      const provider = createProvider(fetchFn as unknown as ReturnType<typeof router>);

      await expect(provider.getOCSP(pki.leaf.der, pki.ca.der)).resolves.toBeNull();
      expect(() => provider.assertComplete()).toThrow(RevocationDataUnavailableError);
    });

    it('refuses an issuer that did not issue the certificate', async () => {
      // The issuer arrives from the chain the signing library built, and that
      // chain can include a certificate fetched over plain HTTP from a URL
      // named inside another certificate. Someone able to answer that fetch
      // supplies a certificate with the expected subject name and their own
      // key, signs a "good" response with it, and every later check agrees
      // with itself because the CertID hashes are recomputed from the same
      // forgery. Proving the linkage first is what breaks that circle.
      const provider = createProvider(router({}));

      await expect(provider.getOCSP(pki.leaf.der, pki.otherCa.der)).resolves.toBeNull();
      expect(() => provider.assertComplete()).toThrow(/does not appear to have issued/);
    });
  });

  describe('CRL', () => {
    let crlOnly: TestIdentity;

    beforeAll(async () => {
      crlOnly = await createIdentity({
        commonName: 'CRL Only Signer',
        serialNumber: 6001,
        issuer: pki.ca,
        crlUrl: CRL_URL,
      });
    });

    it('falls back to a verified CRL when the certificate names no responder', async () => {
      const crl = await buildCrl({ issuer: pki.ca, revokedSerialNumbers: [4242] });

      const fetchFn = router({ [CRL_URL]: derResponse(crl) });
      const provider = createProvider(fetchFn);

      await expect(provider.getOCSP(crlOnly.der, pki.ca.der)).resolves.toBeNull();
      await expect(provider.getCRL(crlOnly.der)).resolves.toEqual(crl);
      expect(() => provider.assertComplete()).not.toThrow();
    });

    it('throws when the CRL lists the certificate', async () => {
      const crl = await buildCrl({ issuer: pki.ca, revokedSerialNumbers: [6001] });

      const fetchFn = router({ [CRL_URL]: derResponse(crl) });
      const provider = createProvider(fetchFn);

      await provider.getOCSP(crlOnly.der, pki.ca.der);

      await expect(provider.getCRL(crlOnly.der)).rejects.toThrow(CertificateRevokedError);
      expect(() => provider.assertComplete()).toThrow(CertificateRevokedError);
    });

    it('never returns an HTML error page as a CRL', async () => {
      const fetchFn = router({
        [CRL_URL]: () => new Response('<html>503 Service Unavailable</html>', { status: 200 }),
      });

      const provider = createProvider(fetchFn);

      await provider.getOCSP(crlOnly.der, pki.ca.der);

      await expect(provider.getCRL(crlOnly.der)).resolves.toBeNull();
      expect(() => provider.assertComplete()).toThrow(/not a parseable CRL/);
    });

    it('exempts a self-issued trust anchor that publishes no revocation source', async () => {
      const provider = createProvider(router({}));

      await expect(provider.getCRL(pki.ca.der)).resolves.toBeNull();
      expect(provider.outcomes()).toMatchObject([{ status: 'exempt' }]);
      expect(() => provider.assertComplete()).not.toThrow();
    });

    it('warns but signs when an end entity publishes no revocation source', async () => {
      // Absence of an AIA and a CRL distribution point is permanent and
      // authentic: it is covered by the issuer's signature, and no verifier can
      // check that certificate either. Refusing to sign would demand evidence
      // that does not exist. It is reported, not fatal, and the distinction
      // from an unreachable responder is the point of the next test.
      const orphan = await createIdentity({ commonName: 'Unchecked Signer', serialNumber: 7001, issuer: pki.ca });

      const warnings: string[] = [];
      const provider = createProvider(router({}), { warn: (message: string) => warnings.push(message) });

      await expect(provider.getOCSP(orphan.der, pki.ca.der)).resolves.toBeNull();
      await expect(provider.getCRL(orphan.der)).resolves.toBeNull();

      expect(provider.outcomes()).toMatchObject([{ status: 'no-source' }]);
      expect(() => provider.assertComplete()).not.toThrow();
      expect(warnings.join('\n')).toMatch(/publishes no revocation source/);
    });

    it('still fails in strict mode when a published responder cannot be reached', async () => {
      // The case worth stopping for: the certificate says where to check, and
      // we could not get an answer.
      const provider = createProvider(router({}));

      await expect(provider.getOCSP(pki.leaf.der, pki.ca.der)).resolves.toBeNull();
      await expect(provider.getCRL(pki.leaf.der)).resolves.toBeNull();

      expect(() => provider.assertComplete()).toThrow(/could not be established/);
    });
  });

  describe('mode', () => {
    it('warns rather than throwing on unavailable data in permissive mode', async () => {
      const warn = vi.fn();

      const fetchFn = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

      const provider = createValidatingRevocationProvider({
        mode: 'permissive',
        fetchFn: fetchFn as unknown as typeof fetch,
        lookup: publicLookup,
        warn,
      });

      await provider.getOCSP(pki.leaf.der, pki.ca.der);

      expect(() => provider.assertComplete()).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/permissive mode/);
    });

    it('still throws on a revocation verdict in permissive mode', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        status: 'revoked',
      });

      const fetchFn = router({ [OCSP_URL]: derResponse(response) });

      const provider = createValidatingRevocationProvider({
        mode: 'permissive',
        fetchFn: fetchFn as unknown as typeof fetch,
        lookup: publicLookup,
        warn: vi.fn(),
      });

      await asTheLibraryWould(provider.getOCSP(pki.leaf.der, pki.ca.der));

      expect(() => provider.assertComplete()).toThrow(CertificateRevokedError);
    });

    it('passes when nothing was expected to be checked', () => {
      // Correct for a B-B signature, where the library asks for no revocation
      // data at all and an empty ledger genuinely means there was nothing to do.
      expect(() => createProvider(router({})).assertComplete()).not.toThrow();
    });

    it('fails when a check was expected and none ran', () => {
      // The bypass this parameter exists for. libpdf consults the provider only
      // when asked for long term validation, so an empty ledger there means the
      // library never called us and a revoked certificate would sign cleanly.
      expect(() => createProvider(router({})).assertComplete({ expectChecks: true })).toThrow(
        /no revocation check ran/,
      );
    });
  });
});
