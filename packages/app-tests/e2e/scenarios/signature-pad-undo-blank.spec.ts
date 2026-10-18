import { prisma } from '@documenso/prisma';
import { seedTeamDocumentWithMeta } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';
import { PNG } from 'pngjs';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin } from '../fixtures/authentication';

/**
 * Undoing strokes on the draw pad must never leave a blank or
 * too-small image in place as the signature.
 *
 * Primary surface is the V1 signing page's signature dialog (confirm button
 * "Next"). C7 covers the V2 per-field dialog and C8 the profile form.
 *
 * "Blank" means a decoded PNG with no non-transparent pixels.
 */

const PDF_PAGE_SELECTOR = 'img[data-page-number]';

/** Number of pixels with alpha above zero in a PNG data URL. Throws on anything that is not a PNG data URL. */
const countInkPixels = (dataUrl: string) => {
  const prefix = 'data:image/png;base64,';

  if (!dataUrl.startsWith(prefix)) {
    throw new Error('Signature is not a PNG data URL');
  }

  const png = PNG.sync.read(Buffer.from(dataUrl.slice(prefix.length), 'base64'));
  let ink = 0;

  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] > 0) {
      ink++;
    }
  }

  return ink;
};

const canvasBox = async (page: Page) => {
  const canvas = page.getByTestId('signature-pad-draw');

  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('Signature canvas has no bounding box');
  }

  return box;
};

/**
 * One stroke: a single mouse down, many moves, one mouse up, so that Undo removes
 * exactly this stroke. Three passes between the given heights, as in
 * signature-pad-cancel.spec.ts, so that the stroke alone clears the 1 percent
 * coverage threshold (SIGNATURE_MIN_COVERAGE_THRESHOLD = 0.01).
 */
const drawLargeStroke = async (page: Page, topFraction = 0.3, bottomFraction = 0.7) => {
  const box = await canvasBox(page);

  const left = box.x + box.width * 0.15;
  const right = box.x + box.width * 0.85;
  const top = box.y + box.height * topFraction;
  const bottom = box.y + box.height * bottomFraction;

  await page.mouse.move(left, top);
  await page.mouse.down();

  for (let pass = 0; pass < 3; pass++) {
    const y = top + ((bottom - top) * pass) / 3;

    for (let step = 0; step <= 20; step++) {
      const progress = step / 20;
      const x = pass % 2 === 0 ? left + (right - left) * progress : right - (right - left) * progress;

      await page.mouse.move(x, y + (step % 2 === 0 ? 0 : 12));
    }
  }

  await page.mouse.up();
};

/**
 * One short stroke, 8 percent of the canvas width. At a line width of about 3
 * percent of the shorter canvas side its ink is far below 1 percent of the
 * canvas, whatever the canvas size.
 */
const drawSmallStroke = async (page: Page) => {
  const box = await canvasBox(page);

  const left = box.x + box.width * 0.05;
  const right = box.x + box.width * 0.13;
  const y = box.y + box.height * 0.85;

  await page.mouse.move(left, y);
  await page.mouse.down();

  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(left + ((right - left) * step) / 8, y);
  }

  await page.mouse.up();
};

const undoButton = (scope: Page | Locator) => scope.getByRole('button', { name: 'Undo' });

const clickUndo = async (page: Page, times = 1) => {
  for (let i = 0; i < times; i++) {
    await undoButton(page).click();
  }
};

const confirmButton = (page: Page) => page.getByRole('button', { name: 'Next' });

const openSigningPage = async (page: Page) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email });

  const document = await seedTeamDocumentWithMeta(team);

  await page.goto(`/sign/${document.recipients[0].token}`);

  const field = await prisma.field.findFirstOrThrow({
    where: { envelopeId: document.id, type: FieldType.SIGNATURE },
  });

  return { fieldId: field.id };
};

const openPad = async (page: Page) => {
  await page.getByTestId('signature-pad-dialog-button').click();
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('tab', { name: 'Draw' }).click();
};

/** Confirm the dialog, sign the V1 field and return the stored signature row. */
const signV1Field = async (page: Page, fieldId: number) => {
  await confirmButton(page).click();
  await expect(page.locator('[role="dialog"]')).toBeHidden();

  await page.locator(`#field-${fieldId}`).getByRole('button').click();
  await expect(page.locator(`#field-${fieldId}`)).toHaveAttribute('data-inserted', 'true');

  await expect
    .poll(async () => (await prisma.signature.findUnique({ where: { fieldId } }))?.signatureImageAsBase64 ?? null)
    .not.toBeNull();

  return prisma.signature.findUniqueOrThrow({ where: { fieldId } });
};

test('C1 undo to blank: drawing one valid stroke and undoing it disables the confirm button', async ({ page }) => {
  await openSigningPage(page);
  await openPad(page);

  await drawLargeStroke(page);

  // Without this the test passes for the wrong reason when the stroke never registered.
  await expect(confirmButton(page)).toBeEnabled();

  await clickUndo(page);

  await expect(confirmButton(page)).toBeDisabled();
});

test('C2 undo below threshold: undoing down to a scrap under 1 percent disables confirm and shows the too-small message', async ({
  page,
}) => {
  await openSigningPage(page);
  await openPad(page);

  await drawSmallStroke(page);
  await drawLargeStroke(page);

  await expect(confirmButton(page)).toBeEnabled();

  await clickUndo(page);

  await expect(confirmButton(page)).toBeDisabled();
  await expect(page.getByText('Signature is too small')).toBeVisible();
});

