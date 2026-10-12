/**
 * The recipient's signing page for company seals, in the browser.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | a signed-in member sees the seal at the confirmation step,        | 13       |               |
 * |   applies it, completes, and the envelope completes               |          |               |
 * | without a session the page asks for sign-in and shows no image    | 14       | F1            |
 * | in /embed/sign without a session the seal is refused in the embed | 21       | F1            |
 * |   and the other fields still sign                                 |          |               |
 *
 * The field is painted on a canvas, so it is reached by clicking the middle
 * of its stored box, as the embedded-signing spec does.
 *
 * Expected on main (red run): every test fails creating the first seal.
 */
import { prisma } from '@documenso/prisma';
import { expect, type Page } from '@playwright/test';

import { readSealField, SEAL_UI, setupMemberSeal, test } from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 180_000 });

type Box = { positionX: unknown; positionY: unknown; width: unknown; height: unknown };

const clickFieldCentre = async (page: Page, field: Box) => {
  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
  const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

  await canvas.click({ position: { x, y } });
  await page.waitForTimeout(500);
};

const prepareSignature = async (page: Page) => {
  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');
  await page.getByRole('button', { name: 'Next' }).click();
};

test('criterion_13_a_signed_in_member_sees_the_seal_at_the_confirmation_step_applies_it_and_completes', async ({
  signIn,
  request,
}) => {
  const { world, built, person } = await setupMemberSeal(signIn, request);
  const { page } = await signIn(world.member.email);

  await page.goto(`/sign/${person.token}`);
  await prepareSignature(page);

  const signatureField = await prisma.field.findUniqueOrThrow({ where: { id: person.signatureFieldId as number } });
  const sealField = await prisma.field.findUniqueOrThrow({ where: { id: person.sealFieldId as number } });

  await clickFieldCentre(page, signatureField);
  await clickFieldCentre(page, sealField);

  const confirmation = page.getByTestId(SEAL_UI.confirmDialogTestId);

  await expect(confirmation, 'a confirmation step appears').toBeVisible();

  const image = confirmation.locator('img').first();

  await expect(image, 'the confirmation step shows the seal').toBeVisible();
  await expect
    .poll(async () => await image.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await confirmation.getByRole('button', { name: SEAL_UI.applyButton }).click();

  await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 15_000 });

  const { field } = await readSealField(person.sealFieldId as number);

  expect(field.inserted, 'the seal is applied').toBe(true);

  await page.getByRole('button', { name: 'Complete' }).first().click();
  await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } })).status, {
      timeout: 60_000,
    })
    .toBe('COMPLETED');
});

test('criterion_14_without_a_session_the_page_asks_for_sign_in_and_shows_no_image', async ({
  signIn,
  page,
  request,
}) => {
  const { person } = await setupMemberSeal(signIn, request);
  const sealField = await prisma.field.findUniqueOrThrow({ where: { id: person.sealFieldId as number } });

  // The default page has no cookies: the recipient follows the emailed link.
  await page.goto(`/sign/${person.token}`);
  await clickFieldCentre(page, sealField);

  await expect(
    page.getByText(SEAL_UI.signInPromptText).first(),
    'the page asks the recipient to sign in',
  ).toBeVisible();
  await expect(page.getByTestId(SEAL_UI.confirmDialogTestId).locator('img')).toHaveCount(0);

  const { field } = await readSealField(person.sealFieldId as number);

  expect(field.inserted, 'the field stays uninserted').toBe(false);
});

test('criterion_21_in_the_embed_without_a_session_the_seal_is_refused_and_the_other_fields_still_sign', async ({
  signIn,
  page,
  request,
}) => {
  const { person } = await setupMemberSeal(signIn, request);

  await page.goto(`/embed/sign/${person.token}`);
  await prepareSignature(page);

  const signatureField = await prisma.field.findUniqueOrThrow({ where: { id: person.signatureFieldId as number } });
  const sealField = await prisma.field.findUniqueOrThrow({ where: { id: person.sealFieldId as number } });

  await clickFieldCentre(page, sealField);

  await expect(
    page.getByText(SEAL_UI.embedLoginMessage).first(),
    'the embed shows the login-required message',
  ).toBeVisible();

  // The refusal does not break the rest of the signing.
  await clickFieldCentre(page, signatureField);

  await expect
    .poll(
      async () => (await prisma.field.findUniqueOrThrow({ where: { id: person.signatureFieldId as number } })).inserted,
      {
        timeout: 30_000,
      },
    )
    .toBe(true);

  const { field } = await readSealField(person.sealFieldId as number);

  expect(field.inserted, 'the seal field stays uninserted').toBe(false);
});
