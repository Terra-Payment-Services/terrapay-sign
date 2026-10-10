/**
 * What the sender sees when Sign refuses a protected or broken PDF (
 * criterion 21, F20).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * On every screen where a sender can meet a refusal, the message must name
 * the cause and must not read as a transient failure ("try again").
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | upload: password-protected PDF                                 | 7, 21    | F6, F20       |
 * | upload (legacy uploader): owner-restricted PDF                 | 9, 21    | F20           |
 * | upload (envelope and legacy uploaders): broken signature       | 17, 21   | F16, F20      |
 * | send a V1 draft: owner-restricted PDF                          | 11, 21   | F20           |
 * | send a V1 draft: broken signature                              | 19, 21   | F18, F20      |
 * | use a V1 template: owner-restricted PDF                        | 9, 21    | F20           |
 * | use a V1 template: broken signature                            | 19, 21   | F18, F20      |
 * | sign a V1 direct template: owner-restricted PDF                | 12, 21   | F11, F20      |
 * | sign a V1 direct template: broken signature                    | 21       | F20           |
 * | send a V1 draft whose processing would break the signature      | 24       | F17, F20      |
 * | sign a V1 direct template: password, restricted, broken; each   | 25       | F20           |
 * |   message names its own cause and no other                     |          |               |
 *
 * The causes are matched loosely, since the specification gives no wording:
 * "password" for a password-protected file; restricted, protected, encrypted
 * or permissions for an owner-restricted file on a legacy document; and a
 * signature that is already invalid for a broken signature. The generic
 * patterns refused are "try again", "something went wrong", "an error
 * occurred" and "unknown error".
 *
 * The V1 drafts, templates and direct templates are seeded and their PDF
 * replaced in the database, as the criterion 12 specs do. The sending steps
 * are those of stepper-component.spec.ts, with an approver so that no field
 * is needed; the use-template steps are those of template-use-dialog.spec.ts;
 * the direct-template steps are those of direct-templates.spec.ts.
 *
 * A V1 template used for a document might legitimately yield an envelope
 * (V2), which can keep owner restrictions. For the owner-restricted
 * use-template test, a created document that is not V1 is therefore accepted;
 * a V1 document is not. A broken signature has no acceptable outcome but a
 * refusal.
 */
import { FIELD_SIGNATURE_META_DEFAULT_VALUES } from '@documenso/lib/types/field-meta';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate, seedTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { DocumentStatus, EnvelopeType, FieldType, SendStatus } from '@prisma/client';
import { apiSignin } from '../fixtures/authentication';

import {
  assertVerifierToolsPresent,
  buildCounterpartySignedFormPdfNeedingRecovery,
  buildOpenPasswordPdf,
  buildOwnerOnlyPdf,
  buildSignedThenTamperedPdf,
  expectCounterpartySignatureStillValid,
  expectFixtureCounterpartySignatureValid,
  FORM_VALUES,
} from '../fixtures/protected-pdfs';
import { signSignaturePad } from '../fixtures/signature';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

type Cause = 'password' | 'legacy-restricted' | 'broken-signature';

const CAUSE_PATTERNS: Record<Cause, RegExp[]> = {
  password: [/password/i],
  'legacy-restricted': [/restrict|protect|encrypt|permission/i],
  'broken-signature': [/signature/i, /already|invalid|broken|not valid|does not verify|fails? to verify/i],
};

const GENERIC_FAILURE = /try again|something went wrong|an error occurred|unknown error/i;

const expectMessageNamesCause = (message: string, cause: Cause) => {
  for (const pattern of CAUSE_PATTERNS[cause]) {
    expect(message, `the message names the cause (${cause}): ${pattern}`).toMatch(pattern);
  }

  expect(message, 'the message is not a generic, transient failure').not.toMatch(GENERIC_FAILURE);
};

/** The first toast or alert the screen shows, as text. */
const readRefusalMessage = async (page: Page) => {
  const message = page.locator('[data-testid="toast"], [role="alert"]').filter({ hasText: /\S/ }).first();

  await expect(message, 'the screen shows a refusal message').toBeVisible({ timeout: 20_000 });

  return (await message.innerText()).trim();
};

/**
 * Every refusal the direct-template signer can see: toasts and alerts, and
 * inline error paragraphs on the page (the document viewer reports a PDF it
 * cannot load in the page rather than in a toast). Joined, for criterion 25.
 */
