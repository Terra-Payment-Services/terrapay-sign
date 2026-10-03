import { env } from '@documenso/lib/utils/env';
import type { RevocationProvider } from '@libpdf/core';
import type * as pkijs from 'pkijs';

import { validateCrl } from './crl';
import { CertificateRevokedError, RevocationDataUnavailableError } from './errors';
import { buildOcspRequest, createNonce, validateOcspResponse } from './ocsp';
import { type AddressLookup, guardedFetch, systemLookup } from './safe-fetch';
import {
  authorityInfoAccessUrls,
  bytesToHex,
  crlDistributionPointUrls,
  describeSubject,
  encodedSubject,
  isSelfIssued,
  OID_AD_OCSP,
  parseCertificate,
  serialNumberHex,
} from './x509';

/**
 * A revocation provider that validates what it embeds.
 *
 * `@libpdf/core` builds PAdES B-LT and B-LTA validation data by asking a
 * `RevocationProvider` for an OCSP response or a CRL per certificate in the
 * chain and writing whatever comes back into the document's `/DSS`. Its
 * `DefaultRevocationProvider` returns bytes it has barely looked at: the OCSP
 * response signature is never verified, responder authority is never
 * established, the CertID is never matched to the certificate, no nonce is
 * sent, and `certStatus` is never read. CRLs are not parsed at all. Signing
 * with a revoked certificate therefore succeeds, and the document ends up
 * carrying the very OCSP response that proves the revocation.
 *
 * This provider replaces that. Every response is parsed, verified and matched
 * before it is returned, on the rules set out in `ocsp.ts` and `crl.ts`, and
 * every outbound request goes through the guard in `safe-fetch.ts`.
 *
 * ## Decision one: a revoked signing certificate stops the operation
 *
 * When a responder we have verified says revoked, the provider records the
 * verdict and throws `CertificateRevokedError` rather than returning the
 * response. Embedding it would be worse than useless, and continuing would
 * produce a document whose own evidence contradicts its signature.
 *
 * Throwing from the provider is necessary but not sufficient, because the
 * library swallows provider exceptions: `LtvDataGatherer.gatherRevocationData`
 * wraps each `getOCSP` call in `try { ... } catch {}` and each `getCRL` call in
 * a catch that only pushes a `REVOCATION_UNAVAILABLE` warning. Nothing a
 * provider throws can abort `pdf.sign()` from inside. So the verdict is also
 * recorded in this provider's ledger, and the caller asserts on it after the
 * sign call returns. `signPdf` calls `assertComplete()` before it returns the
 * bytes, so a revoked chain means no document reaches the caller.
 *
 * The alternative considered was checking the signer's own chain before
 * calling `pdf.sign()`. Rejected: it doubles the OCSP traffic, and it cannot
 * see the timestamp authority's chain, which the library fetches on its own
 * and which a B-LTA document depends on just as much.
 *
 * ## Decision two: unverifiable evidence is not silently downgraded
 *
 * The default provider returns null after a `console.warn` whenever a fetch or
 * a parse fails, so the document is written with a `/DSS` that claims long
 * term validity while carrying no revocation evidence for part of the chain.
 * That is the failure mode most likely to go unnoticed, because the output
 * looks exactly like a successful B-LT signature.
 *
 * The default here is to fail the signing. `assertComplete()` throws
 * `RevocationDataUnavailableError` listing every certificate whose status
 * could not be established. A document that cannot prove its chain was
 * unrevoked at signing time should not be produced under a B-LT claim.
 *
 * It is configurable, and the reason is availability rather than taste: a
 * responder outage at a CA would otherwise stop an installation signing
 * anything at all, and an operator may reasonably prefer a B-T signature to no
 * signature. Setting `NEXT_PRIVATE_SIGNING_REVOCATION_MODE=permissive`
 * downgrades unavailability to a loud warning naming each certificate. It does
 * not, and cannot, downgrade a revocation verdict: `assertComplete()` throws on
 * a revoked certificate in either mode.
 *
 * Certificates that are self-issued and publish no revocation source are
 * treated as trust anchors and exempted. A root's revocation is handled by
 * removing it from the trust store, not by asking it about itself.
 *
 * ## A certificate that publishes no revocation source at all
 *
 * This is recorded as `no-source` and warns rather than failing, in either
 * mode. It is a different thing from a responder being unreachable, and the
 * difference matters. Absence of an AIA and a CRL distribution point is a
 * permanent, authentic property of the certificate: it is covered by the
 * issuer's signature, so it cannot have been stripped, and no verifier
 * anywhere can check that certificate either. Refusing to sign would be
 * demanding evidence that does not exist and never will.
 *
 * A responder that is published but unreachable or unverifiable stays
 * `unresolved` and still fails in strict mode, because there the evidence is
 * supposed to exist and we could not get it, which is the case worth stopping
 * for.
 *
 * The consequence is that an internally issued certificate with no revocation
 * infrastructure will sign, and the signature cannot carry long term validity
 * for that certificate. If that matters, the fix is at the certificate
 * authority, by publishing a CRL distribution point and serving a CRL, rather
 * than in this code.
 */

