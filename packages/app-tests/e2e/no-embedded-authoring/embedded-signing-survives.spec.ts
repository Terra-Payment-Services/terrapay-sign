/**
 * Embedded signing and recipient-token PDF access survive the removal of embedded authoring
 *.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * Criteria and failure modes covered here:
 *
 *   Criterion 1 (F1): a recipient opens /embed/sign/<token> for a V1 and for a V2 envelope, sees
 *     the document, signs and completes; the same holds for an embedded direct template and for
 *     a recipient whose access requires an emailed 2FA code.
 *   Criterion 2 (F1): a recipient can view and download the PDF through their recipient token.
 *
 * Completion is asserted on the recipient's signing status in the database as well as on screen,
 * because the embed shell's completion markup is not part of the specification.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { generateTwoFactorTokenFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-token-from-email';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

import { signSignaturePad } from '../fixtures/signature';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const PDF_PAGE_SELECTOR = 'img[data-page-number]';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

type TFieldBox = { id: number; positionX: unknown; positionY: unknown; width: unknown; height: unknown };

const expectDocumentVisible = async (page: Page) => {
  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
};

/** V1 renders each field as a DOM element; set a signature, then insert every field. */
const signV1Fields = async (page: Page, fields: TFieldBox[]) => {
  await signSignaturePad(page);

  for (const field of fields) {
    await page.locator(`#field-${field.id}`).getByRole('button').click();
    await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
  }
};

/** V2 paints fields on a Konva canvas; aim at the middle of each field's stored box. */
const signV2Fields = async (page: Page, fields: TFieldBox[]) => {
  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');
  await page.getByRole('button', { name: 'Next' }).click();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  for (const field of fields) {
    const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
    const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

    await canvas.click({ position: { x, y } });
    await page.waitForTimeout(500);
  }

  await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });
};

/** V1 embeds complete on the first click; V2 asks for confirmation first. */
const completeSigning = async (page: Page, { confirm }: { confirm: boolean }) => {
  await page.getByRole('button', { name: 'Complete' }).first().click();

  if (confirm) {
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
  }
};

const expectRecipientSigned = async (recipientId: number) => {
  await expect
    .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } })).signingStatus, {
      timeout: 30_000,
    })
    .toBe(SigningStatus.SIGNED);
};

const expectEnvelopeCompleted = async (envelopeId: string) => {
  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status, {
      timeout: 60_000,
    })
    .toBe('COMPLETED');
};

/** A direct link creates a new document in the template's team, signed by whoever used it. */
const expectDirectSignerSigned = async (teamId: number, email: string) => {
  await expect
    .poll(
      async () =>
        (
          await prisma.recipient.findFirst({
            where: { email, envelope: { teamId, type: 'DOCUMENT' } },
          })
        )?.signingStatus,
      { timeout: 30_000 },
    )
    .toBe(SigningStatus.SIGNED);
};

const seedPendingSigner = async (internalVersion: 1 | 2) => {
  const { user, team } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [seedTestEmail()],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion },
  });

  return { document, recipient: recipients[0] };
};

