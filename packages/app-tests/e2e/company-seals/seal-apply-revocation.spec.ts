/**
 * Revocation and edge cases when applying a company seal.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | a disabled account's session is gone: login required              | 17       | F3            |
 * | a membership removed after application blocks completion          | 18       | F3            |
 * | a recipient cannot apply with a session and complete without one  | 14, 18   | F1            |
 * | an assistant can neither apply nor prefill a seal                 | 19       | F4            |
 * | removing an applied seal leaves the field uninserted and is logged| 20       |               |
 *
 * Expected on main (red run): every test fails creating the first seal.
 */
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';

import {
  applySeal,
  buildSealEnvelope,
  completeWithToken,
  createBlueSeal,
  expectRefusal,
  readSealField,
  removeFromOrganisation,
  SEAL_ERRORS,
  SEAL_PROCEDURES,
  seedSealWorld,
  setupMemberSeal,
  signSignatureField,
  test,
  trpcCall,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test('criterion_17_after_the_account_is_disabled_the_seal_cannot_be_applied', async ({ signIn, request }) => {
  const { world, person } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);

  // What directory sync does: disable the account. The cookie the browser holds is now refused.
  await prisma.user.update({ where: { id: world.member.id }, data: { disabled: true } });

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expectRefusal(applied, SEAL_ERRORS.loginRequired, 'apply on a disabled account');

  const { field, signature } = await readSealField(person.sealFieldId as number);

  expect(field.inserted).toBe(false);
  expect(signature).toBeNull();
});

test('criterion_18_a_membership_removed_after_the_seal_is_applied_blocks_completion', async ({ signIn, request }) => {
  const { world, built, person } = await setupMemberSeal(signIn, request);
  const owner = await signIn(world.owner.email);
  const member = await signIn(world.member.email);

  await signSignatureField(member.request, person.token, person.signatureFieldId as number);

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expect(applied.ok, `apply failed: ${applied.text}`).toBe(true);

  await removeFromOrganisation(world, owner, world.member.id);

  const completed = await completeWithToken(member.request, person.token, built.documentId);

  expectRefusal(completed, SEAL_ERRORS.notAuthorised, 'complete after removal');

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } })).status).toBe('PENDING');

  const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: person.id } });

  expect(recipient.signingStatus, 'the recipient has not completed').not.toBe('SIGNED');
});

test('criterion_18_a_recipient_cannot_apply_with_a_session_and_complete_without_one', async ({ signIn, request }) => {
  const { world, built, person } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);

  await signSignatureField(request, person.token, person.signatureFieldId as number);

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expect(applied.ok, `apply failed: ${applied.text}`).toBe(true);

  const completed = await completeWithToken(request, person.token, built.documentId);

  expectRefusal(completed, SEAL_ERRORS.loginRequired, 'complete with the link alone');

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } })).status).toBe('PENDING');
});

test('criterion_19_an_assistant_can_neither_apply_nor_prefill_a_seal_field', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const assistantSession = await signIn(world.otherMember.email);

  const built = await buildSealEnvelope(request, world, {
    meta: { signingOrder: 'SEQUENTIAL' },
    recipients: [
      { email: world.otherMember.email, role: 'ASSISTANT', signingOrder: 1, signature: false },
      {
        email: world.member.email,
        signingOrder: 2,
        sealId: seal.id,
        extraFields: [{ type: 'TEXT', fieldMeta: { type: 'text' } }],
      },
    ],
  });

  const assistant = built.personByEmail(world.otherMember.email);
  const signer = built.personByEmail(world.member.email);

  // Control: an assistant can prefill a TEXT field of the signer (not a SIGNATURE field, which main refuses),
  // so a refusal of the seal below is about the seal and not about the setup.
  const textField = signer.fields.find((f) => f.type === 'TEXT');

  expect(textField, 'the signer has a TEXT field').toBeTruthy();

  const prefilled = await trpcCall(assistantSession.request, SEAL_PROCEDURES.signField, {
    token: assistant.token,
    fieldId: textField?.id,
    fieldValue: { type: 'TEXT', value: 'prefilled' },
  });

  expect(prefilled.ok, `control: an assistant prefills a text field: ${prefilled.status} ${prefilled.text}`).toBe(true);

  const applied = await applySeal(assistantSession.request, assistant.token, signer.sealFieldId as number);

  expect(applied.ok, 'the assistant is refused').toBe(false);
  expect(applied.httpStatus, `a refusal, not a server error: ${applied.text.slice(0, 200)}`).toBeLessThan(500);

  const { field, signature } = await readSealField(signer.sealFieldId as number);

  expect(field.inserted, 'the seal field stays uninserted').toBe(false);
  expect(signature).toBeNull();
});

test('criterion_20_removing_an_applied_seal_leaves_the_field_uninserted_and_writes_an_audit_row', async ({
  signIn,
  request,
}) => {
  const { world, built, person } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expect(applied.ok, `apply failed: ${applied.text}`).toBe(true);
  expect((await readSealField(person.sealFieldId as number)).field.inserted).toBe(true);

  const removed = await applySeal(member.request, person.token, person.sealFieldId as number, false);

  expect(removed.ok, `removal failed: ${removed.status} ${removed.text}`).toBe(true);

  const { field, signature } = await readSealField(person.sealFieldId as number);

  expect(field.inserted, 'the field is uninserted').toBe(false);
  expect(field.customText ?? '', 'the legal entity text is cleared').toBe('');
  expect(signature, 'the snapshot is removed').toBeNull();

  const logs = await prisma.documentAuditLog.findMany({
    where: { envelopeId: built.envelopeId, type: 'DOCUMENT_FIELD_UNINSERTED' },
  });

  expect(logs, 'DOCUMENT_FIELD_UNINSERTED is written').toHaveLength(1);

  await signSignatureField(request, person.token, person.signatureFieldId as number);

  const completed = await completeWithToken(member.request, person.token, built.documentId);

  expect(completed.code, 'a removed seal is required again').toBe('RECIPIENT_HAS_UNSIGNED_FIELDS');
});
