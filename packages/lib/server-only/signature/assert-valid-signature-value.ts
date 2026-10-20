import sharp from 'sharp';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { assessSignatureInk } from '../../universal/signature/assess-signature-ink';
import { hasVisibleSignatureCharacter } from '../../universal/signature/has-visible-signature-character';
import { isSignatureImageValue } from '../../universal/signature/is-signature-image-value';

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const CONTROL_CHARACTER = /\p{Cc}/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Largest decoded signature image accepted, in bytes. */
export const SIGNATURE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Largest width and height of a signature image, in pixels. */
export const SIGNATURE_IMAGE_MAX_SIDE_PX = 4096;

/** Longest typed signature accepted, in characters. */
export const TYPED_SIGNATURE_MAX_LENGTH = 500;

export type SignatureMethodSettings = {
  typedSignatureEnabled: boolean;
  drawSignatureEnabled: boolean;
  uploadSignatureEnabled: boolean;
};

export type ValidSignatureValue = {
  signatureImageAsBase64: string | null;
  typedSignature: string | null;
};

export type AssertValidSignatureValueOptions = {
  value: string;
  /** The client's claim that the value is an image (V1 and direct templates); refused when it disagrees. */
  isBase64?: boolean;
  /** The signature methods allowed where the value is used; omitted where no policy applies (profile). */
  methods?: SignatureMethodSettings | null;
};

const refuse = (message: string) => new AppError(AppErrorCode.INVALID_REQUEST, { message, statusCode: 400 });

/**
 * Refuses a validated signature whose kind the method settings do not allow.
 * An image is allowed when drawing or uploading is; text when typing is. Settings
 * with every method off are treated as all three allowed (G4 decision D3).
 *
 * Call it again under the envelope lock with settings read there, so a policy
 * change that commits first is seen.
 */
export const assertSignatureMethodAllowed = (
  signature: ValidSignatureValue,
  methods: SignatureMethodSettings | null | undefined,
) => {
  if (!methods) {
    return;
  }

  const { typedSignatureEnabled, drawSignatureEnabled, uploadSignatureEnabled } = methods;

  if (!typedSignatureEnabled && !drawSignatureEnabled && !uploadSignatureEnabled) {
    return;
  }

  if (signature.signatureImageAsBase64 && !drawSignatureEnabled && !uploadSignatureEnabled) {
    throw refuse('Signature method not allowed: drawn and uploaded signatures are disabled for this document');
  }

  if (signature.typedSignature && !typedSignatureEnabled) {
    throw refuse('Signature method not allowed: typed signatures are disabled for this document');
  }
};

/**
 * Decodes a PNG signature image, applies the shared ink rule and returns the
 * pixels re-encoded as an 8-bit RGBA PNG data URL, so every consumer sees the
 * bytes that were validated.
 */
const normaliseSignatureImage = async (value: string) => {
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) {
    throw refuse('Signature is not an image: only data:image/png;base64, is accepted');
  }

  const payload = value.slice(PNG_DATA_URL_PREFIX.length);

  if (payload.length > (Math.ceil(SIGNATURE_IMAGE_MAX_BYTES / 3) + 1) * 4) {
    throw refuse('Signature image is too large');
  }

  // The round trip alone proves the payload canonical: the decoder skips any other character and the encoder pads.
  // A backtracking pattern over a payload near the cap overflowed the regexp stack and answered 500 (G4 C9).
  const bytes = Buffer.from(payload, 'base64');

  if (payload.length % 4 !== 0 || bytes.toString('base64') !== payload) {
    throw refuse('Signature is not an image: the payload is not canonical base64');
  }

  if (bytes.length > SIGNATURE_IMAGE_MAX_BYTES) {
    throw refuse('Signature image is too large');
  }

  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw refuse('Signature is not an image: the bytes are not a PNG');
  }

  const options = {
    limitInputPixels: SIGNATURE_IMAGE_MAX_SIDE_PX * SIGNATURE_IMAGE_MAX_SIDE_PX,
    failOn: 'truncated',
  } as const;

  const metadata = await sharp(bytes, options)
    .metadata()
    .catch(() => {
      throw refuse('Signature image could not be read, or is too large');
    });

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (metadata.format !== 'png') {
    throw refuse('Signature is not an image: the bytes are not a PNG');
  }

  if (width < 1 || height < 1 || width > SIGNATURE_IMAGE_MAX_SIDE_PX || height > SIGNATURE_IMAGE_MAX_SIDE_PX) {
    throw refuse('Signature image is too large');
  }

  const { data, info } = await sharp(bytes, options)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw refuse('Signature image could not be decoded');
    });

  if (info.channels !== 4 || data.length !== info.width * info.height * 4) {
    throw refuse('Signature image could not be decoded');
  }

  if (!assessSignatureInk(data, info.width, info.height).isValid) {
    throw refuse('Signature is blank: too little ink');
  }

  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();

  return `${PNG_DATA_URL_PREFIX}${png.toString('base64')}`;
};

/**
 * Validates a signature value on every route that stores one (G4 spec section 3).
 *
 * A value that starts with `data:` in any case, after trimming whitespace, is an
 * image claim and must be a canonical PNG data URL with enough ink; it is
 * returned re-encoded. Anything else is a typed signature: trimmed, at least one
 * visible character, no control character (Unicode Cc) anywhere, at most
 * TYPED_SIGNATURE_MAX_LENGTH characters. Refusals
 * are AppError INVALID_REQUEST (400) naming the reason.
 */
export const assertValidSignatureValue = async ({
  value,
  isBase64,
  methods,
}: AssertValidSignatureValueOptions): Promise<ValidSignatureValue> => {
  const trimmed = value.trim();
  const isImage = isSignatureImageValue(trimmed);

  if (isBase64 !== undefined && isBase64 !== isImage) {
    throw refuse(
      isBase64 ? 'Signature is not an image, but was sent as one' : 'Signature is an image, but was sent as text',
    );
  }

  let signature: ValidSignatureValue;

  if (isImage) {
    signature = { signatureImageAsBase64: await normaliseSignatureImage(trimmed), typedSignature: null };
  } else {
    if (!hasVisibleSignatureCharacter(trimmed)) {
      throw refuse('Signature is blank: it has no visible character');
    }

    // Rule 4: a control character anywhere is refused, NUL included, which Postgres cannot store (G4 C105).
    // Tested on the value as received, since trim() would strip U+0009 to U+000D at either end (G4 C105b).
    if (CONTROL_CHARACTER.test(value)) {
      throw refuse('Typed signature contains a control character');
    }

    if (Array.from(trimmed).length > TYPED_SIGNATURE_MAX_LENGTH) {
      throw refuse(`Typed signature is too long: at most ${TYPED_SIGNATURE_MAX_LENGTH} characters`);
    }

    signature = { signatureImageAsBase64: null, typedSignature: trimmed };
  }

  assertSignatureMethodAllowed(signature, methods);

  return signature;
};
