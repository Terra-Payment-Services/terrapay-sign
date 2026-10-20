/**
 * Signing when the stored policy turns every signature method off (G4 spec D3,
 * C22's dialog half and C63).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the signature pad or the signing pages. D3:
 * a stored policy with typed, draw and upload all false is treated as all three
 * allowed when signing. The envelopes and templates are seeded with all three
 * flags false through Prisma, since saving such a policy is what C25-C28 refuse.
 * The signer is not signed in, so no saved signature is involved.
 *
 * | Criterion | Test                                                                                     |
 * | --------- | ---------------------------------------------------------------------------------------- |
 * | C22       | C22 all methods off: the signing dialog opens with Draw, Type and Upload (V1, V2)        |
 * | C63       | C63 all methods off, <surface>: 200, no error boundary, three tabs, type, sign, complete |
 *
 * "No error boundary" is checked on load, after the field click and after
 * signing, since the pad is what throws today (spec D3). Completion is checked
 * as the recipient.completeDocumentWithToken response (200), the stored typed
 * signature and the SIGNED status. Surfaces: /sign V1 and V2, /embed/sign V1
 * and V2, /d V1 and V2.
 *
 * Premise in every test: the stored documentMeta flags are all false.
 *
 * Runs in the `ui` project.
 */
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

import { type G4Seeded, seedG4DirectTemplate, seedG4Envelope, uniqueStamp } from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default', timeout: 120_000 });

const PDF_PAGE_SELECTOR = 'img[data-page-number]';
const ERROR_HEADING = 'Oops! Something went wrong.';
const ALL_OFF = { typedSignatureEnabled: false, drawSignatureEnabled: false, uploadSignatureEnabled: false };
const ALL_ON = { typedSignatureEnabled: true, drawSignatureEnabled: true, uploadSignatureEnabled: true };
type Flags = typeof ALL_OFF;

/**
 * C63 runs each surface twice: with every method off (the criterion) and, as a
 * control, with every method on, which shows the same page flow (dialog, type,
 * sign, complete) works on this stack, so the all-off run is red only for D3.
 */
const POLICIES: Array<{ name: string; flags: Flags }> = [
  { name: 'all methods off', flags: ALL_OFF },
  { name: 'control, all methods on', flags: ALL_ON },
];
const TABS = ['Draw', 'Type', 'Upload'] as const;
const TYPED_NAME = 'All Off Signer';

const expectAllOffStored = async (seeded: G4Seeded) => {
  const meta = await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } });

  expect(
    [meta.typedSignatureEnabled, meta.drawSignatureEnabled, meta.uploadSignatureEnabled],
    'premise: all three signature methods are stored false',
  ).toEqual([false, false, false]);
};

const seedAllOff = async (internalVersion: 1 | 2, flags: Flags = ALL_OFF) => {
  const seeded = await seedG4Envelope({
    internalVersion,
    ...flags,
    recipients: [{ key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] }],
  });

  if (flags === ALL_OFF) {
    await expectAllOffStored(seeded);
  }

  return seeded;
};

/** GET answers 200, the document renders, and no error boundary is on the page. */
const openWithoutErrorBoundary = async (page: Page, path: string, label: string) => {
  const response = await page.goto(path);

  expect.soft(response?.status(), `${label}: GET ${path} answers 200`).toBe(200);
  await expect
    .soft(page.locator(PDF_PAGE_SELECTOR).first(), `${label}: the document renders`)
    .toBeVisible({ timeout: 30_000 });
  await expect.soft(page.getByRole('heading', { name: ERROR_HEADING }), `${label}: no error boundary`).toHaveCount(0);
};

const expectNoErrorBoundary = async (page: Page, label: string, when: string) => {
  await expect(page.getByRole('heading', { name: ERROR_HEADING }), `${label}: no error boundary ${when}`).toHaveCount(
    0,
  );
  // The V0 embed's error page is a bare "Not Found".
  await expect(page.getByText('Not Found', { exact: true }), `${label}: no embed error page ${when}`).toHaveCount(0);
};

const clickV2Field = async (page: Page, fieldId: number) => {
  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });
  const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
  const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

  await canvas.click({ position: { x, y } });
};

