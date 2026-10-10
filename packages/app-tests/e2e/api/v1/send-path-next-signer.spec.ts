/**
 * The V1 PDF check before the next signer's invitation in a sequential
 * signing order (criterion 1a), on database transport.
 *
 * Written from the specification alone, without reading the completion or
 * send implementation.
 *
 * "Before any outward notification for a V1 document, including the
 * invitation to the next signer in a sequential order, Sign validates the
 * document's current PDF revision."
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | ordinary PDF: the first signer completes, the second signer is     | 1a       | F4            |
 * |   invited by email (control)                                       |          |               |
 * | owner-restricted PDF: the first signer completes, the second       | 1a       | F1            |
 * |   signer receives no email                                         |          |               |
 *
 * The document is seeded as send-path-pdf-check.spec.ts seeds it: a V1
 * document whose PDF is owner-restricted from the start, already distributed
 * (PENDING) to the first signer. The order is sequential, so the second signer
 * is NOT_SENT and is invited only when the first completes.
 *
 * The first signer's fields are filled in the seed and the completion goes
 * through the route the signing page calls, tRPC
 * recipient.completeDocumentWithToken. V1 fields have no API signing route
 * (envelope.field.sign accepts only V2), and the field values are not what is
 * under test.
 *
 * The specification allows two answers to the completion: it is recorded (the
 * first signer is SIGNED), or it is refused before anything changes (the
 * first signer is still NOT_SIGNED and the document still PENDING). The test
 * accepts either and fails on anything in between. In both cases the second
 * signer's mailbox must stay empty.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentSigningOrder, DocumentStatus, FieldType, Prisma, SendStatus, SigningStatus } from '@prisma/client';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import { assertVerifierToolsPresent, buildOwnerOnlyPdf } from '../../fixtures/protected-pdfs';
import {
  addressFor,
  assertMailCatcherReachable,
  expectNoNewMail,
  readMailbox,
  uniqueLocalPart,
  waitForMail,
} from '../../fixtures/send-path';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(async ({ request }) => {
  assertVerifierToolsPresent();
  await assertMailCatcherReachable(request);
});

type Sequential = {
  envelopeId: string;
  documentId: number;
  first: { id: number; token: string };
  secondLocalPart: string;
};

/**
 * A PENDING V1 document, sequential order, two signers with a signature field
 * each. The first signer was sent the document and has filled every field; the
 * second has not been sent anything yet.
 */
const seedSequentialV1Document = async (
  userId: number,
  teamId: number,
  label: string,
  pdf?: Buffer,
): Promise<Sequential> => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const firstLocalPart = uniqueLocalPart(`${label}-first`);
  const secondLocalPart = uniqueLocalPart(`${label}-second`);
  const document = await seedDraftDocument(owner, teamId, [addressFor(firstLocalPart), addressFor(secondLocalPart)], {
    internalVersion: 1,
  });
  const item = document.envelopeItems[0];

  if (pdf) {
    const base64 = pdf.toString('base64');

    await prisma.documentData.update({
      where: { id: item.documentDataId },
      data: { data: base64, initialData: base64 },
    });
  }

  await prisma.documentMeta.update({
    where: { id: document.documentMetaId },
    data: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
  });

  const first = await prisma.recipient.findFirstOrThrow({
    where: { envelopeId: document.id, email: addressFor(firstLocalPart) },
  });
  const second = await prisma.recipient.findFirstOrThrow({
    where: { envelopeId: document.id, email: addressFor(secondLocalPart) },
  });

  for (const [recipient, order] of [
    [first, 1],
    [second, 2],
  ] as const) {
    await prisma.field.create({
      data: {
        envelopeId: document.id,
        envelopeItemId: item.id,
        recipientId: recipient.id,
        type: FieldType.SIGNATURE,
        page: 1,
        positionX: new Prisma.Decimal(10),
        positionY: new Prisma.Decimal(20 + 30 * order),
        width: new Prisma.Decimal(25),
        height: new Prisma.Decimal(8),
        customText: '',
        inserted: false,
      },
    });
    await prisma.recipient.update({ where: { id: recipient.id }, data: { signingOrder: order } });
  }

  await prisma.envelope.update({ where: { id: document.id }, data: { status: DocumentStatus.PENDING } });
  await prisma.recipient.update({
    where: { id: first.id },
    data: { sendStatus: SendStatus.SENT, sentAt: new Date(), signedAt: null },
  });
  await prisma.recipient.update({ where: { id: second.id }, data: { signedAt: null } });

  // The first signer has filled in every field: the seeded name field and the
  // signature field.
  const firstFields = await prisma.field.findMany({ where: { recipientId: first.id } });

  for (const field of firstFields) {
    await prisma.field.update({
      where: { id: field.id },
      data: { inserted: true, customText: field.type === FieldType.SIGNATURE ? '' : 'First Signer' },
    });

    if (field.type === FieldType.SIGNATURE) {
      await prisma.signature.create({
        data: { recipientId: first.id, fieldId: field.id, typedSignature: 'First Signer' },
      });
    }
  }

  return {
    envelopeId: document.id,
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
    first: { id: first.id, token: first.token },
    secondLocalPart,
  };
};

const completeAsFirstSigner = async (request: APIRequestContext, doc: Sequential) =>
  await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/recipient.completeDocumentWithToken`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: { token: doc.first.token, documentId: doc.documentId } }),
  });

test('criterion_1a_ordinary_pdf_completing_the_first_signer_invites_the_second_by_email', async ({ request }) => {
  test.setTimeout(60_000);

  const { user, team } = await apiCreateTestContext('spt-next-signer-control');
  const doc = await seedSequentialV1Document(user.id, team.id, 'next-ok');

  expect(await readMailbox(request, doc.secondLocalPart), 'premise: the second signer has no email yet').toHaveLength(
    0,
  );

  const res = await completeAsFirstSigner(request, doc);

  expect(res.status(), `completion: ${await res.text()}`).toBe(200);
  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: doc.first.id } })).signingStatus).toBe(
    SigningStatus.SIGNED,
  );

  await waitForMail(request, doc.secondLocalPart, 1);
});

test('criterion_1a_owner_restricted_pdf_completing_the_first_signer_does_not_email_the_second', async ({ request }) => {
  test.setTimeout(60_000);

  const { user, team } = await apiCreateTestContext('spt-next-signer');
  const doc = await seedSequentialV1Document(user.id, team.id, 'next-refused', await buildOwnerOnlyPdf('AES-256'));

  const res = await completeAsFirstSigner(request, doc);
  const text = await res.text();

  const first = await prisma.recipient.findUniqueOrThrow({ where: { id: doc.first.id } });
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: doc.envelopeId } });

  // Either answer the specification allows, and nothing in between.
  if (res.ok()) {
    expect(first.signingStatus, `completion answered ${res.status()}, so it is recorded: ${text}`).toBe(
      SigningStatus.SIGNED,
    );
  } else {
    expect(res.status(), `a refusal is the client's problem, not a server error: ${text}`).toBeLessThan(500);
    expect(
      { signingStatus: first.signingStatus, status: envelope.status },
      `completion was refused (${res.status()}), so nothing changed: ${text}`,
    ).toEqual({ signingStatus: SigningStatus.NOT_SIGNED, status: DocumentStatus.PENDING });
  }

  test.info().annotations.push({
    type: 'completion answer',
    description: `${res.status()}; first signer ${first.signingStatus}; document ${envelope.status}; ${text.slice(0, 300)}`,
  });

  await expectNoNewMail(request, doc.secondLocalPart, 0, 'completion of the first signer');
});
