import { AppError, AppErrorCode } from '../../errors/app-error';
import { SignatureLevel, type TSignatureLevel } from '../../types/signature-level';

type ResolveSignatureLevelOptions = {
  /**
   * The signature level the caller wants the envelope created at. Optional;
   * when omitted the resolver returns `SES`.
   */
  requested?: TSignatureLevel;

  /**
   * When `true`, a request for anything other than `SES` throws
   * `CSC_INSTANCE_MODE_MISMATCH` rather than being silently coerced. When
   * `false` (default), the resolver coerces it to `SES` without throwing.
   *
   * Omitting `requested` is accepted in both modes.
   *
   * Use `strict: true` at call sites that take the level from external input
   * (e.g. a public API) where silent coercion would mask caller mistakes.
   */
  strict?: boolean;
};

/**
 * Resolve the signature level for a new envelope.
 *
 * Source of truth for the `Envelope.signatureLevel` write at create-time. The
 * column has no DB default by design, so every caller flows through here.
 *
 * Every envelope is `SES`. Remote signing by recipients through a trust
 * service provider, which used `AES` and `QES`, has been removed.
 *
 * | requested      | strict: false     | strict: true                       |
 * |----------------|-------------------|------------------------------------|
 * | omitted        | `SES`             | `SES`                              |
 * | `SES`          | `SES`             | `SES`                              |
 * | `AES` / `QES`  | `SES` (coerced)   | throws `CSC_INSTANCE_MODE_MISMATCH` |
 */
export const resolveSignatureLevel = ({
  requested,
  strict = false,
}: ResolveSignatureLevelOptions = {}): TSignatureLevel => {
  if (requested === undefined || requested === SignatureLevel.SES) {
    return SignatureLevel.SES;
  }

  if (strict) {
    throw new AppError(AppErrorCode.CSC_INSTANCE_MODE_MISMATCH, {
      message: `signatureLevel '${requested}' is not supported: only 'SES' is permitted.`,
    });
  }

  return SignatureLevel.SES;
};