/** How to treat a certificate whose revocation status could not be established. */
export type RevocationMode = 'strict' | 'permissive';

type OutcomeStatus = 'good' | 'revoked' | 'unresolved' | 'exempt' | 'no-source';

type CertificateOutcome = {
  status: OutcomeStatus;
  subject: string;
  serialNumber: string;
  detail: string;
  revokedAt?: Date;
};

export type ValidatingRevocationProviderOptions = {
  /** @default the value of NEXT_PRIVATE_SIGNING_REVOCATION_MODE, else 'strict' */
  mode?: RevocationMode;
  /** @default globalThis.fetch */
  fetchFn?: typeof fetch;
  /** @default a DNS lookup of both address families */
  lookup?: AddressLookup;
  /** @default 15000 */
  timeoutMs?: number;
  /** @default 1048576 for OCSP, 5242880 for CRLs */
  maxOcspResponseBytes?: number;
  maxCrlResponseBytes?: number;
  /** @default () => new Date() */
  now?: () => Date;
  /** Tolerance either side of a validity window. @default 300000 */
  clockSkewMs?: number;
  /** @default console.warn */
  warn?: (message: string) => void;
};

export type ValidatingRevocationProvider = Required<Pick<RevocationProvider, 'getOCSP' | 'getCRL'>> & {
  /**
   * Throw unless every certificate the library asked about has a revocation
   * status we established. Call this before using the signed bytes.
   */
  /**
   * @param options.expectChecks - Whether a check was supposed to have run. When
   *   true, an empty ledger is itself a failure: it means the signing library
   *   never consulted this provider and nothing was verified.
   */
  assertComplete: (options?: { expectChecks?: boolean }) => void;
  /** The ledger, for tests and for a caller that wants to log the detail. */
  outcomes: () => CertificateOutcome[];
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** An OCSP response is a few kilobytes. A megabyte is already generous. */
const DEFAULT_MAX_OCSP_BYTES = 1_048_576;

/** CRLs from a large CA run to megabytes, so the cap has to be looser. */
const DEFAULT_MAX_CRL_BYTES = 5_242_880;

const DEFAULT_CLOCK_SKEW_MS = 300_000;

const resolveMode = (): RevocationMode =>
  env('NEXT_PRIVATE_SIGNING_REVOCATION_MODE') === 'permissive' ? 'permissive' : 'strict';

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Only ever moves towards certainty: good beats unresolved, revoked beats all. */
const shouldReplace = (current: CertificateOutcome | undefined, next: OutcomeStatus): boolean => {
  if (!current) {
    return true;
  }

  if (current.status === 'revoked') {
    return false;
  }

  if (next === 'revoked') {
    return true;
  }

  // 'no-source' is provisional in the same way 'unresolved' is: the OCSP path
  // records it, and the CRL path may still find an answer afterwards.
  const provisional = current.status === 'unresolved' || current.status === 'no-source';

  return provisional ? next !== 'unresolved' && next !== 'no-source' : false;
};

export const createValidatingRevocationProvider = (
  options: ValidatingRevocationProviderOptions = {},
): ValidatingRevocationProvider => {
  const mode = options.mode ?? resolveMode();
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const lookup = options.lookup ?? systemLookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOcspResponseBytes = options.maxOcspResponseBytes ?? DEFAULT_MAX_OCSP_BYTES;
  const maxCrlResponseBytes = options.maxCrlResponseBytes ?? DEFAULT_MAX_CRL_BYTES;
  const now = options.now ?? (() => new Date());
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  /** Keyed by the certificate's DER, hex encoded. */
  const outcomes = new Map<string, CertificateOutcome>();

  /** Issuers learned from getOCSP calls, so getCRL can verify a signature. */
  const issuerByCertificate = new Map<string, Uint8Array>();

  /** Every certificate seen, keyed by its encoded subject, for issuer lookup. */
  const certificatesBySubject = new Map<string, Uint8Array>();

  const record = (key: string, outcome: CertificateOutcome): void => {
    if (shouldReplace(outcomes.get(key), outcome.status)) {
      outcomes.set(key, outcome);
    }
  };

  const revokedError = (outcome: CertificateOutcome): CertificateRevokedError =>
    new CertificateRevokedError(
      `Certificate "${outcome.subject}" (serial ${outcome.serialNumber}) is revoked: ${outcome.detail}`,
      { subject: outcome.subject, serialNumber: outcome.serialNumber, revokedAt: outcome.revokedAt },
    );

  const remember = (der: Uint8Array, certificate: pkijs.Certificate): void => {
    certificatesBySubject.set(bytesToHex(encodedSubject(certificate)), der);
  };

  /**
   * `getCRL` is handed only the certificate, so the issuer needed to check the
   * CRL signature has to come from somewhere else: the `getOCSP` call the
   * library makes first for the same certificate, another certificate in the
   * chain whose subject matches, or the certificate itself when self-issued.
   */
  const resolveIssuer = (key: string, certificate: pkijs.Certificate, der: Uint8Array): pkijs.Certificate | null => {
    const candidate =
      issuerByCertificate.get(key) ??
      certificatesBySubject.get(bytesToHex(new Uint8Array(certificate.issuer.toSchema().toBER(false)))) ??
      (isSelfIssued(certificate) ? der : undefined);

    if (!candidate) {
      return null;
    }

    try {
      return parseCertificate(candidate, 'issuer');
    } catch {
      return null;
    }
  };

  const getOCSP = async (cert: Uint8Array, issuerDer: Uint8Array): Promise<Uint8Array | null> => {
    const key = bytesToHex(cert);
    const existing = outcomes.get(key);

    if (existing?.status === 'revoked') {
      throw revokedError(existing);
    }

    let certificate: pkijs.Certificate;
    let issuer: pkijs.Certificate;

    try {
      certificate = parseCertificate(cert, 'subject');
      issuer = parseCertificate(issuerDer, 'issuer');
    } catch (error) {
      record(key, {
        status: 'unresolved',
        subject: '(unparseable certificate)',
        serialNumber: '(unknown)',
        detail: describeError(error),
      });

      return null;
    }

    // Prove the issuer actually issued this certificate before believing
    // anything signed by it.
    //
    // The issuer arrives from the chain the signing library built, and that
    // chain can include a certificate fetched over plain HTTP from a URL named
    // inside another certificate. Without this check, an attacker who can
    // answer that fetch supplies a certificate carrying the expected subject
    // name and their own key, then signs a "good" OCSP response with it. The
    // CertID hashes are recomputed from that same forged issuer, so everything
    // downstream agrees with itself and a revoked certificate records as good.
    try {
      if (!(await certificate.verify(issuer))) {
        throw new Error('signature does not verify under the supplied issuer key');
      }
    } catch (error) {
      record(key, {
        status: 'unresolved',
        subject: describeSubject(certificate),
        serialNumber: serialNumberHex(certificate),
        detail: `issuer certificate does not appear to have issued this certificate (${describeError(error)})`,
      });

      return null;
    }

    issuerByCertificate.set(key, issuerDer);
    remember(cert, certificate);
    remember(issuerDer, issuer);

    const subject = describeSubject(certificate);
    const serialNumber = serialNumberHex(certificate);
    const urls = authorityInfoAccessUrls(certificate, OID_AD_OCSP);

    if (urls.length === 0) {
      // No responder named. The CRL path gets its turn and records the outcome.
      return null;
    }

    let lastFailure = 'no OCSP responder could be reached';

    for (const url of urls) {
      try {
        const nonce = createNonce();
        const request = await buildOcspRequest({ certificate, issuer, nonce });

        const response = await guardedFetch({
          url,
          method: 'POST',
          headers: { 'content-type': 'application/ocsp-request', accept: 'application/ocsp-response' },
          body: request,
          timeoutMs,
          maxResponseBytes: maxOcspResponseBytes,
          fetchFn,
          lookup,
        });

        const result = await validateOcspResponse({
          response,
          certificate,
          issuer,
          nonce,
          now: now(),
          clockSkewMs,
        });

        if (result.status === 'revoked') {
          const outcome: CertificateOutcome = {
            status: 'revoked',
            subject,
            serialNumber,
            detail: `OCSP responder at ${url} reports it revoked${result.revokedAt ? ` at ${result.revokedAt.toISOString()}` : ''}`,
            revokedAt: result.revokedAt,
          };

          record(key, outcome);

          throw revokedError(outcome);
        }

        record(key, { status: 'good', subject, serialNumber, detail: `verified OCSP response from ${url}` });

        return response;
      } catch (error) {
        if (error instanceof CertificateRevokedError) {
          throw error;
        }

        lastFailure = `${url}: ${describeError(error)}`;
      }
    }

    record(key, { status: 'unresolved', subject, serialNumber, detail: `OCSP check failed (${lastFailure})` });

    return null;
  };

  const getCRL = async (cert: Uint8Array): Promise<Uint8Array | null> => {
    const key = bytesToHex(cert);
    const existing = outcomes.get(key);

    if (existing?.status === 'revoked') {
      throw revokedError(existing);
    }

    let certificate: pkijs.Certificate;

    try {
      certificate = parseCertificate(cert, 'subject');
    } catch (error) {
      record(key, {
        status: 'unresolved',
        subject: '(unparseable certificate)',
        serialNumber: '(unknown)',
        detail: describeError(error),
      });

      return null;
    }

    remember(cert, certificate);

    const subject = describeSubject(certificate);
    const serialNumber = serialNumberHex(certificate);
    const urls = crlDistributionPointUrls(certificate);

    if (urls.length === 0) {
      if (!existing) {
        record(
          key,
          isSelfIssued(certificate)
            ? {
                status: 'exempt',
                subject,
                serialNumber,
                detail: 'self-issued trust anchor, revocation is handled by the trust store',
              }
            : {
                status: 'no-source',
                subject,
                serialNumber,
                detail: 'certificate names no OCSP responder and no CRL distribution point',
              },
        );
      }

      return null;
    }

    const issuer = resolveIssuer(key, certificate, cert);

    if (!issuer) {
      record(key, {
        status: 'unresolved',
        subject,
        serialNumber,
        detail: 'no issuer certificate available to verify the CRL signature',
      });

      return null;
    }

    let lastFailure = 'no CRL distribution point could be reached';

    for (const url of urls) {
      try {
        const crl = await guardedFetch({
          url,
          method: 'GET',
          headers: { accept: 'application/pkix-crl, application/x-pkcs7-crl' },
          timeoutMs,
          maxResponseBytes: maxCrlResponseBytes,
          fetchFn,
          lookup,
        });

        const result = await validateCrl({ crl, certificate, issuer, now: now(), clockSkewMs });

        if (result.status === 'revoked') {
          const outcome: CertificateOutcome = {
            status: 'revoked',
            subject,
            serialNumber,
            detail: `CRL at ${url} lists it as revoked${result.revokedAt ? ` at ${result.revokedAt.toISOString()}` : ''}`,
            revokedAt: result.revokedAt,
          };

          record(key, outcome);

          throw revokedError(outcome);
        }

        record(key, { status: 'good', subject, serialNumber, detail: `verified CRL from ${url}` });

        return crl;
      } catch (error) {
        if (error instanceof CertificateRevokedError) {
          throw error;
        }

        lastFailure = `${url}: ${describeError(error)}`;
      }
    }

    record(key, { status: 'unresolved', subject, serialNumber, detail: `CRL check failed (${lastFailure})` });

    return null;
  };

  const assertComplete = ({ expectChecks = false }: { expectChecks?: boolean } = {}): void => {
    const entries = [...outcomes.values()];

    // An empty ledger used to pass. That is only safe if nothing was supposed
    // to be checked. libpdf calls this provider only when it is asked for long
    // term validation, so when we asked for it and the ledger is empty, the
    // library never consulted us and nothing was verified. Returning success
    // there means a revoked certificate signs cleanly, which is the opposite
    // of what this module exists for.
    if (expectChecks && entries.length === 0) {
      throw new RevocationDataUnavailableError(
        'Long term validity was requested but no revocation check ran, so nothing in the signing chain was ' +
          'verified. The signature would claim evidence it does not have.',
        ['the signing library never called the revocation provider'],
      );
    }
    const revoked = entries.find((outcome) => outcome.status === 'revoked');

    if (revoked) {
      throw revokedError(revoked);
    }

    warnAboutMissingSources();

    const unresolved = entries.filter((outcome) => outcome.status === 'unresolved');

    if (unresolved.length === 0) {
      return;
    }

    const reasons = unresolved.map(
      (outcome) => `"${outcome.subject}" (serial ${outcome.serialNumber}): ${outcome.detail}`,
    );

    if (mode === 'strict') {
      throw new RevocationDataUnavailableError(
        `Revocation status could not be established for ${unresolved.length} certificate(s) in the signing chain, so the signature cannot claim long term validity: ${reasons.join('; ')}`,
        reasons,
      );
    }

    for (const reason of reasons) {
      warn(`[signing] revocation status unavailable, signing anyway in permissive mode: ${reason}`);
    }
  };

  /**
   * Certificates that publish no way to check their revocation at all. Reported
   * on every run, in both modes, because the signature quietly cannot carry
   * long term validity for them and that is worth knowing.
   */
  const warnAboutMissingSources = (): void => {
    for (const outcome of outcomes.values()) {
      if (outcome.status !== 'no-source') {
        continue;
      }

      warn(
        `[signing] "${outcome.subject}" (serial ${outcome.serialNumber}) publishes no revocation source, ` +
          'so the signature cannot claim long term validity for it. Fix this at the certificate authority ' +
          'by publishing a CRL distribution point.',
      );
    }
  };

  return {
    getOCSP,
    getCRL,
    assertComplete,
    outcomes: () => [...outcomes.values()],
  };
};

export { RevocationError } from './errors';
export { CertificateRevokedError, RevocationDataUnavailableError };
