/**
 * The preview before saving is the stored image.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | the preview of an EXIF-rotated, oversize JPEG has the stored      | 1        |               |
 * |   image's pixel dimensions                                         |          |               |
 *
 * Spec, "Image validation and storage": "A seal cannot be corrected after
 * creation, so the create form shows the processed image for confirmation
 * before it is saved." Criterion 1: "after seeing the processed image." The
 * processing (EXIF orientation applied, fit within 1024 by 1024, PNG) changes
 * both the dimensions and the bytes of this upload, so a preview of the raw
 * file cannot match what is stored. The specification does not say whether the
 * match is by dimensions or by bytes; dimensions are the weaker test, so they
 * are the one asserted, and a byte-exact preview passes it too.
 */
import { expect } from '@playwright/test';
import sharp from 'sharp';

import {
  SEAL_ROUTES,
  SEAL_UI,
  sealRows,
  seedSealWorld,
  storedSealImage,
  test,
  uniqueSealNames,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

/** 2400 by 1200 as stored, orientation 6 (rotate 90 degrees): displayed 1200 by 2400. Processing gives 512 by 1024. */
const exifRotatedJpeg = async () =>
  await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

test('criterion_01_the_preview_before_saving_has_the_dimensions_of_the_stored_image', async ({ signIn }) => {
  const world = await seedSealWorld();
  const { page } = await signIn(world.manager.email);
  const { name, legalEntityName } = uniqueSealNames();
  const raw = await exifRotatedJpeg();

  const rawMeta = await sharp(raw).metadata();

  expect(rawMeta.orientation, 'precondition: the upload carries EXIF orientation 6').toBe(6);
  expect(rawMeta.width, 'precondition: the upload is wider than 1024 px').toBe(2400);

  await page.goto(SEAL_ROUTES.settingsPage(world.organisation.url));

  const openButton = page.getByRole('button', { name: SEAL_UI.createButton });

  if ((await openButton.count()) > 0) {
    await openButton.first().click();
  }

  await page.getByLabel(SEAL_UI.settingsNameLabel, { exact: true }).fill(name);
  await page.getByLabel(SEAL_UI.settingsLegalEntityLabel, { exact: true }).fill(legalEntityName);
  await page.locator('input[type="file"]').setInputFiles({ name: 'seal.jpg', mimeType: 'image/jpeg', buffer: raw });

  const preview = page.getByTestId(SEAL_UI.previewTestId);

  await expect(preview, 'the preview is shown before saving').toBeVisible();

  const naturalSize = async () =>
    await preview.evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, height: img.naturalHeight }));

  await expect.poll(async () => (await naturalSize()).width, { message: 'the preview image loads' }).toBeGreaterThan(0);

  const shown = await naturalSize();

  await page.getByRole('button', { name: SEAL_UI.settingsSaveButton }).click();
  await expect(page.getByTestId(SEAL_UI.rowTestId).filter({ hasText: name })).toBeVisible();

  const [row] = await sealRows(world.organisation.id);
  const stored = await sharp(await storedSealImage(row)).metadata();

  // The test discriminates: the raw file as a browser displays it is 1200 by 2400, the stored image is not.
  expect(stored.width, 'precondition: processing changed the width').not.toBe(1200);
  expect(Math.max(stored.width ?? 0, stored.height ?? 0), 'precondition: stored within 1024 px').toBeLessThanOrEqual(
    1024,
  );

  expect(
    shown,
    `the preview is ${shown.width}x${shown.height}; the stored image is ${stored.width}x${stored.height}`,
  ).toEqual({ width: stored.width, height: stored.height });
});
