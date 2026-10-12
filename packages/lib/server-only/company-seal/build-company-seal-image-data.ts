import crypto from 'node:crypto';

import sharp from 'sharp';

import {
  BRANDING_LOGO_ALLOWED_TYPES,
  BRANDING_LOGO_MAX_SIZE_BYTES,
  BRANDING_LOGO_MAX_SIZE_MB,
} from '../../constants/branding';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { putFileServerSide } from '../../universal/upload/put-file.server';

/** Decoding stops at this many input pixels, so a small file cannot expand into a huge bitmap. */
export const COMPANY_SEAL_MAX_INPUT_PIXELS = 40_000_000;

/** Images whose shorter side is below this are refused: too coarse to print. */
export const COMPANY_SEAL_MIN_SIDE_PX = 150;

/** The stored PNG fits within this square. */
export const COMPANY_SEAL_MAX_SIDE_PX = 1024;

/** The stored PNG is copied into every document that uses the seal, so it is capped. */
export const COMPANY_SEAL_MAX_STORED_BYTES = 1.5 * 1024 * 1024;

const ACCEPTED_FORMATS = ['png', 'jpeg', 'webp'];

const refuse = (message: string) => new AppError(AppErrorCode.INVALID_BODY, { message, statusCode: 400 });

/**
 * Whether the leading bytes are a PNG, JPEG or WebP signature. The declared
 * MIME type comes from the client, and sharp also accepts SVG, so the bytes
 * themselves are checked.
 */
const hasAcceptedSignature = (bytes: Buffer) => {
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isWebp =
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';

  return isPng || isJpeg || isWebp;
};

/**
 * Validate an uploaded company seal image and re-encode it to the PNG that is
 * stored. The create form previews this output, and create runs it again on the
 * previewed PNG, which it leaves unchanged.
 *
 * Refusals are INVALID_BODY with a message naming the reason, the declared size
 * and type included.
 */
export const processCompanySealImage = async (file: File) => {
  if (file.size > BRANDING_LOGO_MAX_SIZE_BYTES) {
    throw refuse(`File cannot be larger than ${BRANDING_LOGO_MAX_SIZE_MB}MB`);
  }

  if (!BRANDING_LOGO_ALLOWED_TYPES.includes(file.type)) {
    throw refuse('File must be a JPG, PNG, or WebP image');
  }

  const input = Buffer.from(await file.arrayBuffer());

  if (!hasAcceptedSignature(input)) {
    throw refuse('The seal image must be a PNG, JPEG or WebP image');
  }

  const metadata = await sharp(input, { limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw refuse('The seal image must be a valid PNG, JPEG or WebP image');
    });

  if (!metadata.format || !ACCEPTED_FORMATS.includes(metadata.format)) {
    throw refuse('The seal image must be a PNG, JPEG or WebP image');
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width * height > COMPANY_SEAL_MAX_INPUT_PIXELS) {
    throw refuse('The seal image exceeds 40 megapixels');
  }

  if (Math.min(width, height) < COMPANY_SEAL_MIN_SIDE_PX) {
    throw refuse(`The seal image's shorter side is under ${COMPANY_SEAL_MIN_SIDE_PX} px`);
  }

  const png = await sharp(input, { limitInputPixels: COMPANY_SEAL_MAX_INPUT_PIXELS, pages: 1 })
    .rotate()
    .resize(COMPANY_SEAL_MAX_SIDE_PX, COMPANY_SEAL_MAX_SIDE_PX, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
    .catch(() => {
      throw refuse('The seal image could not be processed');
    });

  if (png.length > COMPANY_SEAL_MAX_STORED_BYTES) {
    throw refuse('The seal image is too complex: the re-encoded PNG is over 1.5 MB');
  }

  return png;
};

/**
 * Validate an uploaded company seal image, re-encode it to a PNG and store it.
 *
 * Refusals are INVALID_BODY with a message naming the reason, and nothing is
 * stored. Returns the `{ type, data }` storage reference and the SHA-256 of the
 * stored PNG bytes.
 */
export const buildCompanySealImageData = async (file: File) => {
  const png = await processCompanySealImage(file);

  const imageData = await putFileServerSide({
    name: 'company-seal.png',
    type: 'image/png',
    arrayBuffer: async () => Promise.resolve(png),
  });

  return {
    imageData,
    imageSha256: crypto.createHash('sha256').update(png).digest('hex'),
  };
};
