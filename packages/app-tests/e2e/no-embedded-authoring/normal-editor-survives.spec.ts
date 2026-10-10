/**
 * The normal, signed-in editor keeps working after embedded authoring is removed
 * (criterion 7, failure mode F4).
 *
 * Written from the specification alone, without reading the implementation.
 *
 * A logged-in sender creates a document by uploading a PDF, edits it, adds a second file to it
 * and downloads it. Each step is checked on screen and in the database, so a save that the
 * editor shows but the server drops is caught.
 */
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';
import {
  addEnvelopeItemPdf,
  getEnvelopeEditorSettingsTrigger,
  getRecipientEmailInputs,
  openDocumentEnvelopeEditor,
  setRecipientEmail,
  setRecipientName,
} from '../fixtures/envelope-editor';
import { expectToastTextToBeVisible } from '../fixtures/generic';

const EXAMPLE_PDF = path.join(__dirname, '../../../../assets/example.pdf');

test.describe.configure({ mode: 'parallel' });

test('[EDITOR]: a sender creates a document by uploading a PDF from the documents page', async ({ page }) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Upload Document' }).click(),
  ]);

  await fileChooser.setFiles(EXAMPLE_PDF);

  await expect(page).toHaveURL(/\/documents\/envelope_[a-z]+\/edit/, { timeout: 30_000 });

  const envelopeId = new URL(page.url()).pathname.split('/').find((part) => part.startsWith('envelope_'));

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { envelopeItems: true },
  });

  expect(envelope.teamId).toBe(team.id);
  expect(envelope.status).toBe('DRAFT');
  expect(envelope.envelopeItems).toHaveLength(1);
});

test('[EDITOR]: a sender edits a draft and the edits survive a reload', async ({ page }) => {
  const surface = await openDocumentEnvelopeEditor(page);

  const externalId = `e2e-editor-${nanoid()}`;
  const recipientEmail = `editor-${nanoid().toLowerCase()}@example.com`;

  await getEnvelopeEditorSettingsTrigger(page).click();
  await expect(page.getByRole('heading', { name: 'Document Settings' })).toBeVisible();
  await page.locator('input[name="externalId"]').fill(externalId);
  await page.getByRole('button', { name: 'Update' }).click();
  await expectToastTextToBeVisible(page, 'Envelope updated');

  await setRecipientEmail(page, 0, recipientEmail);
  await setRecipientName(page, 0, 'Editor Recipient');

  await expect
    .poll(
      async () => await prisma.recipient.count({ where: { envelopeId: surface.envelopeId, email: recipientEmail } }),
      { timeout: 30_000 },
    )
    .toBe(1);

  const saved = await prisma.envelope.findUniqueOrThrow({ where: { id: surface.envelopeId } });

  expect(saved.externalId).toBe(externalId);

  await page.reload();

  await expect(getRecipientEmailInputs(page).nth(0)).toHaveValue(recipientEmail);
});

test('[EDITOR]: a sender uploads a second file to a draft', async ({ page }) => {
  const surface = await openDocumentEnvelopeEditor(page);

  await addEnvelopeItemPdf(page, 'second-file.pdf');

  await expect
    .poll(async () => await prisma.envelopeItem.count({ where: { envelopeId: surface.envelopeId } }), {
      timeout: 30_000,
    })
    .toBe(2);

  const items = await prisma.envelopeItem.findMany({ where: { envelopeId: surface.envelopeId } });

  expect(items.map((item) => item.title)).toContain('second-file.pdf');
});

test('[EDITOR]: a sender downloads the PDF of a draft', async ({ page }) => {
  await openDocumentEnvelopeEditor(page);

  await page.locator('button[title="Download PDF"]').click();
  await expect(page.getByRole('heading', { name: 'Download Files' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');

  await page.getByRole('button', { name: 'Original' }).first().click();

  const download = await downloadPromise;
  const bytes = fs.readFileSync(await download.path());

  expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
});
