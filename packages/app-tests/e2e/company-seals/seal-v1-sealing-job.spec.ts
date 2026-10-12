/**
 * The seal-document job never prints a seal on a V1 envelope.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | a V1 envelope with an injected seal field is not sealed with the   | 10       | F10           |
 * |   legal entity text on first completion                            |          |               |
 * | a reseal of a completed V1 envelope with an injected seal field    | 10       | F10           |
 * |   changes nothing and prints no legal entity text                  |          |               |
 *
 * Spec, "Snapshot at application, rendering and records": "The job refuses a
 * V1 envelope carrying a COMPANY_SEAL field rather than letting the V1
 * inserter print its text." The field is written straight into the database,
 * as the field writers refuse it on V1 (so it can only get there by a bug or
 * an operator). Refusal means the job fails: the envelope does not become
 * COMPLETED and its document data is not replaced. The specification is
 * silent on whether recipient completion itself must also be refused for a V1
 * envelope with a seal field (check 1 of "Who may apply a seal" says the
 * envelope must be V2, which would refuse it), so a refused completion also
 * satisfies the first test: the envelope stays PENDING and no text appears.
 *
 * Each test runs a control envelope through the same path first, so waiting
 * out the job is not vacuous: the control must visibly complete or reseal
 * before the refused one is judged.
 */
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect } from '@playwright/test';

import {
  completeWithToken,
  createBlueSeal,
  pdfText,
  SEAL_FIELD_META_TYPE,
  SEAL_FIELD_TYPE,
  SEAL_PROCEDURES,
  seedSealWorld,
  test,
  trpcCall,
  waitForEnvelopeStatus,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 240_000 });

const GRACE_MS = 15_000;

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

type World = Awaited<ReturnType<typeof seedSealWorld>>;

const seedV1 = async (world: World, email: string) => {
  const document = await seedPendingDocument(world.owner, world.team.id, [email], { internalVersion: 1 });

  expect(document.internalVersion, 'precondition: the envelope is V1').toBe(1);

  return {
    envelopeId: document.id,
    itemId: document.envelopeItems[0].id,
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
    recipient: document.recipients[0],
  };
};

/** The field a bug or an operator could leave on a V1 envelope. customText is what the V1 inserter prints. */
const injectSealField = async (v1: Awaited<ReturnType<typeof seedV1>>, sealId: string, legalEntityName: string) =>
  await prisma.field.create({
    data: {
      envelopeId: v1.envelopeId,
      envelopeItemId: v1.itemId,
      recipientId: v1.recipient.id,
      type: SEAL_FIELD_TYPE as never,
      page: 1,
      positionX: 40,
      positionY: 40,
      width: 20,
      height: 15,
      inserted: true,
      customText: legalEntityName,
      fieldMeta: { type: SEAL_FIELD_META_TYPE, sealId, sealLabel: `Injected (${legalEntityName})` },
    },
  });

const currentPdfText = async (itemId: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: itemId }, include: { documentData: true } });

  return pdfText(new Uint8Array(await getFileServerSide(item.documentData)));
};

test('criterion_10_the_seal_job_does_not_print_a_seal_field_on_a_v1_envelope', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const legalEntityName = `V1 Printed Holdings ${Date.now()} Ltd`;

  const control = await seedV1(world, world.member.email);
  const subject = await seedV1(world, world.otherMember.email);

  await injectSealField(subject, seal.id, legalEntityName);

  const controlDone = await completeWithToken(request, control.recipient.token, control.documentId);

  expect(controlDone.ok, `control completion: ${controlDone.status} ${controlDone.text}`).toBe(true);

  // Completion of the subject may itself be refused; either way the job must never print the text.
  await completeWithToken(request, subject.recipient.token, subject.documentId);

  await waitForEnvelopeStatus(control.envelopeId, 'COMPLETED');
  await sleep(GRACE_MS);

  const stored = await prisma.envelope.findUniqueOrThrow({ where: { id: subject.envelopeId } });

  expect(stored.status, 'a V1 envelope with a seal field is not sealed to COMPLETED').not.toBe('COMPLETED');
  expect(await currentPdfText(subject.itemId), 'the legal entity text is not in the PDF').not.toContain(
    legalEntityName,
  );
});

test('criterion_10_a_reseal_of_a_v1_envelope_with_a_seal_field_changes_nothing_and_prints_no_text', async ({
  signIn,
  request,
}) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const legalEntityName = `V1 Resealed Holdings ${Date.now()} Ltd`;

  const control = await seedV1(world, world.member.email);
  const subject = await seedV1(world, world.otherMember.email);

  for (const v1 of [control, subject]) {
    const done = await completeWithToken(request, v1.recipient.token, v1.documentId);

    expect(done.ok, `completion: ${done.status} ${done.text}`).toBe(true);
    await waitForEnvelopeStatus(v1.envelopeId, 'COMPLETED');
  }

  await injectSealField(subject, seal.id, legalEntityName);

  const itemOf = async (itemId: string) => await prisma.envelopeItem.findUniqueOrThrow({ where: { id: itemId } });
  const controlBefore = await itemOf(control.itemId);
  const subjectBefore = await itemOf(subject.itemId);

  const { user: platformAdmin } = await seedUser({ isAdmin: true });
  const admin = await signIn(platformAdmin.email);

  for (const v1 of [control, subject]) {
    const resealed = await trpcCall(admin.request, SEAL_PROCEDURES.reseal, { id: v1.envelopeId });

    expect(resealed.ok, `reseal request: ${resealed.status} ${resealed.text}`).toBe(true);
  }

  // The control reseal replaces the document data row; that is the signal the job ran.
  await expect
    .poll(async () => (await itemOf(control.itemId)).documentDataId !== controlBefore.documentDataId, {
      timeout: 120_000,
      intervals: [1_000],
    })
    .toBe(true);

  await sleep(GRACE_MS);

  expect((await itemOf(subject.itemId)).documentDataId, 'the refused reseal left the sealed PDF as it was').toBe(
    subjectBefore.documentDataId,
  );
  expect(await currentPdfText(subject.itemId), 'the legal entity text is not in the PDF').not.toContain(
    legalEntityName,
  );
});