const readSignerMessages = async (page: Page) => {
  const messages = page
    .locator('[data-testid="toast"], [role="alert"], main p')
    .filter({ hasText: /went wrong|cannot|can't|unable|error|refus|password|restrict|signature|invalid/i });

  await expect(messages.first(), 'the signer is shown a message').toBeVisible({ timeout: 20_000 });

  return (await messages.allInnerTexts()).map((text) => text.trim()).join('\n');
};

type UploadFile = { name: string; mimeType: string; buffer: Buffer };

const pdfFile = (name: string, buffer: Buffer): UploadFile => ({ name, mimeType: 'application/pdf', buffer });

const signInAt = async (page: Page, path: (teamUrl: string) => string) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: path(team.url) });

  return { user, team };
};

/** The envelope uploader on the documents page, as protected-pdf-upload-ui.spec.ts drives it. */
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

const replaceEnvelopePdf = async (envelopeId: string, pdf: Buffer) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });
  const base64 = pdf.toString('base64');

  await prisma.documentData.update({ where: { id: item.documentDataId }, data: { data: base64, initialData: base64 } });
};

const countDocuments = async (teamId: number) =>
  await prisma.envelope.count({ where: { teamId, type: EnvelopeType.DOCUMENT } });

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com`;

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test('criterion_21_upload_of_a_password_protected_pdf_names_the_password', async ({ page }) => {
  const { team } = await signInAt(page, (teamUrl) => `/t/${teamUrl}/documents`);

  await uploadThroughEnvelopeUploader(page, pdfFile('password.pdf', await buildOpenPasswordPdf()));

  expectMessageNamesCause(await readRefusalMessage(page), 'password');
  expect(await countDocuments(team.id), 'nothing is created').toBe(0);
});

test('criterion_21_legacy_upload_of_an_owner_restricted_pdf_names_the_restriction', async ({ page }) => {
  const { team } = await signInAt(page, (teamUrl) => `/t/${teamUrl}/documents`);

  await uploadThroughLegacyUploader(page, pdfFile('owner-restricted.pdf', await buildOwnerOnlyPdf('AES-256')));

  expectMessageNamesCause(await readRefusalMessage(page), 'legacy-restricted');
  expect(await countDocuments(team.id), 'nothing is created').toBe(0);
});

for (const uploader of ['envelope', 'legacy'] as const) {
  test(`criterion_21_${uploader}_upload_of_a_pdf_with_a_broken_signature_names_the_signature`, async ({ page }) => {
    const { team } = await signInAt(page, (teamUrl) => `/t/${teamUrl}/documents`);
    const file = pdfFile('broken-signature.pdf', await buildSignedThenTamperedPdf());

    if (uploader === 'envelope') {
      await uploadThroughEnvelopeUploader(page, file);
    } else {
      await uploadThroughLegacyUploader(page, file);
    }

    expectMessageNamesCause(await readRefusalMessage(page), 'broken-signature');
    expect(await countDocuments(team.id), 'nothing is created').toBe(0);
  });
}

// ---------------------------------------------------------------------------
// Send a V1 draft
// ---------------------------------------------------------------------------

/** The V1 editor's steps from stepper-component.spec.ts, with one approver so no field is needed. */
const sendV1DraftThroughEditor = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Add Signers' })).toBeVisible();
  await page.getByPlaceholder('Email').fill(uniqueEmail('v1-send'));
  await page.getByPlaceholder('Name').fill('V1 Approver');
  await page.getByRole('combobox').click();
  await page.getByLabel('Needs to approve').getByText('Needs to approve').click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Add Fields' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Send' }).click();
};

const sendCases = [
  { cause: 'legacy-restricted', build: async () => await buildOwnerOnlyPdf('AES-256') },
  { cause: 'broken-signature', build: buildSignedThenTamperedPdf },
] as const;

for (const { cause, build } of sendCases) {
  test(`criterion_21_sending_a_v1_draft_refused_for_${cause}_names_the_cause`, async ({ page }) => {
    const { user, team } = await seedUser();
    const document = await seedBlankDocument(user, team.id, { internalVersion: 1 });

    await replaceEnvelopePdf(document.id, await build());
    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${document.id}/edit` });
    await sendV1DraftThroughEditor(page);

    expectMessageNamesCause(await readRefusalMessage(page), cause);

    const envelope = await prisma.envelope.findUniqueOrThrow({
      where: { id: document.id },
      include: { recipients: true },
    });

    expect(envelope.status, 'the document was not sent').toBe(DocumentStatus.DRAFT);
    expect(
      envelope.recipients.every((recipient) => recipient.sendStatus === SendStatus.NOT_SENT),
      'nobody was sent the document',
    ).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// Use a V1 template
