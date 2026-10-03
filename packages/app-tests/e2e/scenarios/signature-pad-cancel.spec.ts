import { seedTeamDocumentWithMeta } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * Upstream #3203.
 *
 * A signer draws, thinks better of it and presses Cancel. The dialog closes and
 * the field stays empty, which is what they asked for. The drawing survived in
 * the dialog's state though, while the canvas it was drawn on was destroyed
 * with the dialog. Reopening showed a blank pad above a confirm button that was
 * already live, and pressing it put the abandoned drawing on the envelope.
 *
 * Nothing on screen gave the signer a way to notice. That is a signature on a
 * binding document that the person declined to make, so the spec covers all
 * three ways out of the dialog.
 */

/** Draw a stroke wide enough to clear the pad's minimum-coverage check. */
const drawOnPad = async (page: Page) => {
  const canvas = page.getByTestId('signature-pad-draw');

  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('Signature canvas has no bounding box');
  }

  const left = box.x + box.width * 0.15;
  const right = box.x + box.width * 0.85;
  const top = box.y + box.height * 0.3;
  const bottom = box.y + box.height * 0.7;

  await page.mouse.move(left, top);
  await page.mouse.down();

  // Several passes, because the pad tapers the ends of a stroke and one thin
  // line can fall under the coverage threshold on a wide canvas.
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

const openSigningPage = async (page: Page) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email });

  const document = await seedTeamDocumentWithMeta(team);

  await page.goto(`/sign/${document.recipients[0].token}`);
};

const openPad = async (page: Page) => {
  await page.getByTestId('signature-pad-dialog-button').click();
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('tab', { name: 'Draw' }).click();
};

const confirmButton = (page: Page) => page.getByRole('button', { name: 'Next' });

for (const [name, dismiss] of [
  ['the Cancel button', async (page: Page) => page.getByRole('button', { name: 'Cancel' }).click()],
  ['the escape key', async (page: Page) => page.keyboard.press('Escape')],
  ['a click outside the dialog', async (page: Page) => page.mouse.click(10, 10)],
] as const) {
  test(`[SIGNING]: a drawing discarded with ${name} is not offered for signing afterwards`, async ({ page }) => {
    await openSigningPage(page);

    await openPad(page);
    await drawOnPad(page);

    // Without this the rest of the spec passes for the wrong reason: a stroke
    // that never registered leaves nothing to leak.
    await expect(confirmButton(page)).toBeEnabled();

    await dismiss(page);
    await expect(page.locator('[role="dialog"]')).toBeHidden();

    await openPad(page);

    // The pad is blank, so the confirm button must be too. Enabled here means
    // the discarded drawing is one click from the envelope.
    await expect(confirmButton(page)).toBeDisabled();
  });
}

test('[SIGNING]: a signature already on the field survives a cancelled edit', async ({ page }) => {
  await openSigningPage(page);

  await openPad(page);
  await drawOnPad(page);
  await confirmButton(page).click();

  await expect(page.locator('[role="dialog"]')).toBeHidden();

  // Reopen, draw something else, and back out. Cancelling an edit means the
  // signature already given stands.
  await openPad(page);
  await expect(confirmButton(page)).toBeEnabled();

  await drawOnPad(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await openPad(page);
  await expect(confirmButton(page)).toBeEnabled();
});
