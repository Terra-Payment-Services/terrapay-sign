/**
 * The attachment name on the "Signing Complete!" email.
 *
 * Written from the specification before the fix:
 *   1. Each envelope item is attached as `<title>` when the title already ends
 *      in `.pdf` and as `<title>.pdf` otherwise, for V1 and V2 envelopes.
 *   2. Every recipient copy and the owner copy follow rule 1.
 *   3. Nothing else about the email changes.
 *
 * | Test                                      | Rule |
 * | ----------------------------------------- | ---- |
 * | V2 envelope, item title ends in ".pdf"    | 1, 2 |
 * | V2 envelope, item title has no extension  | 1, 2 |
 * | V1 envelope, title ends in ".pdf"         | 1, 2 |
 * | V1 envelope, title has no extension       | 1, 2 |
 *
 * Nothing calls the email handler. Documents are completed through the
 * recipients' own endpoints, the seal job sends the mail inside the server, and
 * the attachment names are read from the Inbucket mail catcher
 * (E2E_INBUCKET_URL).
 */
import fs from 'node:fs';
import path from 'node:path';

import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, Prisma, SendStatus } from '@prisma/client';

import { apiCreateTestContext, apiSeedPendingDocument } from '../../fixtures/api-seeds';
import { signAndCompleteAsRecipient, trpcMutation } from '../../fixtures/protected-pdfs';
import { addressFor, assertMailCatcherReachable, INBUCKET_URL, uniqueLocalPart } from '../../fixtures/send-path';

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../../assets/example.pdf'));

test.describe.configure({ mode: 'parallel' });

test.beforeAll(async ({ request }) => {
  await assertMailCatcherReachable(request);
});

type CompletionMail = { subject: string; attachmentNames: string[] };

/** Waits for the owner's and each recipient's completion email, then returns the attachment names per mailbox. */
const readCompletionMails = async (localParts: string[]) => {
  const byMailbox: Record<string, CompletionMail[]> = {};

  await expect(async () => {
    for (const localPart of localParts) {
      // Node fetch, untraced: a trace would record the sender address, which the artifact scan refuses (#176).
      const listRes = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${localPart}`);

      expect(listRes.ok).toBe(true);

      const list = (await listRes.json()) as Array<{ id: string; subject: string }>;
      const mails: CompletionMail[] = [];

      for (const entry of list) {
        const res = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${localPart}/${entry.id}`);
        const message = (await res.json()) as {
          header: { Subject: string[] };
          attachments?: Array<{ filename: string }>;
        };

        mails.push({
          subject: message.header.Subject?.[0] ?? entry.subject,
          attachmentNames: (message.attachments ?? []).map((attachment) => attachment.filename),
        });
      }

      byMailbox[localPart] = mails.filter((mail) => mail.attachmentNames.length > 0);

      expect(byMailbox[localPart], `${localPart} should receive a completion email with an attachment`).toHaveLength(1);
    }
  }).toPass({ timeout: 90_000 });

  return byMailbox;
};

const expectAttachmentsNamed = (byMailbox: Record<string, CompletionMail[]>, title: string, expectedName: string) => {
  for (const [localPart, mails] of Object.entries(byMailbox)) {
    expect(mails[0].subject, `${localPart}: the email is the completion email`).toBe('Signing Complete!');
    expect(mails[0].attachmentNames, `${localPart}: attachment name for the title "${title}"`).toEqual([expectedName]);
  }
};

/** A title stem unique to this run; each test appends its own ending and writes the expected name out. */
const stemFor = (label: string) => `Completion ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)} test`;

const ownerLocalPart = (email: string) => email.split('@')[0];

const runV2 = async (request: APIRequestContext, title: string) => {
  test.setTimeout(180_000);

  const localParts = [uniqueLocalPart('cn-v2-a'), uniqueLocalPart('cn-v2-b')];
  const { envelope, distributeResult, user } = await apiSeedPendingDocument(request, {
    title,
    pdfFile: { name: title, data: examplePdf },
    recipients: localParts.map((localPart) => ({ email: addressFor(localPart), name: localPart })),
  });

  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  expect(item.title, 'premise: the V2 item title is the title under test').toBe(title);
  expect(envelope.internalVersion, 'premise: a V2 envelope').toBe(2);

  for (const recipient of distributeResult.recipients) {
    const field = envelope.fields.find((candidate) => candidate.recipientId === recipient.id);

    if (!field) {
      throw new Error(`No field for recipient ${recipient.id}`);
    }

    await signAndCompleteAsRecipient({
      request,
      recipientToken: recipient.token,
      documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
      fieldId: field.id,
    });
  }

  return await readCompletionMails([...localParts, ownerLocalPart(user.email)]);
};

