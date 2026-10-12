import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CertificateRevokedError, RevocationDataUnavailableError } from './errors';
import { createValidatingRevocationProvider } from './provider';
import {
  buildCrl,
  buildOcspResponse,
  createCrossSignedRoot,
  createForgedCertificate,
  createIdentity,
  createTestPki,
  fixedLookup,
  publicLookup,
  type TestIdentity,
  type TestPki,
} from './test-support';
import { parseCertificate } from './x509';

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

/**
 * Known issuers: certificates the provider may use to verify a CRL signature
 * when nothing else in the chain names the issuer. They are never anchors and
 * never exempt anything. See the issue 48 specification.
 */
describe('known issuers', () => {
  const KNOWN_CRL_URL = 'http://crl.known.test/known.crl';
  const KNOWN_OCSP_URL = 'http://ocsp.known.test/';
  const FIXTURES = path.join(__dirname, '__fixtures__');
  const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

  /** Stands in for USERTrust: the issuer the chain never contains. */
  let known: TestIdentity;
  /** Stands in for R46: issued by `known`, with a CRL URL and an OCSP URL and no caIssuers. */
  let cross: TestIdentity;
  let knownCrl: Uint8Array;

  beforeAll(async () => {
    known = await createIdentity({ commonName: 'Known Root', serialNumber: 5, isCa: true });

    ({ crossSigned: cross } = await createCrossSignedRoot({
      commonName: 'Cross Signed Root',
      issuer: known,
      crlUrl: KNOWN_CRL_URL,
      ocspUrl: KNOWN_OCSP_URL,
    }));

    knownCrl = await buildCrl({ issuer: known });
  });

  const crlFetch = (routes: Routes = {}) => router({ [KNOWN_CRL_URL]: derResponse(knownCrl), ...routes });

  const crlRequests = (fetchFn: ReturnType<typeof router>, url: string) =>
    fetchFn.mock.calls.filter(([requested]) => requested === url).length;

  describe('resolving an issuer the chain does not contain', () => {
    // F1, baseline: without a known issuer this is the production failure and
    // must stay unresolved, so that the option is what changes the outcome.
    it('leaves a cross-signed root unresolved when no known issuer is given', async () => {
      const fetchFn = crlFetch();
      const provider = createProvider(fetchFn);

      await expect(provider.getCRL(cross.der)).resolves.toBeNull();

      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved', detail: /no issuer certificate available/ }]);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(() => provider.assertComplete()).toThrow(RevocationDataUnavailableError);
    });

    // F1
    it('records a cross-signed root as good once its issuer is a known issuer', async () => {
      const fetchFn = crlFetch();
      const provider = createProvider(fetchFn, { knownIssuers: [known.der] });

      await provider.getCRL(cross.der);

      expect(provider.outcomes()).toMatchObject([{ status: 'good', subject: 'Cross Signed Root' }]);
      expect(() => provider.assertComplete()).not.toThrow();
    });

    // F6
    it('returns the validated CRL bytes so the library embeds them', async () => {
      const provider = createProvider(crlFetch(), { knownIssuers: [known.der] });

      const returned = await provider.getCRL(cross.der);

      expect(returned).toEqual(knownCrl);
    });

    // F1, and the verdict still comes from the CRL, not from the issuer's mere presence
    it('reports a certificate the known issuer revoked as revoked', async () => {
      const revokedCrl = await buildCrl({ issuer: known, revokedSerialNumbers: [51] });
      const provider = createProvider(crlFetch({ [KNOWN_CRL_URL]: derResponse(revokedCrl) }), {
        knownIssuers: [known.der],
      });

      await expect(provider.getCRL(cross.der)).rejects.toThrow(CertificateRevokedError);
      expect(() => provider.assertComplete()).toThrow(CertificateRevokedError);
    });

    // F1: a known issuer whose CRL is not valid gets no credit
    it('stays unresolved when the CRL is not signed by the known issuer', async () => {
      const forgedCrl = await buildCrl({ issuer: await createIdentity({ commonName: 'Known Root', serialNumber: 9 }) });
      const provider = createProvider(crlFetch({ [KNOWN_CRL_URL]: derResponse(forgedCrl) }), {
        knownIssuers: [known.der],
      });

      await expect(provider.getCRL(cross.der)).resolves.toBeNull();
      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved' }]);
    });

    // F8: the real certificates. The bundled USERTrust root must verify the
    // real Sectigo R46 cross-certificate, and the provider must then accept
    // the real USERTrust CRL for it. "now" is fixed inside the CRL's window.
    it('verifies the real Sectigo R46 cross-certificate under the real USERTrust root', async () => {
      const usertrust = parseCertificate(fixture('usertrust-rsa-certification-authority.crt'), 'issuer');
      const r46 = parseCertificate(fixture('sectigo-time-stamping-root-r46-cross.crt'), 'subject');

      await expect(r46.verify(usertrust)).resolves.toBe(true);
    });

    // F8
    it('records the real R46 as good from the real USERTrust CRL', async () => {
      const realCrl = fixture('usertrust-rsa-certification-authority.crl');
      const realUrl = 'http://crl.usertrust.com/USERTrustRSACertificationAuthority.crl';
      const fetchFn = router({ [realUrl]: derResponse(realCrl) });

      const provider = createProvider(fetchFn, {
        knownIssuers: [fixture('usertrust-rsa-certification-authority.crt')],
        now: () => new Date('2026-10-10T12:00:00Z'),
      });

      const returned = await provider.getCRL(fixture('sectigo-time-stamping-root-r46-cross.crt'));

      expect(returned).toEqual(realCrl);
      expect(provider.outcomes()).toMatchObject([{ status: 'good', subject: expect.stringContaining('R46') }]);
    });
  });

  describe('the issuer must have signed the certificate', () => {
    // F2: the certificate names the known issuer but another key signed it.
    // The CRL it points at is a genuine one from the known issuer, which does
    // not list it, so trusting the name alone would record it as good.
    it('does not use a known issuer that did not sign the certificate', async () => {
      const forged = await createForgedCertificate({
        commonName: 'Forged Signer',
        claimedIssuer: known,
        crlUrl: KNOWN_CRL_URL,
      });

      const fetchFn = crlFetch();
      const provider = createProvider(fetchFn, { knownIssuers: [known.der] });

      await expect(provider.getCRL(forged.der)).resolves.toBeNull();

      expect(fetchFn).not.toHaveBeenCalled();
      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved', subject: 'Forged Signer' }]);
      expect(provider.outcomes()[0].detail).toMatch(/issue/i);
      expect(provider.outcomes()[0].detail).not.toMatch(/no issuer certificate available/);
      expect(() => provider.assertComplete()).toThrow(RevocationDataUnavailableError);
    });

    // F7: the issuer comes from the index of certificates seen so far
    it('does not use a look-alike issuer found in the chain index', async () => {
      // A certificate that carries the real CA's name and a key of its own.
      const lookAlike = await createIdentity({ commonName: 'Example Signing CA', serialNumber: 99, isCa: true });
      const lookAlikeCrl = await buildCrl({ issuer: lookAlike });

      const fetchFn = router({ [CRL_URL]: derResponse(lookAlikeCrl) });
      const provider = createProvider(fetchFn);

      // The library asks about it first, which puts it in the index.
      await provider.getCRL(lookAlike.der);

      await expect(provider.getCRL(pki.leaf.der)).resolves.toBeNull();

      expect(fetchFn).not.toHaveBeenCalled();
      expect(provider.outcomes().find((outcome) => outcome.subject === 'Example Signer')).toMatchObject({
        status: 'unresolved',
      });
      expect(() => provider.assertComplete()).toThrow(RevocationDataUnavailableError);
    });

    // F7: the issuer is the certificate itself, because it says it is self-issued
    it('does not treat a certificate as its own issuer unless its signature verifies under its own key', async () => {
      const other = await createIdentity({ commonName: 'Other Key Holder', serialNumber: 3 });
      const selfNamed = await createIdentity({
        commonName: 'Self Named',
        serialNumber: 98,
        isCa: true,
        crlUrl: CRL_URL,
        signingKey: other.privateKey,
      });

      const fetchFn = router({ [CRL_URL]: derResponse(await buildCrl({ issuer: selfNamed })) });
      const provider = createProvider(fetchFn);

      await expect(provider.getCRL(selfNamed.der)).resolves.toBeNull();

      expect(fetchFn).not.toHaveBeenCalled();
      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved' }]);
    });

    // Regression guard for F7: the check must not reject honest issuers.
    it('still uses a genuine issuer found in the chain index', async () => {
      const crl = await buildCrl({ issuer: pki.ca });
      const provider = createProvider(router({ [CRL_URL]: derResponse(crl) }));

      await provider.getCRL(pki.ca.der);

      await expect(provider.getCRL(pki.leaf.der)).resolves.toEqual(crl);
      expect(provider.outcomes().find((outcome) => outcome.subject === 'Example Signer')).toMatchObject({
        status: 'good',
      });
    });

    // Regression guard for F7
    it('still accepts a genuine self-signed certificate that publishes a CRL', async () => {
      const root = await createIdentity({ commonName: 'Self Signed With CRL', serialNumber: 97, crlUrl: CRL_URL });
      const crl = await buildCrl({ issuer: root });
      const provider = createProvider(router({ [CRL_URL]: derResponse(crl) }));

      await expect(provider.getCRL(root.der)).resolves.toEqual(crl);
      expect(provider.outcomes()).toMatchObject([{ status: 'good' }]);
    });

    // F7: the issuer the library passed to getOCSP, reused by getCRL
    it('still uses the issuer an earlier getOCSP call supplied', async () => {
      const crl = await buildCrl({ issuer: pki.ca });
      const fetchFn = router({
        [OCSP_URL]: () => new Response('', { status: 500 }),
        [CRL_URL]: derResponse(crl),
      });
      const provider = createProvider(fetchFn);

      await asTheLibraryWould(provider.getOCSP(pki.leaf.der, pki.ca.der));

      await expect(provider.getCRL(pki.leaf.der)).resolves.toEqual(crl);
    });
  });

  describe('known issuers confer nothing by themselves', () => {
    // F4
    it('adds nothing to the outcomes when nothing asked about them', () => {
      const provider = createProvider(crlFetch(), { knownIssuers: [known.der] });

      expect(provider.outcomes()).toEqual([]);
    });

    // F4
    it('does not make an empty ledger count as a completed check', () => {
      const provider = createProvider(crlFetch(), { knownIssuers: [known.der] });

      expect(() => provider.assertComplete({ expectChecks: true })).toThrow(RevocationDataUnavailableError);
    });

    // F4: a known issuer is not an exemption for a certificate that merely resembles it
    it('does not exempt a certificate whose issuer is a known issuer', async () => {
      const provider = createProvider(router({}), { knownIssuers: [known.der] });

      await provider.getCRL(cross.der);

      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved' }]);
      expect(provider.outcomes()).not.toContainEqual(expect.objectContaining({ status: 'exempt' }));
    });

    // F4: the index entry serves getCRL only. getOCSP uses the issuer it is handed.
    it('does not let getOCSP use a known issuer in place of the one it was handed', async () => {
      const fetchFn = router({});
      const provider = createProvider(fetchFn, { knownIssuers: [pki.ca.der] });

      await expect(provider.getOCSP(pki.leaf.der, pki.otherCa.der)).resolves.toBeNull();

      expect(fetchFn).not.toHaveBeenCalled();
      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved' }]);
    });

    // F4: names are not enough; a known issuer with a different name resolves nothing
    it('ignores a known issuer whose name is not the certificate issuer', async () => {
      const fetchFn = crlFetch();
      const provider = createProvider(fetchFn, { knownIssuers: [pki.otherCa.der] });

      await expect(provider.getCRL(cross.der)).resolves.toBeNull();

      expect(fetchFn).not.toHaveBeenCalled();
      expect(provider.outcomes()).toMatchObject([{ status: 'unresolved', detail: /no issuer certificate available/ }]);
    });
  });

  describe('the CRL cache', () => {
    // F9
    it('fetches a CRL once for repeated requests about the same certificate', async () => {
      const fetchFn = crlFetch();
      const provider = createProvider(fetchFn, { knownIssuers: [known.der] });

      const first = await provider.getCRL(cross.der);
      const second = await provider.getCRL(cross.der);

      expect(crlRequests(fetchFn, KNOWN_CRL_URL)).toBe(1);
      expect(second).toEqual(first);
    });

    // F9: the cache holds the list, not the verdict
    it('still checks each certificate against a cached CRL', async () => {
      const second = await createIdentity({
        commonName: 'Second Signer',
        serialNumber: 1004,
        issuer: pki.ca,
        crlUrl: CRL_URL,
      });

      const crl = await buildCrl({ issuer: pki.ca, revokedSerialNumbers: [1004] });
      const fetchFn = router({ [CRL_URL]: derResponse(crl) });
      const provider = createProvider(fetchFn);

      await asTheLibraryWould(provider.getOCSP(pki.leaf.der, pki.ca.der));
      await expect(provider.getCRL(pki.leaf.der)).resolves.toEqual(crl);
      await expect(provider.getCRL(second.der)).rejects.toThrow(CertificateRevokedError);

      expect(crlRequests(fetchFn, CRL_URL)).toBe(1);
    });

    // F9, and F2: a cached list is keyed by issuer too, so a forgery cannot ride on it
    it('does not serve a cached CRL to a certificate the issuer did not sign', async () => {
      const forged = await createForgedCertificate({
        commonName: 'Forged Signer',
        claimedIssuer: pki.ca,
        crlUrl: CRL_URL,
      });

      const crl = await buildCrl({ issuer: pki.ca });
      const fetchFn = router({ [CRL_URL]: derResponse(crl) });
      const provider = createProvider(fetchFn, { knownIssuers: [pki.ca.der] });

      await expect(provider.getCRL(pki.leaf.der)).resolves.toEqual(crl);
      await expect(provider.getCRL(forged.der)).resolves.toBeNull();

      expect(crlRequests(fetchFn, CRL_URL)).toBe(1);
      expect(provider.outcomes().find((outcome) => outcome.subject === 'Forged Signer')).toMatchObject({
        status: 'unresolved',
      });
    });

    // F9: a failure is not remembered
    it('fetches again after a failed fetch', async () => {
      let healthy = false;
      const fetchFn = vi.fn((_url: string) =>
        Promise.resolve(healthy ? derResponse(knownCrl)() : new Response('', { status: 503 })),
      );
      const provider = createProvider(fetchFn as unknown as ReturnType<typeof router>, { knownIssuers: [known.der] });

      await expect(provider.getCRL(cross.der)).resolves.toBeNull();

      healthy = true;

      await expect(provider.getCRL(cross.der)).resolves.toEqual(knownCrl);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(provider.outcomes()).toMatchObject([{ status: 'good' }]);
    });

    // F9: a CRL that failed validation is not remembered either
    it('fetches again after a CRL that failed validation', async () => {
      const wrongSigner = await createIdentity({ commonName: 'Known Root', serialNumber: 9 });
      const badCrl = await buildCrl({ issuer: wrongSigner });
      let served = badCrl;
      const fetchFn = vi.fn((_url: string) => Promise.resolve(derResponse(served)()));
      const provider = createProvider(fetchFn as unknown as ReturnType<typeof router>, { knownIssuers: [known.der] });

      await expect(provider.getCRL(cross.der)).resolves.toBeNull();

      served = knownCrl;

      await expect(provider.getCRL(cross.der)).resolves.toEqual(knownCrl);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    // F9: two providers share nothing
    it('does not share a cache between providers', async () => {
      const fetchFn = crlFetch();

      await createProvider(fetchFn, { knownIssuers: [known.der] }).getCRL(cross.der);
      await createProvider(fetchFn, { knownIssuers: [known.der] }).getCRL(cross.der);

      expect(crlRequests(fetchFn, KNOWN_CRL_URL)).toBe(2);
    });
  });
});
