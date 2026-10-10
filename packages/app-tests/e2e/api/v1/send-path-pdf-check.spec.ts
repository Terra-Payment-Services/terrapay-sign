/**
 * The V1 PDF check on every outward notification, on database transport.
 *
 * Written from the specification alone, without reading the send or resend
 * implementation.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | valid V1 document: send, repeat send, resend, redistribute and    | 2, 3     | F4            |
 * |   reminder all succeed and the recipient receives the emails       |          |               |
 * | owner-restricted PENDING V1 document: v1 repeat send refused, no   | 1        | F2            |
 * |   email                                                            |          |               |
 * | owner-restricted PENDING V1 document: tRPC distribute (repeat      | 1        | F2            |
 * |   send) refused, no email                                          |          |               |
 * | owner-restricted PENDING V1 document: v1 resend refused, no email  | 1        | F1            |
 * | owner-restricted PENDING V1 document: tRPC redistribute refused,   | 1        | F1            |
 * |   no email [x3 ciphers]                                            |          |               |
 * | owner-restricted PENDING V1 document: signing reminder sends no    | 1        | F1            |
 * |   email                                                            |          |               |
 *
 * How a failing V1 document exists on database transport. No application path
 * on database transport lets a V1 document's PDF fail the check after a send:
 * V1 creation and template use refuse an owner-restricted PDF, PDF replacement
 * (envelope.item.replacePdf) accepts only V2 envelopes, and database-transport
 * bytes live in the DocumentData row. The one real path is the two-step S3
 * upload URL, which stays writable after send; send-path-pdf-check-two-step
 * covers it. Here the state is arranged directly, as protected-pdf-legacy.spec
 * does for templates: a V1 document seeded with an owner-restricted PDF, which
 * has therefore never passed the check. Criterion 2 lets a fix skip the check
 * only for a revision that provably passed, so it must check these.
 *
 * "The same 400 and data.code as the DRAFT path" is measured, not assumed: each
 * refusal test first sends a seeded DRAFT copy of the same PDF through the same
 * API and requires the PENDING call to answer with that status and code.
 *
 * "No email is sent" is asserted in the Inbucket mail catcher: the recipient's
 * mailbox holds no new message ten seconds after the call. The valid control
 * shows the same mailbox receiving each email within that window.
 *
 * API v1 resend currently answers every error with 500 (organisation-rate-
 * limits.spec documents this). Criterion 1 asks for the DRAFT path's 400, so
 * the v1 resend refusal test also needs that handler to pass the error on.
 */
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, Prisma, SendStatus } from '@prisma/client';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import { assertVerifierToolsPresent, buildOwnerOnlyPdf, OWNER_ONLY_ALGORITHMS } from '../../fixtures/protected-pdfs';
import {
  addressFor,
  assertMailCatcherReachable,
  expectNoNewMail,
  expectSameRefusalAsDraft,
  readMailbox,
  readRefusal,
  runSigningReminder,
  uniqueLocalPart,
  v1Resend,
  v1Send,
  v2Distribute,
  v2Redistribute,
  waitForMail,
} from '../../fixtures/send-path';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(async ({ request }) => {
  assertVerifierToolsPresent();
  await assertMailCatcherReachable(request);
});

type Seeded = { documentId: number; recipientId: number; localPart: string };

/**
 * A V1 document with one signer who has a signature field. With `pdf`, its
 * bytes replace the seed's ordinary PDF. With `pending`, it is in the state a
 * distributed document is in: PENDING, the signer marked SENT.
 */
const seedV1Document = async (
  userId: number,
  teamId: number,
  label: string,
  options: { pdf?: Buffer; pending?: boolean } = {},
): Promise<Seeded> => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const localPart = uniqueLocalPart(label);
  const document = await seedDraftDocument(owner, teamId, [addressFor(localPart)], { internalVersion: 1 });
  const item = document.envelopeItems[0];

  if (options.pdf) {
    const base64 = options.pdf.toString('base64');

    await prisma.documentData.update({
      where: { id: item.documentDataId },
      data: { data: base64, initialData: base64 },
    });
  }

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  await prisma.field.create({
    data: {
      envelopeId: document.id,
      envelopeItemId: item.id,
      recipientId: recipient.id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(60),
      width: new Prisma.Decimal(25),
      height: new Prisma.Decimal(8),
      customText: '',
      inserted: false,
    },
  });

  if (options.pending) {
    await prisma.envelope.update({ where: { id: document.id }, data: { status: DocumentStatus.PENDING } });
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { sendStatus: SendStatus.SENT, sentAt: new Date() },
    });
  }

  return { documentId: mapSecondaryIdToDocumentId(document.secondaryId), recipientId: recipient.id, localPart };
};

