/**
 * A tall, narrow seal image saves through the settings page.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * Spec, "Image validation and storage": step 3 refuses an image whose
 * shorter side is under 150 px, and step 4 resizes to fit within 1024 by 1024.
 * The 150 px minimum therefore applies to the input. A valid 150 x 10000 PNG
 * (shorter side exactly 150, 1.5 megapixels, far under the 40 megapixel
 * limit) must save, appear in the list and be stored as a PNG no larger than
 * 1024 px on either side.
 *
 * The test drives the real settings page, because the defect to catch is in
 * what the page submits (for example a client-side resize that shrinks the
 * shorter side below 150 before upload), not in the route.
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | 150 x 10000 PNG saves through the page, listed, stored <= 1024 | 5        |               |
 */
import { expect } from '@playwright/test';
import sharp from 'sharp';

import {
  BLUE,
  PNG_SIGNATURE,
  SEAL_ROUTES,
  SEAL_UI,
  sealRows,
  seedSealWorld,
  storedSealImage,
  test,
  uniqueSealNames,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test('criterion_05_a_150_by_10000_png_saves_through_the_settings_page_and_is_stored_within_1024_px', async ({
  signIn,
}) => {
  const world = await seedSealWorld();
  const { page } = await signIn(world.manager.email);
  const { name, legalEntityName } = uniqueSealNames();

  const buffer = await sharp({ create: { width: 150, height: 10000, channels: 3, background: BLUE } })
    .png()
    .toBuffer();

  await page.goto(SEAL_ROUTES.settingsPage(world.organisation.url));

  const openButton = page.getByRole('button', { name: SEAL_UI.createButton });

  if ((await openButton.count()) > 0) {
    await openButton.first().click();
  }

  await page.getByLabel(SEAL_UI.settingsNameLabel, { exact: true }).fill(name);
  await page.getByLabel(SEAL_UI.settingsLegalEntityLabel, { exact: true }).fill(legalEntityName);
  await page.locator('input[type="file"]').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer });

  await expect(page.getByTestId(SEAL_UI.previewTestId), 'the processed image is shown before saving').toBeVisible();

  await page.getByRole('button', { name: SEAL_UI.settingsSaveButton }).click();

  const row = page.getByTestId(SEAL_UI.rowTestId).filter({ hasText: name });

  await expect(row, 'the seal appears in the list').toBeVisible();

  const rows = await sealRows(world.organisation.id);

  expect(rows, 'a CompanySeal row exists').toHaveLength(1);

  const bytes = await storedSealImage(rows[0]);
  const meta = await sharp(bytes).metadata();

  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'stored bytes are a PNG').toBe(true);
  expect(meta.width, 'width within 1024').toBeLessThanOrEqual(1024);
  expect(meta.height, 'height within 1024').toBeLessThanOrEqual(1024);
});