// ---------------------------------------------------------------------------

/**
 * Everything a refused use-template must not create, counted for the team:
 * documents, recipients on the team's envelopes, document data rows behind
 * the team's envelope items, and audit entries made since `since`.
 */
const teamSnapshot = async (teamId: number, userId: number, since: Date) => ({
  documents: await prisma.envelope.count({ where: { teamId, type: EnvelopeType.DOCUMENT } }),
  recipients: await prisma.recipient.count({ where: { envelope: { teamId } } }),
  documentData: await prisma.documentData.count({ where: { envelopeItem: { envelope: { teamId } } } }),
  auditEntriesSince: await prisma.documentAuditLog.count({
    where: { createdAt: { gte: since }, OR: [{ envelope: { teamId } }, { userId }] },
  }),
});

const seedV1TemplateWithSignatureField = async (pdf: Buffer) => {
  const { user, team } = await seedUser();
  const template = await seedTemplate({ title: 'V1 template', userId: user.id, teamId: team.id, internalVersion: 1 });
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

  await prisma.field.create({
    data: {
      envelopeId: template.id,
      envelopeItemId: item.id,
      recipientId: template.recipients[0].id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: 5,
      positionY: 10,
      width: 20,
      height: 5,
      customText: '',
      inserted: false,
      fieldMeta: FIELD_SIGNATURE_META_DEFAULT_VALUES,
    },
  });
  await replaceEnvelopePdf(template.id, pdf);

  return { user, team, template };
};

for (const { cause, build } of sendCases) {
  test(`criterion_21_using_a_v1_template_refused_for_${cause}_names_the_cause`, async ({ page }) => {
    const { user, team } = await seedV1TemplateWithSignatureField(await build());

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/templates` });

    const since = new Date();
    const before = await teamSnapshot(team.id, user.id, since);

    await page.getByRole('button', { name: 'Use Template' }).click();
    await expect(page.getByRole('heading', { name: 'Create document from template' })).toBeVisible();
    await page.locator('#distributeDocument').click();
    await page.getByRole('button', { name: 'Create and send' }).click();

    const created = page.waitForURL(new RegExp(`/t/${team.url}/documents/envelope_.*`), { timeout: 20_000 }).then(
      () => 'created' as const,
      () => 'not created' as const,
    );
    const refused = readRefusalMessage(page).then(
      (message) => ({ message }),
      () => null,
    );
    const outcome = await Promise.race([created, refused]);

    if (outcome === 'created' && cause === 'legacy-restricted') {
      const documents = await prisma.envelope.findMany({ where: { teamId: team.id, type: EnvelopeType.DOCUMENT } });

      expect(documents, 'one document was created').toHaveLength(1);
      expect(documents[0].internalVersion, 'a V1 document cannot keep the owner restrictions').not.toBe(1);

      return;
    }

    const refusal = typeof outcome === 'object' && outcome ? outcome : await refused;

    expect(refusal, `the sender is shown a refusal (outcome: ${JSON.stringify(outcome)})`).not.toBeNull();
    expectMessageNamesCause(refusal!.message, cause);

    expect(
      await teamSnapshot(team.id, user.id, since),
      'no document, recipient, document data or audit entry was created',
    ).toEqual(before);
  });
}

// ---------------------------------------------------------------------------
// Sign a V1 direct template
// ---------------------------------------------------------------------------

type SeededDirectTemplate = Awaited<ReturnType<typeof seedDirectTemplate>>;

/**
 * The direct-template signing steps of direct-templates.spec.ts. A refusal
 * may come at any step, including the page load, so the steps are attempted
 * and the step reached is recorded; the message is read afterwards.
 */
const attemptDirectTemplateSigning = async (page: Page, template: SeededDirectTemplate) => {
  const field = template.fields[0];

  const stoppedAt = await (async () => {
    await page.goto(formatDirectTemplatePath(template.directLink?.token || ''));
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await page.waitForTimeout(100);
    await page.getByPlaceholder('name@example.com').fill(uniqueEmail('direct-refused'));
    await page.getByRole('button', { name: 'Continue' }).click();
    await signSignaturePad(page);
    await page.locator(`#field-${field.id}`).getByRole('button').click();
    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByRole('button', { name: 'Sign' }).click();
  })().then(
    () => 'every step ran',
    (error: Error) => error.message.split('\n')[0],
  );

  test.info().annotations.push({ type: 'signing attempt', description: stoppedAt });
};