test.describe('Embedded signing', () => {
  test('a recipient signs and completes a V1 document through the embedded signing page', async ({ page }) => {
    const { document, recipient } = await seedPendingSigner(1);

    await page.goto(`/embed/sign/${recipient.token}`);
    await expectDocumentVisible(page);

    await signV1Fields(page, recipient.fields);
    await completeSigning(page, { confirm: false });

    await expect(page.getByRole('heading', { name: 'Document Completed!' })).toBeVisible({ timeout: 30_000 });
    await expectRecipientSigned(recipient.id);
    await expectEnvelopeCompleted(document.id);
  });

  test('a recipient signs and completes a V2 envelope through the embedded signing page', async ({ page }) => {
    const { document, recipient } = await seedPendingSigner(2);

    await page.goto(`/embed/sign/${recipient.token}`);
    await expectDocumentVisible(page);

    await signV2Fields(page, recipient.fields);
    await completeSigning(page, { confirm: true });

    await expectRecipientSigned(recipient.id);
    await expectEnvelopeCompleted(document.id);
  });

  test('a visitor signs and completes a V1 direct template through the embedded direct link', async ({ page }) => {
    const { user, team } = await seedUser();

    const template = await seedDirectTemplate({ title: 'Embedded direct V1', userId: user.id, teamId: team.id });

    const signerEmail = seedTestEmail();

    await page.goto(`/embed/direct/${template.directLink?.token}`);
    await expectDocumentVisible(page);

    await page.getByRole('textbox', { name: 'Full Name' }).fill('Direct Signer');
    await page.getByRole('textbox', { name: 'Email' }).fill(signerEmail);

    await signV1Fields(page, template.fields);
    await completeSigning(page, { confirm: false });

    await expect(page.getByRole('heading', { name: 'Document Completed!' })).toBeVisible({ timeout: 30_000 });
    await expectDirectSignerSigned(team.id, signerEmail);
  });

  test('a visitor signs and completes a V2 direct template through the embedded direct link', async ({ page }) => {
    const { user, team } = await seedUser();

    const template = await seedDirectTemplate({
      title: 'Embedded direct V2',
      userId: user.id,
      teamId: team.id,
      internalVersion: 2,
    });

    const signerEmail = seedTestEmail();

    await page.goto(`/embed/direct/${template.directLink?.token}`);
    await expectDocumentVisible(page);

    await page.getByRole('textbox', { name: 'Full Name' }).fill('Direct Signer');

    await signV2Fields(page, template.fields);

    // A V2 direct link asks for the visitor's email in the confirmation dialog.
    await page.getByRole('button', { name: 'Complete' }).first().click();
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Your Email' }).fill(signerEmail);
    await page.getByRole('button', { name: 'Sign', exact: true }).click();

    await expectDirectSignerSigned(team.id, signerEmail);
  });

  test('a recipient whose access needs an emailed code verifies, then signs and completes in the embed', async ({
    page,
  }) => {
    const { user, team } = await seedUser();

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: [seedTestEmail()],
      fields: [FieldType.SIGNATURE],
      updateDocumentOptions: {
        authOptions: createDocumentAuthOptions({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] }),
      },
    });

    const [recipient] = recipients;

    await page.goto(`/embed/sign/${recipient.token}`);

    await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
    await expect(page.locator(PDF_PAGE_SELECTOR)).toHaveCount(0);

    await page.getByRole('button', { name: /Email verification/ }).click();

    const code = await generateTwoFactorTokenFromEmail({ email: recipient.email, envelopeId: document.id });

    await page.getByRole('textbox', { name: '2FA code' }).fill(code);
    await page.getByRole('button', { name: 'Verify & Complete' }).click();

    await expectDocumentVisible(page);

    await signV1Fields(page, recipient.fields);
    await completeSigning(page, { confirm: false });

    await expect(page.getByRole('heading', { name: 'Document Completed!' })).toBeVisible({ timeout: 30_000 });
    await expectRecipientSigned(recipient.id);
  });
});

test.describe('Recipient-token PDF access', () => {
  test('a recipient views and downloads the PDF through their token, and a wrong token gets nothing', async ({
    page,
  }) => {
    const { document, recipient } = await seedPendingSigner(2);

    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });

    const tokenBase = `${WEBAPP_BASE_URL}/api/files/token/${recipient.token}`;

    const pdfUrls = [
      `${tokenBase}/envelopeItem/${item.id}`,
      `${tokenBase}/envelopeItem/${item.id}/download/original`,
      `${tokenBase}/envelope/${document.id}/envelopeItem/${item.id}/dataId/${item.documentDataId}/initial/item.pdf`,
    ];

    for (const url of pdfUrls) {
      const response = await page.request.get(url);

      expect(response.status(), url).toBe(200);
      expect((await response.body()).subarray(0, 4).toString('latin1'), url).toBe('%PDF');

      const wrong = await page.request.get(url.replace(recipient.token, `${recipient.token}x`));

      expect(wrong.status(), url).not.toBe(200);
    }

    // What the recipient sees: the embedded signing page renders the document and offers the
    // download, which hands over a PDF.
    await page.goto(`/embed/sign/${recipient.token}`);
    await expectDocumentVisible(page);

    await page.getByRole('button', { name: 'Download PDF' }).click();

    const downloadPromise = page.waitForEvent('download');

    await page.getByRole('button', { name: 'Original' }).first().click();

    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});
