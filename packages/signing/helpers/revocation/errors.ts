/**
 * Error types raised while establishing the revocation status of a
 * certificate.
 *
 * Two kinds matter to a caller, and they are deliberately distinct:
 *
 * - `CertificateRevokedError` is a verdict. A responder we trust told us, in a
 *   message we verified, that the certificate is revoked. Signing must stop.
 * - `RevocationDataUnavailableError` is an absence of a verdict. We could not
 *   fetch, parse or verify the evidence, so the status is unknown. Whether
 *   that stops signing depends on the provider's mode.
 */

/** Base type for everything this module throws, so a caller can catch once. */
export class RevocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevocationError';
  }
}

/**
 * The certificate is revoked, on the word of a responder whose signature and
 * authority we checked.
 */
export class CertificateRevokedError extends RevocationError {
  /** Subject of the revoked certificate, for the operator reading the log. */
  readonly subject: string;
  /** Serial number in hex, as it appears in the revocation evidence. */
  readonly serialNumber: string;
  /** When the certificate was revoked, where the responder said so. */
  readonly revokedAt?: Date;

  constructor(message: string, details: { subject: string; serialNumber: string; revokedAt?: Date }) {
    super(message);
    this.name = 'CertificateRevokedError';
    this.subject = details.subject;
    this.serialNumber = details.serialNumber;
    this.revokedAt = details.revokedAt;
  }
}

/**
 * Revocation evidence could not be obtained or could not be trusted.
 *
 * Raised by `assertComplete()` in strict mode, listing every certificate whose
 * status is unknown. Never raised for a certificate whose status we did
 * establish.
 */
export class RevocationDataUnavailableError extends RevocationError {
  /** One entry per certificate, in the order the chain was walked. */
  readonly reasons: string[];

  constructor(message: string, reasons: string[]) {
    super(message);
    this.name = 'RevocationDataUnavailableError';
    this.reasons = reasons;
  }
}

/** A response was fetched but is malformed, unverifiable or does not apply. */
export class RevocationCheckError extends RevocationError {
  constructor(message: string) {
    super(message);
    this.name = 'RevocationCheckError';
  }
}

/** The outbound request was refused, timed out, or came back oversized. */
export class RevocationFetchError extends RevocationError {
  constructor(message: string) {
    super(message);
    this.name = 'RevocationFetchError';
  }
}