test('criteria_2_3_valid_v1_document_is_sent_resent_and_reminded_and_the_recipient_receives_each_email', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const { token, user, team } = await apiCreateTestContext('spt-valid-control');
  const { documentId, recipientId, localPart } = await seedV1Document(user.id, team.id, 'valid');

  const first = await v1Send(request, token, documentId);

  expect(first.status(), `first send: ${await first.text()}`).toBe(200);

  let count = (await waitForMail(request, localPart, 1)).length;

  const repeat = await v1Send(request, token, documentId);

  expect(repeat.status(), `repeat send of the PENDING document: ${await repeat.text()}`).toBe(200);

  const repeatV2 = await v2Distribute(request, token, documentId);

  expect(repeatV2.status(), `repeat distribute of the PENDING document: ${await repeatV2.text()}`).toBe(200);

  // Whether a repeat send emails a signer already sent to is not specified, so
  // let any such email land before counting.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  count = (await readMailbox(request, localPart)).length;

  const resend = await v1Resend(request, token, documentId, [recipientId]);

  expect(resend.status(), `v1 resend: ${await resend.text()}`).toBe(200);
  count = (await waitForMail(request, localPart, count + 1)).length;

  const redistribute = await v2Redistribute(request, token, documentId, [recipientId]);

  expect(redistribute.status(), `redistribute: ${await redistribute.text()}`).toBe(200);
  count = (await waitForMail(request, localPart, count + 1)).length;

  const reminder = await runSigningReminder(request, recipientId);

  expect(reminder.status(), `reminder job: ${await reminder.text()}`).toBe(200);
  await waitForMail(request, localPart, count + 1);
});

test('criterion_1_v1_repeat_send_of_a_pending_document_with_an_owner_restricted_pdf_is_refused_and_sends_no_email', async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { token, user, team } = await apiCreateTestContext('spt-repeat-send');
  const pdf = await buildOwnerOnlyPdf('AES-256');

  const draft = await seedV1Document(user.id, team.id, 'repeat-draft', { pdf });
  const draftRefusal = await readRefusal(await v1Send(request, token, draft.documentId));

  const pending = await seedV1Document(user.id, team.id, 'repeat-pending', { pdf, pending: true });
  const refusal = await readRefusal(await v1Send(request, token, pending.documentId));

  expectSameRefusalAsDraft(refusal, draftRefusal, 'v1 send of the PENDING document');
  await expectNoNewMail(request, pending.localPart, 0, 'v1 send of the PENDING document');
});

test('criterion_1_trpc_distribute_of_a_pending_document_with_an_owner_restricted_pdf_is_refused_and_sends_no_email', async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { token, user, team } = await apiCreateTestContext('spt-repeat-distribute');
  const pdf = await buildOwnerOnlyPdf('AES-256');

  const draft = await seedV1Document(user.id, team.id, 'distribute-draft', { pdf });
  const draftRefusal = await readRefusal(await v2Distribute(request, token, draft.documentId));

  const pending = await seedV1Document(user.id, team.id, 'distribute-pending', { pdf, pending: true });
  const refusal = await readRefusal(await v2Distribute(request, token, pending.documentId));

  expectSameRefusalAsDraft(refusal, draftRefusal, 'distribute of the PENDING document');
  await expectNoNewMail(request, pending.localPart, 0, 'distribute of the PENDING document');
});

test('criterion_1_v1_resend_of_a_document_with_an_owner_restricted_pdf_is_refused_and_sends_no_email', async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { token, user, team } = await apiCreateTestContext('spt-v1-resend');
  const pdf = await buildOwnerOnlyPdf('AES-256');

  const draft = await seedV1Document(user.id, team.id, 'resend-draft', { pdf });
  const draftRefusal = await readRefusal(await v1Send(request, token, draft.documentId));

  const pending = await seedV1Document(user.id, team.id, 'resend-pending', { pdf, pending: true });
  const refusal = await readRefusal(await v1Resend(request, token, pending.documentId, [pending.recipientId]));

  expectSameRefusalAsDraft(refusal, draftRefusal, 'v1 resend');
  await expectNoNewMail(request, pending.localPart, 0, 'v1 resend');
});

for (const algorithm of OWNER_ONLY_ALGORITHMS) {
  test(`criterion_1_trpc_redistribute_of_a_document_with_an_owner_restricted_pdf_is_refused_and_sends_no_email (${algorithm})`, async ({
    request,
  }) => {
    test.setTimeout(60_000);

    const { token, user, team } = await apiCreateTestContext('spt-redistribute');
    const pdf = await buildOwnerOnlyPdf(algorithm);

    const draft = await seedV1Document(user.id, team.id, 'redistribute-draft', { pdf });
    const draftRefusal = await readRefusal(await v2Distribute(request, token, draft.documentId));

    const pending = await seedV1Document(user.id, team.id, 'redistribute-pending', { pdf, pending: true });
    const refusal = await readRefusal(await v2Redistribute(request, token, pending.documentId, [pending.recipientId]));

    expectSameRefusalAsDraft(refusal, draftRefusal, 'redistribute');
    await expectNoNewMail(request, pending.localPart, 0, 'redistribute');
  });
}

test('criterion_1_signing_reminder_for_a_document_with_an_owner_restricted_pdf_sends_no_email', async ({ request }) => {
  test.setTimeout(60_000);

  const { user, team } = await apiCreateTestContext('spt-reminder');
  const pending = await seedV1Document(user.id, team.id, 'reminder-pending', {
    pdf: await buildOwnerOnlyPdf('AES-256'),
    pending: true,
  });

  await runSigningReminder(request, pending.recipientId);

  await expectNoNewMail(request, pending.localPart, 0, 'signing reminder');
});