const clickSignatureField = async (page: Page, fieldId: number, isV2: boolean) => {
  if (isV2) {
    await clickV2Field(page, fieldId);
  } else {
    await page.locator(`#field-${fieldId}`).getByRole('button').click();
  }

  // Give a render-time throw in the pad the moment it needs to replace the page.
  await page.waitForTimeout(1_000);
};

const expectThreeTabs = async (page: Page, label: string) => {
  const dialog = page.getByRole('dialog');

  await expect(dialog, `${label}: the signature dialog opens`).toBeVisible({ timeout: 10_000 });

  for (const tab of TABS) {
    await expect.soft(dialog.getByRole('tab', { name: tab }), `${label}: the ${tab} tab is offered`).toBeVisible();
  }
};

/** In the open field dialog: Type tab, a name, Sign. */
const typeAndSign = async (page: Page) => {
  const dialog = page.getByRole('dialog');

  await dialog.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill(TYPED_NAME);
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog).toBeHidden();
};

/** Complete, then confirm if the page asks; the completion request must answer 200. */
const completeOnPage = async (page: Page, label: string) => {
  const completion = page.waitForResponse((response) => response.url().includes('completeDocumentWithToken'), {
    timeout: 30_000,
  });

  await page.getByRole('button', { name: 'Complete' }).first().click();

  const confirm = page.getByRole('heading', { name: 'Are you sure?' });

  if (await confirm.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
  } else {
    const sign = page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true });

    if (await sign.isVisible().catch(() => false)) {
      await sign.click();
    }
  }

  const response = await completion.catch(() => null);

  expect(response?.status(), `${label}: recipient.completeDocumentWithToken answers 200`).toBe(200);
};

const expectTypedStored = async (fieldId: number, label: string) => {
  await expect
    .poll(async () => (await prisma.signature.findFirst({ where: { fieldId } }))?.typedSignature ?? null, {
      message: `${label}: the stored typed signature is the typed name`,
      timeout: 10_000,
    })
    .toBe(TYPED_NAME);
};

const expectSigned = async (recipientId: number, label: string) => {
  await expect
    .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } })).signingStatus, {
      message: `${label}: the signer ends SIGNED`,
      timeout: 30_000,
    })
    .toBe(SigningStatus.SIGNED);
};

// ---------------------------------------------------------------------------
// C22, dialog half
// ---------------------------------------------------------------------------

for (const version of [1, 2] as const) {
  test(`C22 all methods off: the signing dialog opens with Draw, Type and Upload (V${version})`, async ({ page }) => {
    const seeded = await seedAllOff(version);
    const label = `C22 V${version}`;

    await openWithoutErrorBoundary(page, `/sign/${seeded.r.s1.token}`, label);
    await clickSignatureField(page, seeded.r.s1.fields.sig.id, version === 2);
    await expectNoErrorBoundary(page, label, 'after clicking the signature field');
    await expectThreeTabs(page, label);
  });
}

// ---------------------------------------------------------------------------
// C63
// ---------------------------------------------------------------------------

