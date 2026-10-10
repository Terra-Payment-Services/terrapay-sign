/**
 * What a sender sees when uploading protected PDFs on the documents page.
 *
 * Written from the specification alone, before reading any implementation.
 *
 * | Test                                                            | Criteria | Failure modes |
 * | --------------------------------------------------------------- | -------- | ------------- |
 * | password pdf shows a password-protected message, distinct from   | 7        | F6            |
 * |   the message for a broken file, and nothing is created          |          |               |
 * | owner-restricted pdf uploads through the envelope uploader       | 1        | F1            |
 * | owner-restricted pdf on the legacy uploader is refused with a    | 9        | F7            |
 * |   message to use an envelope, and nothing is created             |          |               |
 *
 * "Not a generic failure" is tested by comparison: the message for the
 * password-protected file must mention a password and must differ from the
 * message the same screen shows for a file that is simply not a valid PDF.
 * No exact wording is asserted, because the specification gives none.
 *
 * Expected on main (red run): all three fail. The password test fails because
 * the screen shows the same message for both files, or one that does not
 * mention a password; the owner-restricted upload is refused (F1); the legacy
 * upload is accepted.
 */
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { EnvelopeType } from '@prisma/client';

import { apiSignin } from '../fixtures/authentication';
import { assertVerifierToolsPresent, buildOpenPasswordPdf, buildOwnerOnlyPdf } from '../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

type UploadFile = { name: string; mimeType: string; buffer: Buffer };

const signInToDocuments = async (page: Page) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

  return { user, team };
};

/** The envelope uploader on the documents page, the same input the other upload specs drive. */
const uploadThroughEnvelopeUploader = async (page: Page, file: UploadFile) => {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .locator('input[type=file]')
      .nth(1)
      .evaluate((e) => {
        if (e instanceof HTMLInputElement) {
          e.click();
        }
      }),
  ]);

  await fileChooser.setFiles(file);
};

const uploadThroughLegacyUploader = async (page: Page, file: UploadFile) => {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Document (Legacy)' }).click(),
  ]);

  await fileChooser.setFiles(file);
};

const readToast = async (page: Page) => {
  const toast = page.locator('[data-testid="toast"]').first();

  await expect(toast).toBeVisible({ timeout: 20_000 });

  return (await toast.innerText()).trim();
};

const countDocuments = async (teamId: number) =>
  await prisma.envelope.count({ where: { teamId, type: EnvelopeType.DOCUMENT } });

test('password_pdf_shows_a_password_protected_message_distinct_from_a_broken_file_message', async ({ page }) => {
  const { team } = await signInToDocuments(page);
  const documentsUrl = page.url();

  await uploadThroughEnvelopeUploader(page, {
    name: 'not-really-a.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nthis is not a PDF body\n%%EOF\n'),
  });
  const brokenFileMessage = await readToast(page);

  await page.goto(documentsUrl);

  await uploadThroughEnvelopeUploader(page, {
    name: 'password.pdf',
    mimeType: 'application/pdf',
    buffer: await buildOpenPasswordPdf(),
  });
  const passwordMessage = await readToast(page);

  expect(passwordMessage, 'the message says the file is password-protected').toMatch(/password/i);
  expect(passwordMessage, 'the message is not the generic upload failure').not.toBe(brokenFileMessage);

  await expect(page).toHaveURL(documentsUrl);
  expect(await countDocuments(team.id), 'nothing is created').toBe(0);
});

test('owner_restricted_pdf_uploads_through_the_envelope_uploader', async ({ page }) => {
  const { team } = await signInToDocuments(page);

  await uploadThroughEnvelopeUploader(page, {
    name: 'owner-restricted.pdf',
    mimeType: 'application/pdf',
    buffer: await buildOwnerOnlyPdf('AES-256'),
  });

  await page.waitForURL(new RegExp(`/t/${team.url}/documents/envelope_.*`));
  await expect(page.getByRole('heading', { name: 'Recipients' })).toBeVisible();
});

test('owner_restricted_pdf_on_the_legacy_uploader_is_refused_with_a_message_to_use_an_envelope', async ({ page }) => {
  const { team } = await signInToDocuments(page);
  const documentsUrl = page.url();

  await uploadThroughLegacyUploader(page, {
    name: 'owner-restricted.pdf',
    mimeType: 'application/pdf',
    buffer: await buildOwnerOnlyPdf('AES-256'),
  });

  const message = await readToast(page);

  expect(message, 'the message tells the sender to use an envelope instead').toMatch(/envelope/i);
  await expect(page).toHaveURL(documentsUrl);
  expect(await countDocuments(team.id), 'nothing is created').toBe(0);
});
