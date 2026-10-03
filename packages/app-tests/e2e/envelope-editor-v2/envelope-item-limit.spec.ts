import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';
import { getEnvelopeItemDropzoneInput, getEnvelopeItemTitleInputs } from '../fixtures/envelope-editor';

/**
 * The editor on a team page caps uploads at the organisation claim's envelope
 * item count. It used to start from a hard-coded five and rely on a separate
 * fetch to raise the cap, so this seeds a claim above five and fills it.
 */

test.use({
  storageState: {
    cookies: [],
    origins: [],
  },
});

const CLAIM_ENVELOPE_ITEM_COUNT = 7;

const examplePdfBuffer = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

test('a team page accepts more than five envelope items when the claim allows it', async ({ page }) => {
  const { user, team } = await seedUser();

  await prisma.organisationClaim.updateMany({
    where: {
      organisation: {
        id: team.organisationId,
      },
    },
    data: {
      envelopeItemCount: CLAIM_ENVELOPE_ITEM_COUNT,
    },
  });

  const document = await seedBlankDocument(user, team.id, {
    internalVersion: 2,
  });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/documents/${document.id}/edit?step=uploadAndRecipients`,
  });

  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();

  const initialCount = await prisma.envelopeItem.count({ where: { envelopeId: document.id } });

  await expect(getEnvelopeItemTitleInputs(page)).toHaveCount(initialCount);

  const files = Array.from({ length: CLAIM_ENVELOPE_ITEM_COUNT - initialCount }, (_, index) => ({
    name: `limit-item-${index + 1}.pdf`,
    mimeType: 'application/pdf',
    buffer: examplePdfBuffer,
  }));

  await getEnvelopeItemDropzoneInput(page).setInputFiles(files);

  await expect(getEnvelopeItemTitleInputs(page)).toHaveCount(CLAIM_ENVELOPE_ITEM_COUNT);

  await expect
    .poll(async () => await prisma.envelopeItem.count({ where: { envelopeId: document.id } }))
    .toBe(CLAIM_ENVELOPE_ITEM_COUNT);
});