for (const { name: policy, flags } of POLICIES) {
  for (const version of [1, 2] as const) {
    test(`C63 ${policy}, /sign V${version}: 200, three tabs, type, sign, complete`, async ({ page }) => {
      const seeded = await seedAllOff(version, flags);
      const label = `C63 ${policy} /sign V${version}`;
      const fieldId = seeded.r.s1.fields.sig.id;

      await openWithoutErrorBoundary(page, `/sign/${seeded.r.s1.token}`, label);
      await clickSignatureField(page, fieldId, version === 2);
      await expectNoErrorBoundary(page, label, 'after clicking the signature field');
      await expectThreeTabs(page, label);
      await typeAndSign(page);
      await expectNoErrorBoundary(page, label, 'after signing');

      await expect
        .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: fieldId } })).inserted, {
          message: `${label}: the typed signature is inserted`,
          timeout: 10_000,
        })
        .toBe(true);
      await expectTypedStored(fieldId, label);

      await completeOnPage(page, label);
      await expectSigned(seeded.r.s1.id, label);
    });

    test(`C63 ${policy}, V0 embed V${version}: 200, three tabs, type, sign, complete`, async ({ page }) => {
      const seeded = await seedAllOff(version, flags);
      const label = `C63 ${policy} /embed/sign V${version}`;
      const fieldId = seeded.r.s1.fields.sig.id;

      await openWithoutErrorBoundary(page, `/embed/sign/${seeded.r.s1.token}`, label);
      await clickSignatureField(page, fieldId, version === 2);
      await expectNoErrorBoundary(page, label, 'after clicking the signature field');
      await expectThreeTabs(page, label);
      await typeAndSign(page);
      await expectNoErrorBoundary(page, label, 'after signing');

      await expect
        .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: fieldId } })).inserted, {
          message: `${label}: the typed signature is inserted`,
          timeout: 10_000,
        })
        .toBe(true);
      await expectTypedStored(fieldId, label);

      await completeOnPage(page, label);
      await expectSigned(seeded.r.s1.id, label);
    });
  }

  for (const version of [1, 2] as const) {
    test(`C63 ${policy}, direct template /d (V${version}): 200, three tabs, type, sign, complete`, async ({ page }) => {
      const template = await seedG4DirectTemplate(version, flags);
      const label = `C63 ${policy} /d V${version}`;
      const email = `g4-c63-direct-${uniqueStamp()}@test.documenso.com`;

      if (flags === ALL_OFF) {
        await expectAllOffStored(template);
      }
      await openWithoutErrorBoundary(page, `/d/${template.directToken}`, label);

      // The V1 direct-link page opens on a details step; the V2 page may not.
      const general = page.getByRole('heading', { name: 'General' });

      if (await general.isVisible().catch(() => false)) {
        await page.getByPlaceholder('name@example.com').fill(email);
        await page.getByRole('button', { name: 'Continue' }).click();
      }

      await expectNoErrorBoundary(page, label, 'after the details step');

      await clickSignatureField(page, template.sigFieldId, version === 2);
      await expectNoErrorBoundary(page, label, 'after clicking the signature field');
      await expectThreeTabs(page, label);
      await typeAndSign(page);
      await expectNoErrorBoundary(page, label, 'after signing');

      if (version === 1) {
        await expect(page.locator(`#field-${template.sigFieldId}`)).toHaveAttribute('data-inserted', 'true');
      }

      const submission = page.waitForResponse(
        (response) => response.url().includes('createDocumentFromDirectTemplate'),
        { timeout: 30_000 },
      );

      await page.getByRole('button', { name: 'Complete' }).first().click();

      // The V2 confirmation asks for the signer's name and email; the V1 page took the email on its details step.
      const dialog = page.getByRole('dialog');
      const confirm = dialog.getByRole('button', { name: 'Sign', exact: true });
      const emailBox = dialog.getByRole('textbox', { name: 'Your Email' });

      await expect(confirm, `${label}: the completion dialog opens`).toBeVisible({ timeout: 10_000 });

      if (await emailBox.isVisible().catch(() => false)) {
        const nameBox = dialog.getByRole('textbox', { name: 'Your Name' });

        if ((await nameBox.inputValue().catch(() => 'filled')) === '') {
          await nameBox.fill(TYPED_NAME);
        }

        await emailBox.fill(email);
      }

      await confirm.click();

      const response = await submission.catch(() => null);

      expect(response?.status(), `${label}: template.createDocumentFromDirectTemplate answers 200`).toBe(200);

      await expect
        .poll(
          async () =>
            (
              await prisma.recipient.findFirst({
                where: {
                  envelope: { teamId: template.owner.team.id, type: 'DOCUMENT' },
                  signingStatus: SigningStatus.SIGNED,
                  ...(version === 1 ? { email } : {}),
                },
              })
            )?.signingStatus,
          { message: `${label}: the direct-link signer ends SIGNED`, timeout: 30_000 },
        )
        .toBe(SigningStatus.SIGNED);

      const signature = await prisma.signature.findFirst({
        where: { field: { envelope: { teamId: template.owner.team.id, type: 'DOCUMENT' } } },
      });

      expect(signature?.typedSignature, `${label}: the stored typed signature is the typed name`).toBe(TYPED_NAME);
    });
  }
}
