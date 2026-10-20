/**
 * No stroke from the press that opened the dialog.
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * section 4.5) before any fix, without reading the draw pad's pointer handling.
 * The signer opens the V2 signing page with only the recipient token; the draw
 * canvas's backing store is read with getImageData (pixels with alpha > 0).
 *
 * | Criterion | Test                                                                                     |
 * | --------- | ---------------------------------------------------------------------------------------- |
 * | C46       | C46 the press that opened the V2 dialog, dragged across the pad, leaves no mark           |
 * | C47       | C47 a stroke that leaves the pad with the button held and comes back inks both segments   |
 * | C48       | C48 a press that begins on the dialog outside the pad and drags in leaves no mark         |
 * | C49       | C49 the V1 page, the profile page and touch input draw as today                            |
 *
 * Each "no mark" test ends with a control stroke drawn normally, so a canvas
 * that cannot be read or a stroke that never registers fails the test rather
 * than passing it.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';

import { createG4Owner, seedOneSigner, seedSession } from '../fixtures/signature-ink';
import {
  boxOf,
  canvasInk,
  drawStroke,
  fieldCentre,
  openV2FieldDialog,
  openV2SigningPage,
  signButton,
  signDialog,
  zigZag,
} from '../fixtures/signature-ink-pad';

test.describe.configure({ mode: 'default' });

const drawCanvas = (scope: Page | Locator) => scope.getByTestId('signature-pad-draw');

const tooSmall = (page: Page) => signDialog(page).getByText('Signature is too small');

/** The control: a normal stroke inks the pad and enables the confirm button. */
const expectControlStroke = async (page: Page, confirm: Locator) => {
  await drawStroke(page, drawCanvas(signDialog(page)));

  expect(
    (await canvasInk(drawCanvas(signDialog(page)))).total,
    'control: a normal stroke inks the pad',
  ).toBeGreaterThan(0);
  await expect(confirm, 'control: a normal stroke enables the confirm button').toBeEnabled();
};

// ---------------------------------------------------------------------------
// C46
// ---------------------------------------------------------------------------

test('C46 pressing a V2 signature field, holding the button while the dialog opens and dragging across the pad leaves no mark', async ({
  page,
}) => {
  const seeded = await seedOneSigner(2);

  await openV2SigningPage(page, seeded.r.s1.token);

  const centre = await fieldCentre(page, seeded.r.s1.fields.sig.id);

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();

  // Today the dialog opens on the press, with the button still down. Spec C49 also allows a fix that opens
  // the V2 field on pointerup instead; then nothing is open yet, and the release opens it with an empty pad.
  const openedOnPress = await signDialog(page)
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);

  if (!openedOnPress) {
    await page.mouse.up();
    await expect(signDialog(page), 'premise: the dialog opens on release (open-on-pointerup fix)').toBeVisible();

    const canvasAfterRelease = drawCanvas(signDialog(page));

    expect((await canvasInk(canvasAfterRelease)).total, 'the press and release left no pixel on the pad').toBe(0);
    await expect(signButton(page), 'Sign is disabled with an empty pad').toBeDisabled();
    await expectControlStroke(page, signButton(page));

    return;
  }

  const canvas = drawCanvas(signDialog(page));
  const box = await boxOf(canvas);

  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5, { steps: 8 });
  await zigZag(page, box, 0.1, 0.9);
  await page.mouse.up();

  const ink = await canvasInk(canvas);

  expect(ink.width, 'premise: the draw canvas has a backing store').toBeGreaterThan(0);
  expect.soft(ink.total, 'the drag from the opening press left no pixel on the pad').toBe(0);

  // "Stays": sample for a second so a debounced message or a late coverage check is seen.
  for (let sample = 0; sample < 5; sample++) {
    await page.waitForTimeout(200);
    expect
      .soft(await tooSmall(page).isVisible(), `"Signature is too small" is not shown (sample ${sample})`)
      .toBe(false);
    expect.soft(await signButton(page).isDisabled(), `Sign stays disabled (sample ${sample})`).toBe(true);
  }

  await canvas.page().getByRole('button', { name: 'Clear Signature' }).click();
  await expectControlStroke(page, signButton(page));
});

// ---------------------------------------------------------------------------
// C47
// ---------------------------------------------------------------------------