test('C3 partial undo stays valid: two strokes, one undone, the stored signature image is not blank', async ({
  page,
}) => {
  const { fieldId } = await openSigningPage(page);
  await openPad(page);

  await drawLargeStroke(page, 0.15, 0.45);
  await drawLargeStroke(page, 0.55, 0.85);

  await clickUndo(page);

  await expect(confirmButton(page)).toBeEnabled();

  const signature = await signV1Field(page, fieldId);

  expect(signature.signatureImageAsBase64).toBeTruthy();
  expect(countInkPixels(signature.signatureImageAsBase64 ?? '')).toBeGreaterThan(0);
});

test('C4 recover after blank: drawing again after undoing to blank re-enables confirm and signs a non-blank image', async ({
  page,
}) => {
  const { fieldId } = await openSigningPage(page);
  await openPad(page);

  await drawLargeStroke(page);
  await clickUndo(page);

  await expect(confirmButton(page)).toBeDisabled();

  await drawLargeStroke(page);

  await expect(confirmButton(page)).toBeEnabled();

  const signature = await signV1Field(page, fieldId);

  expect(signature.signatureImageAsBase64).toBeTruthy();
  expect(countInkPixels(signature.signatureImageAsBase64 ?? '')).toBeGreaterThan(0);
});

test('C5 pointer leave: moving the pointer out of the canvas and back after undoing to blank keeps confirm disabled', async ({
  page,
}) => {
  await openSigningPage(page);
  await openPad(page);

  await drawLargeStroke(page);
  await clickUndo(page);

  await expect(confirmButton(page)).toBeDisabled();

  const box = await canvasBox(page);

  // Out of the canvas, over the dialog's own content, then back in. No button is pressed.
  await page.mouse.move(box.x + box.width / 2, box.y - 20);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 20);
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3);

  await expect(confirmButton(page)).toBeDisabled();
});

test('C6 tab switch: switching to Type and back to Draw after undoing to blank keeps confirm disabled', async ({
  page,
}) => {
  await openSigningPage(page);
  await openPad(page);

  await drawLargeStroke(page);
  await clickUndo(page);

  await expect(confirmButton(page)).toBeDisabled();

  await page.getByRole('tab', { name: 'Type' }).click();
  await expect(page.getByTestId('signature-pad-type-input')).toBeVisible();

  await page.getByRole('tab', { name: 'Draw' }).click();
  await expect(page.getByTestId('signature-pad-draw')).toBeVisible();

  await expect(confirmButton(page)).toBeDisabled();
});

test('C7 V2 per-field dialog: undoing to blank disables Sign and leaves the field uninserted with no signature row', async ({
  page,
  request,
}) => {
  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    recipients: [{ email: `c7-${Date.now()}@test.documenso.com`, name: 'C7 Signer' }],
    fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 10, width: 20, height: 8 }]],
  });

  const { token } = distributeResult.recipients[0];

  const sigField = envelope.fields.find((f) => f.type === FieldType.SIGNATURE);

  if (!sigField) {
    throw new Error('Signature field not found');
  }

  await page.goto(`/sign/${token}`);

  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

  const konva = page.locator('.konva-container canvas').first();

  await expect(konva).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('1 Field Remaining').first()).toBeVisible();

  const konvaBox = await konva.boundingBox();

  if (!konvaBox) {
    throw new Error('Canvas bounding box not found');
  }

  const x = (Number(sigField.positionX) / 100) * konvaBox.width + ((Number(sigField.width) / 100) * konvaBox.width) / 2;
  const y =
    (Number(sigField.positionY) / 100) * konvaBox.height + ((Number(sigField.height) / 100) * konvaBox.height) / 2;

  await konva.click({ position: { x, y } });

  const dialog = page.getByRole('dialog');

  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'Draw' }).click();

  await drawLargeStroke(page);

  const signButton = dialog.getByRole('button', { name: 'Sign', exact: true });

  await expect(signButton).toBeEnabled();

  await clickUndo(page);

  await expect(signButton).toBeDisabled();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText('1 Field Remaining').first()).toBeVisible();

  const field = await prisma.field.findUniqueOrThrow({ where: { id: sigField.id } });
  const signature = await prisma.signature.findUnique({ where: { fieldId: sigField.id } });

  expect(field.inserted).toBe(false);
  expect(signature).toBeNull();
});

test('C8 profile: undoing to blank and saving is refused and the stored signature is unchanged', async ({ page }) => {
  const { user } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: '/settings/profile' });

  const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('tab', { name: 'Draw' }).click();

  await drawLargeStroke(page);

  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Next' });

  await expect(confirm).toBeEnabled();

  await clickUndo(page);

  // Try to commit whatever the pad now offers. On a pad that rejects the blank image the
  // button is disabled, so the dialog is dismissed instead and the form is saved as it stands.
  if (await confirm.isEnabled()) {
    await confirm.click();
  } else {
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  }

  await expect(page.locator('[role="dialog"]')).toBeHidden();

  await page.getByRole('button', { name: 'Update profile' }).click();

  await expect(page.getByText('Signature Pad cannot be empty.')).toBeVisible();

  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  expect(after.signature).toBe(before.signature);
});