const seedV1DirectTemplateWithPdf = async (pdf: Buffer) => {
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: 'Direct template',
    userId: user.id,
    teamId: team.id,
    internalVersion: 1,
  });

  await replaceEnvelopePdf(template.id, pdf);

  return { team, template };
};

for (const { cause, build } of sendCases) {
  test(`criterion_21_signing_a_v1_direct_template_refused_for_${cause}_names_the_cause`, async ({ page }) => {
    const { team, template } = await seedV1DirectTemplateWithPdf(await build());

    await attemptDirectTemplateSigning(page, template);

    expectMessageNamesCause(await readRefusalMessage(page), cause);
    await expect(
      page.getByRole('heading', { name: 'Document Signed' }),
      'the signer is not told they signed',
    ).toHaveCount(0);
    expect(await countDocuments(team.id), 'no document was created').toBe(0);
  });
}

// ---------------------------------------------------------------------------
// Criterion 24: sending a V1 draft whose processing would break the signature
// ---------------------------------------------------------------------------

test('criterion_24_sending_a_v1_draft_whose_processing_would_break_the_signature_says_so', async ({ page }) => {
  const fixture = await buildCounterpartySignedFormPdfNeedingRecovery();
  const original = expectFixtureCounterpartySignatureValid(fixture);
  const { user, team } = await seedUser();
  const document = await seedBlankDocument(user, team.id, { internalVersion: 1 });

  await replaceEnvelopePdf(document.id, fixture);
  await prisma.envelope.update({ where: { id: document.id }, data: { formValues: FORM_VALUES } });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${document.id}/edit` });
  await sendV1DraftThroughEditor(page);

  const message = await readRefusalMessage(page);
  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: document.id },
    include: { recipients: true, envelopeItems: { include: { documentData: true } } },
  });

  test.info().annotations.push({ type: 'outcome', description: `${envelope.status}: ${message}` });

  if (envelope.status !== DocumentStatus.DRAFT) {
    const stored = new Uint8Array(await getFileServerSide(envelope.envelopeItems[0].documentData));

    expectCounterpartySignatureStillValid(stored, original, 'sent, the stored file');

    return;
  }

  expect(message, 'the message is about the existing signature').toMatch(/signature/i);
  expect(message, 'the message says processing would break it').toMatch(
    /break|broken|rewr|invalidat|alter|chang|modif|damag/i,
  );
  expect(message, 'the message does not blame the file as already invalid').not.toMatch(/already|on arrival/i);
  expect(message, 'the message is not a generic, transient failure').not.toMatch(GENERIC_FAILURE);
  expect(
    envelope.recipients.every((recipient) => recipient.sendStatus === SendStatus.NOT_SENT),
    'nobody was sent the document',
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Criterion 25: the direct-template signer's message names the single cause
// ---------------------------------------------------------------------------

const SINGLE_CAUSES = {
  password: { build: buildOpenPasswordPdf, names: /password/i },
  restricted: { build: async () => await buildOwnerOnlyPdf('AES-256'), names: /restrict|editing|permission/i },
  signature: { build: buildSignedThenTamperedPdf, names: /signature/i },
} as const;

for (const [cause, { build, names }] of Object.entries(SINGLE_CAUSES)) {
  test(`criterion_25_direct_template_message_names_only_its_cause (${cause})`, async ({ page }) => {
    const { team, template } = await seedV1DirectTemplateWithPdf(await build());

    await attemptDirectTemplateSigning(page, template);

    const message = await readSignerMessages(page);

    test.info().annotations.push({ type: 'signer messages', description: message });

    expect(message, `the message names the cause: ${names}`).toMatch(names);

    if (cause === 'signature') {
      expect(message, 'the message says the signature is already invalid').toMatch(/already|invalid|broken/i);
    }

    for (const [other, { names: otherNames }] of Object.entries(SINGLE_CAUSES)) {
      if (other !== cause) {
        expect(message, `the message does not name another cause (${other})`).not.toMatch(otherNames);
      }
    }

    expect(message, 'the message is not a generic, transient failure').not.toMatch(GENERIC_FAILURE);
    expect(await countDocuments(team.id), 'no document was created').toBe(0);
  });
}