test('C47 a stroke that starts inside the pad, leaves with the button held and comes back inks both inside segments', async ({
  page,
}) => {
  const seeded = await seedOneSigner(2);

  await openV2SigningPage(page, seeded.r.s1.token);
  await openV2FieldDialog(page, seeded.r.s1.fields.sig.id);

  const canvas = drawCanvas(signDialog(page));
  const box = await boxOf(canvas);

  expect((await canvasInk(canvas)).total, 'premise: the pad starts empty').toBe(0);

  await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.25);
  await page.mouse.down();
  await zigZag(page, box, 0.08, 0.42);
  // Out over the top edge with the button held, across, and back in.
  await page.mouse.move(box.x + box.width * 0.42, box.y - 25, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.58, box.y - 25, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.25, { steps: 4 });
  await zigZag(page, box, 0.58, 0.92);
  await page.mouse.up();

  const ink = await canvasInk(canvas, [
    [0.05, 0.45],
    [0.55, 0.95],
  ]);

  expect.soft(ink.inRanges[0], 'ink on the segment before the stroke left the pad').toBeGreaterThan(0);
  expect.soft(ink.inRanges[1], 'ink on the segment after it came back').toBeGreaterThan(0);
  await expect.soft(signButton(page), 'Sign is enabled once coverage passes').toBeEnabled();
});

// ---------------------------------------------------------------------------
// C48
// ---------------------------------------------------------------------------

test('C48 a press that begins on the dialog outside the pad and drags in leaves no mark', async ({ page }) => {
  const seeded = await seedOneSigner(2);

  await openV2SigningPage(page, seeded.r.s1.token);
  await openV2FieldDialog(page, seeded.r.s1.fields.sig.id);

  const canvas = drawCanvas(signDialog(page));
  const box = await boxOf(canvas);
  const title = await boxOf(signDialog(page).getByText('Sign Signature Field'));

  expect(title.y + title.height, 'premise: the title is above the pad, on the dialog').toBeLessThan(box.y);

  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5, { steps: 8 });
  await zigZag(page, box, 0.1, 0.9);
  await page.mouse.up();

  await expect(signDialog(page), 'premise: the dialog is still open').toBeVisible();
  expect.soft((await canvasInk(canvas)).total, 'the drag that began outside the pad left no pixel').toBe(0);
  await expect.soft(signButton(page), 'Sign stays disabled').toBeDisabled();

  await page.getByRole('button', { name: 'Clear Signature' }).click();
  await expectControlStroke(page, signButton(page));
});

// ---------------------------------------------------------------------------
// C49
// ---------------------------------------------------------------------------

test('C49 a normal stroke draws and enables Next on the V1 signing page', async ({ page }) => {
  const seeded = await seedOneSigner(1);

  await page.goto(`/sign/${seeded.r.s1.token}`);
  await page.getByTestId('signature-pad-dialog-button').click();
  await expect(signDialog(page)).toBeVisible();
  await signDialog(page).getByRole('tab', { name: 'Draw' }).click();

  const next = signDialog(page).getByRole('button', { name: 'Next' });

  expect((await canvasInk(drawCanvas(signDialog(page)))).total, 'premise: the pad starts empty').toBe(0);
  await expectControlStroke(page, next);
});

test('C49 a normal stroke draws and enables Next on the profile page', async ({ page }) => {
  const owner = await createG4Owner();

  await seedSession(page.context(), owner.user.id);
  await page.goto('/settings/profile');
  await page.getByTestId('signature-pad-dialog-button').click();
  await expect(signDialog(page)).toBeVisible();
  await signDialog(page).getByRole('tab', { name: 'Draw' }).click();

  const next = signDialog(page).getByRole('button', { name: 'Next' });

  expect((await canvasInk(drawCanvas(signDialog(page)))).total, 'premise: the pad starts empty').toBe(0);
  await expectControlStroke(page, next);
});

test('C49 a touch stroke draws and enables Sign on the V2 page in a mobile viewport', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  try {
    const seeded = await seedOneSigner(2);

    await openV2SigningPage(page, seeded.r.s1.token);

    const centre = await fieldCentre(page, seeded.r.s1.fields.sig.id);

    await page.touchscreen.tap(centre.x, centre.y);
    await expect(signDialog(page), 'premise: a tap on the field opens the dialog').toBeVisible();

    const canvas = drawCanvas(signDialog(page));
    const box = await boxOf(canvas);

    expect((await canvasInk(canvas)).total, 'premise: the pad starts empty').toBe(0);

    const cdp = await context.newCDPSession(page);
    const point = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0.1, 0.3)] });

    for (let pass = 0; pass < 3; pass++) {
      for (let step = 0; step <= 12; step++) {
        const t = pass % 2 === 0 ? step / 12 : 1 - step / 12;

        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point(0.1 + 0.8 * t, 0.3 + 0.2 * pass + (step % 2 === 0 ? 0 : 0.05))],
        });
      }
    }

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    expect.soft((await canvasInk(canvas)).total, 'a touch stroke inks the pad').toBeGreaterThan(0);
    await expect.soft(signButton(page), 'Sign is enabled after the touch stroke').toBeEnabled();
  } finally {
    await context.close();
  }
});
