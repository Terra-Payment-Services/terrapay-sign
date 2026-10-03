import * as asn1js from 'asn1js';

import { toArrayBuffer } from '../revocation/x509';
import { TimestampVerificationError, verifyTimestampToken } from './verify';

/**
 * A timestamp authority that checks the answer it gets.
 *
 * This replaces `@libpdf/core`'s `HttpTimestampAuthority`, which accepts a
 * token on the HTTP status and the ASN.1 shape alone. See verify.ts for why
 * that is not enough.
 *
 * The request is built here rather than wrapping the library's authority for
 * one reason: the nonce. libpdf generates a nonce internally and never exposes
 * it, so a wrapper has nothing to compare the echoed nonce against and the one
 * defence against a replayed token is unavailable. Building the request means
 * holding the nonce, which is most of the point.
 */

const DIGEST_OIDS: Record<string, string> = {
  'SHA-256': '2.16.840.1.101.3.4.2.1',
  'SHA-384': '2.16.840.1.101.3.4.2.2',
  'SHA-512': '2.16.840.1.101.3.4.2.3',
};

/** PKIStatus values that carry a usable token. */
const GRANTED = new Set([0, 1]);

export type VerifyingTimestampAuthorityOptions = {
  /** How long to wait for the authority. */
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so a recorded fixture verifies against its own date. */
  now?: () => Date;
};

export class VerifyingTimestampAuthority {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(url: string, options: VerifyingTimestampAuthorityOptions = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Ask for a timestamp over `digest` and return the token only if it verifies.
   *
   * @throws {TimestampVerificationError} when the authority refuses, is
   *   unreachable, or returns something that is not a token for this request.
   *   Failing here fails the signing, which is correct: a signature that claims
   *   long term validity on an unverified timestamp claims evidence it has not
   *   got.
   */
  async timestamp(digest: Uint8Array, algorithm: string): Promise<Uint8Array> {
    const oid = DIGEST_OIDS[algorithm];

    if (!oid) {
      throw new TimestampVerificationError(`Cannot request a timestamp over unsupported digest ${algorithm}`);
    }

    const nonce = new Uint8Array(16);

    crypto.getRandomValues(nonce);

    // The top bit is cleared so the DER INTEGER stays positive and the
    // comparison on the way back does not have to reason about sign.
    nonce[0] &= 0x7f;

    const request = buildRequest({ digest, oid, nonce });

    let response: Response;

    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' },
        body: new Uint8Array(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TimestampVerificationError(
        `Timestamp authority ${this.url} could not be reached: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }

    if (!response.ok) {
      throw new TimestampVerificationError(`Timestamp authority ${this.url} answered ${response.status}`);
    }

    const token = extractToken(new Uint8Array(await response.arrayBuffer()), this.url);

    await verifyTimestampToken({
      token,
      digest,
      digestAlgorithm: algorithm,
      nonce,
      now: this.now(),
    });

    return token;
  }
}

/** TimeStampReq ::= SEQUENCE { version, messageImprint, [reqPolicy], [nonce], [certReq], ... } */
const buildRequest = ({ digest, oid, nonce }: { digest: Uint8Array; oid: string; nonce: Uint8Array }): Uint8Array =>
  new Uint8Array(
    new asn1js.Sequence({
      value: [
        new asn1js.Integer({ value: 1 }),
        new asn1js.Sequence({
          value: [
            new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: oid })] }),
            new asn1js.OctetString({ valueHex: toArrayBuffer(digest) }),
          ],
        }),
        new asn1js.Integer({ valueHex: toArrayBuffer(nonce) }),
        // certReq. Without it the authority may omit its certificate, and then
        // there is nothing to check the signature against.
        new asn1js.Boolean({ value: true }),
      ],
    }).toBER(false),
  );

/** Pull the TimeStampToken out of a TimeStampResp, refusing a rejection. */
const extractToken = (bytes: Uint8Array, url: string): Uint8Array => {
  const parsed = asn1js.fromBER(toArrayBuffer(bytes));

  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new TimestampVerificationError(`Timestamp authority ${url} returned something that is not a TimeStampResp`);
  }

  const [statusInfo, tokenField] = parsed.result.valueBlock.value;

  if (!(statusInfo instanceof asn1js.Sequence)) {
    throw new TimestampVerificationError(`Timestamp authority ${url} returned no PKIStatusInfo`);
  }

  const status = statusInfo.valueBlock.value[0];

  if (!(status instanceof asn1js.Integer)) {
    throw new TimestampVerificationError(`Timestamp authority ${url} returned an unreadable PKIStatus`);
  }

  if (!GRANTED.has(status.valueBlock.valueDec)) {
    throw new TimestampVerificationError(
      `Timestamp authority ${url} refused the request with status ${status.valueBlock.valueDec}`,
    );
  }

  if (!tokenField) {
    throw new TimestampVerificationError(`Timestamp authority ${url} granted the request but returned no token`);
  }

  return new Uint8Array(tokenField.toBER(false));
};