const runV1 = async (request: APIRequestContext, title: string) => {
  test.setTimeout(180_000);

  const { user, team } = await apiCreateTestContext('cn-v1');
  const localParts = [uniqueLocalPart('cn-v1-a'), uniqueLocalPart('cn-v1-b')];
  const document = await seedDraftDocument(user, team.id, localParts.map(addressFor), {
    internalVersion: 1,
    createDocumentOptions: { title },
  });
  const item = document.envelopeItems[0];

  expect(document.internalVersion, 'premise: a V1 envelope').toBe(1);

  await prisma.envelope.update({ where: { id: document.id }, data: { status: DocumentStatus.PENDING } });

  const recipients = await prisma.recipient.findMany({ where: { envelopeId: document.id } });

  for (const [index, recipient] of recipients.entries()) {
    const field = await prisma.field.create({
      data: {
        envelopeId: document.id,
        envelopeItemId: item.id,
        recipientId: recipient.id,
        type: FieldType.SIGNATURE,
        page: 1,
        positionX: new Prisma.Decimal(10),
        positionY: new Prisma.Decimal(20 + 30 * index),
        width: new Prisma.Decimal(25),
        height: new Prisma.Decimal(8),
        customText: '',
        inserted: true,
      },
    });

    // The seed adds fields of its own; the signer has filled in all of them.
    await prisma.field.updateMany({
      where: { recipientId: recipient.id, type: { not: FieldType.SIGNATURE } },
      data: { inserted: true, customText: 'Signer' },
    });

    await prisma.signature.create({
      data: { recipientId: recipient.id, fieldId: field.id, typedSignature: 'Signer' },
    });
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { sendStatus: SendStatus.SENT, sentAt: new Date(), signedAt: null },
    });
  }

  for (const recipient of recipients) {
    await trpcMutation(request, 'recipient.completeDocumentWithToken', {
      token: recipient.token,
      documentId: mapSecondaryIdToDocumentId(document.secondaryId),
    });
  }

  return await readCompletionMails([...localParts, ownerLocalPart(user.email)]);
};

test('rule_1_2_v2_envelope_with_a_pdf_title_attaches_the_title_unchanged_to_every_copy', async ({ request }) => {
  const stem = stemFor('v2-ext');
  const title = `${stem}.pdf`;

  expectAttachmentsNamed(await runV2(request, title), title, `${stem}.pdf`);
});

test('rule_1_2_v2_envelope_without_an_extension_attaches_the_title_with_pdf_added_to_every_copy', async ({
  request,
}) => {
  const stem = stemFor('v2-bare');
  const title = `${stem}`;

  expectAttachmentsNamed(await runV2(request, title), title, `${stem}.pdf`);
});

test('rule_1_2_v2_envelope_with_an_uppercase_PDF_title_attaches_the_title_unchanged_to_every_copy', async ({
  request,
}) => {
  const stem = stemFor('v2-upper');
  const title = `${stem}.PDF`;

  expectAttachmentsNamed(await runV2(request, title), title, `${stem}.PDF`);
});

test('rule_1_2_v1_envelope_with_a_pdf_title_attaches_the_title_unchanged_to_every_copy', async ({ request }) => {
  const stem = stemFor('v1-ext');
  const title = `${stem}.pdf`;

  expectAttachmentsNamed(await runV1(request, title), title, `${stem}.pdf`);
});

test('rule_1_2_v1_envelope_without_an_extension_attaches_the_title_with_pdf_added_to_every_copy', async ({
  request,
}) => {
  const stem = stemFor('v1-bare');
  const title = `${stem}`;

  expectAttachmentsNamed(await runV1(request, title), title, `${stem}.pdf`);
});

test('rule_1_2_v1_envelope_with_an_uppercase_PDF_title_attaches_the_title_unchanged_to_every_copy', async ({
  request,
}) => {
  const stem = stemFor('v1-upper');
  const title = `${stem}.PDF`;

  expectAttachmentsNamed(await runV1(request, title), title, `${stem}.PDF`);
});
