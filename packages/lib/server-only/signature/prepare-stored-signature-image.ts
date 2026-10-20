import sharp from 'sharp';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { SIGNATURE_IMAGE_MAX_SIDE_PX } from './assert-valid-signature-value';

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/** SVG's CSS pixel density, the density at which sharp reads an SVG at its declared size. */
const SVG_BASE_DENSITY = 72;

/**
 * What the seal draws for a stored signature image (G4 decision D2).
 *
 * Every image sharp reads (PNG, or JPEG, GIF, WebP or SVG under the PNG prefix) is drawn from sharp's PNG
 * re-encoding, within the signature size bound, so pdf-lib's `embedPng` and the other consumers never see the
 * stored string, which sharp may read when they cannot (G4 C100). An SVG is rasterised at that bound. The stored
 * row is never changed.
 *
 * @param value The stored `signatureImageAsBase64`.
 * @returns The PNG data URL to draw, or null when the image cannot be read at all and the seal must stop.
 */
export const prepareStoredSignatureImage = async (value: string): Promise<string | null> => {
  const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  // Built inside the promise, so a constructor that throws (an empty payload: "Input Buffer is empty") reads as
  // unreadable rather than escaping as a 500 or a seal retry (G4 C104b).
  const metadata = await Promise.resolve()
    .then(async () => await sharp(bytes, { limitInputPixels: false }).metadata())
    .catch(() => null);

  if (!metadata?.format || !metadata.width || !metadata.height) {
    return null;
  }

  const longestSide = Math.max(metadata.width, metadata.height);

  const density =
    metadata.format === 'svg'
      ? Math.max(1, SVG_BASE_DENSITY * Math.min(1, SIGNATURE_IMAGE_MAX_SIDE_PX / longestSide))
      : undefined;

  const png = await Promise.resolve()
    .then(
      async () =>
        await sharp(bytes, {
          density,
          pages: 1,
          failOn: 'truncated',
          limitInputPixels: metadata.format === 'svg' ? SIGNATURE_IMAGE_MAX_SIDE_PX ** 2 : undefined,
        })
          .resize(SIGNATURE_IMAGE_MAX_SIDE_PX, SIGNATURE_IMAGE_MAX_SIDE_PX, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer(),
    )
    .catch(() => null);

  return png ? `${PNG_DATA_URL_PREFIX}${png.toString('base64')}` : null;
};

/**
 * The fields with each stored signature image replaced by what `prepareStoredSignatureImage` draws for it, for the
 * PDF renderers outside the seal (certificate and partial PDF downloads, G4 C104). The input is not changed.
 *
 * @throws AppError INVALID_REQUEST (400) when a stored image cannot be read, without echoing the stored value.
 */
export const prepareFieldSignatureImages = async <
  T extends { signature?: { signatureImageAsBase64: string | null } | null },
>(
  fields: T[],
): Promise<T[]> =>
  await Promise.all(
    fields.map(async (field) => {
      const stored = field.signature?.signatureImageAsBase64;

      if (!field.signature || !stored) {
        return field;
      }

      const image = await prepareStoredSignatureImage(stored);

      if (!image) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'A stored signature image cannot be rendered',
          statusCode: 400,
        });
      }

      return { ...field, signature: { ...field.signature, signatureImageAsBase64: image } };
    }),
  );
