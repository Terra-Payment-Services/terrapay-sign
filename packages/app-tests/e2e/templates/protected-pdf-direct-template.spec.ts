/**
 * Signing a V1 direct template whose PDF is owner-restricted (criterion
 * 12, the direct-template half; duplicates are in
 * e2e/api/v2/protected-pdf-copies.spec.ts).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * Signing a direct template creates a document from it. A V1 document cannot
 * keep owner restrictions, so the signing must be refused before any document,
 * recipient, audit entry or notification exists, and the signer must not be
 * told they have signed (F11).
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | ordinary V1 direct template signs to "Document Signed"         | 8, 12    | F8            |
 * |   (control: proves the signing steps below work)               |          |               |
 * | owner-restricted V1 direct template: signer is not told they   | 12       | F11           |
 * |   signed, and nothing is created                               |          |               |
 *
 * The signing steps are the ones the existing direct-templates spec drives for
 * a one-recipient V1 template. In the refused case a refusal may come at any
 * step, including the page load, so the steps are attempted and the outcome
 * judged afterwards; the control runs the same steps and must reach the end,
 * so a broken step cannot pass the refused test unnoticed.
 */
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { EnvelopeType } from '@prisma/client';

import { assertVerifierToolsPresent, buildOwnerOnlyPdf } from '../fixtures/protected-pdfs';
import { signSignaturePad } from '../fixtures/signature';

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const seedV1DirectTemplate = async (pdf?: Buffer) => {
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: 'Direct template',
    userId: user.id,
    teamId: team.id,
    internalVersion: 1,
  });

  if (pdf) {
    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });
    const base64 = pdf.toString('base64');

    await prisma.documentData.update({
      where: { id: item.documentDataId },
      data: { data: base64, initialData: base64 },
    });
  }

  return { template, team };
};

const signDirectTemplate = async (
  page: Page,
  template: Awaited<ReturnType<typeof seedV1DirectTemplate>>['template'],
  email: string,
) => {
  const field = template.fields[0];

  await page.goto(formatDirectTemplatePath(template.directLink?.token || ''));
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();

  await page.waitForTimeout(100);
  await page.getByPlaceholder('name@example.com').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();

  await signSignaturePad(page);
  await page.locator(`#field-${field.id}`).getByRole('button').click();
  await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();
};

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com`;

test('criterion_12_control_ordinary_v1_direct_template_signs_to_document_signed', async ({ page }) => {
  const { template, team } = await seedV1DirectTemplate();
  const email = uniqueEmail('direct-control');

  await signDirectTemplate(page, template, email);

  await page.waitForURL(/\/sign/);
  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();
  expect(await prisma.envelope.count({ where: { teamId: team.id, type: EnvelopeType.DOCUMENT } })).toBe(1);
});

test('criterion_12_owner_restricted_v1_direct_template_is_refused_and_the_signer_is_not_told_they_signed', async ({
  page,
}) => {
  const { template, team } = await seedV1DirectTemplate(await buildOwnerOnlyPdf('AES-256'));
  const email = uniqueEmail('direct-protected');

  const stoppedAt = await signDirectTemplate(page, template, email).then(
    () => 'every step ran',
    (error: Error) => error.message.split('\n')[0],
  );

  test.info().annotations.push({ type: 'signing attempt', description: stoppedAt });

  // Give a completion redirect, if one is coming, time to land.
  await page.waitForTimeout(3_000);

  await expect(
    page.getByRole('heading', { name: 'Document Signed' }),
    'the signer is not told they signed',
  ).toHaveCount(0);
  expect(page.url(), 'the signer is not sent to a completed-signing page').not.toMatch(/\/sign\/[^/]+\/complete/);

  expect(
    await prisma.envelope.count({ where: { teamId: team.id, type: EnvelopeType.DOCUMENT } }),
    'no document was created',
  ).toBe(0);
  expect(await prisma.recipient.count({ where: { email } }), 'no recipient exists to be notified').toBe(0);
  expect(await prisma.documentAuditLog.count({ where: { email } }), 'no audit entry names the signer').toBe(0);
});
