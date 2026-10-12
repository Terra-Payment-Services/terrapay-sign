/**
 * Who may apply a company seal: the recipient's own signed-in account,
 * and nobody else.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | a member signed in as the recipient applies the seal, completes   | 13       |               |
 * | the snapshot written is the seal's stored PNG                     | 13       | F8            |
 * | completing without applying the seal is refused                   | 13       |               |
 * | no session: apply answers 401, no image, field stays uninserted   | 14       | F1            |
 * | another account, even a member or the owner, gets 403 and no image| 15       | F2            |
 * | a membership removed after sending blocks application and         | 16       | F3            |
 * |   completion, and the envelope stays PENDING                      |          |               |
 *
 * Expected on main (red run): every test fails creating the first seal.
 */
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';

import {
  applySeal,
  bodyCarriesImage,
  completeWithToken,
  expectRefusal,
  getSealForField,
  readSealField,
  removeFromOrganisation,
  SEAL_ERRORS,
  setupMemberSeal,
  sha256Hex,
  signSignatureField,
  snapshotOf,
  storedSealImage,
  test,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test('criterion_13_a_member_signed_in_as_the_recipient_applies_the_seal_and_the_envelope_completes', async ({
  signIn,
  request,
}) => {
  const { world, seal, built, person } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);
  const png = await storedSealImage(seal);

  const signed = await signSignatureField(request, person.token, person.signatureFieldId as number);

  expect(signed.ok, `signature failed: ${signed.text}`).toBe(true);

  const confirm = await getSealForField(member.request, person.token, person.sealFieldId as number);

  expect(confirm.ok, `confirmation step failed: ${confirm.text}`).toBe(true);
  expect(bodyCarriesImage(confirm.text, png), 'the confirmation step shows the seal image').toBe(true);

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expect(applied.ok, `apply failed: ${applied.status} ${applied.text}`).toBe(true);

  const { field } = await readSealField(person.sealFieldId as number);

  expect(field.inserted).toBe(true);
  expect(field.customText, 'customText carries the legal entity').toBe(seal.legalEntityName);

  const completed = await completeWithToken(member.request, person.token, built.documentId);

  expect(completed.ok, `completion failed: ${completed.status} ${completed.text}`).toBe(true);

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } })).status, {
      timeout: 60_000,
    })
    .toBe('COMPLETED');
});

test('criterion_13_the_snapshot_written_is_the_stored_png_with_no_typed_signature', async ({ signIn, request }) => {
  const { world, seal, person } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expect(applied.ok, `apply failed: ${applied.text}`).toBe(true);

  const { signature } = await readSealField(person.sealFieldId as number);

  expect(signature, 'a Signature row exists for the seal field').toBeTruthy();
  expect(signature?.typedSignature, 'typedSignature is null').toBeNull();
  expect(signature?.signatureImageAsBase64?.startsWith('data:image/png;base64,')).toBe(true);

  const snapshot = snapshotOf(signature);

  expect(snapshot && sha256Hex(snapshot), 'the snapshot is the seal image as stored').toBe(seal.imageSha256);
});

test('criterion_13_completing_without_applying_the_seal_is_refused_because_the_field_is_required', async ({
  signIn,
  request,
}) => {
  const { world, built, person } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);

  await signSignatureField(request, person.token, person.signatureFieldId as number);

  const completed = await completeWithToken(member.request, person.token, built.documentId);

  expect(completed.ok).toBe(false);
  expect(completed.code).toBe('RECIPIENT_HAS_UNSIGNED_FIELDS');

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } })).status).toBe('PENDING');
});

test('criterion_14_without_a_session_apply_answers_401_login_required_and_no_image_is_returned', async ({
  signIn,
  request,
}) => {
  const { seal, person } = await setupMemberSeal(signIn, request);
  const png = await storedSealImage(seal);

  const applied = await applySeal(request, person.token, person.sealFieldId as number);

  expectRefusal(applied, SEAL_ERRORS.loginRequired, 'apply with the link alone');

  const confirm = await getSealForField(request, person.token, person.sealFieldId as number);

  expect(confirm.ok, 'the confirmation step is refused').toBe(false);
  expect(bodyCarriesImage(confirm.text, png), 'no image is returned').toBe(false);

  const { field, signature } = await readSealField(person.sealFieldId as number);

  expect(field.inserted, 'the field stays uninserted').toBe(false);
  expect(signature, 'no Signature row was written').toBeNull();
});

test('criterion_15_another_account_gets_403_and_no_image_even_a_member_or_the_owner', async ({ signIn, request }) => {
  const { world, seal, person } = await setupMemberSeal(signIn, request);
  const png = await storedSealImage(seal);

  const others = {
    'another member of the organisation': await signIn(world.otherMember.email),
    'the manager who created the seal': await signIn(world.manager.email),
    'the owner of the organisation': await signIn(world.owner.email),
    'a manager of another organisation': await signIn(world.foreignManager.email),
  };

  for (const [who, session] of Object.entries(others)) {
    const applied = await applySeal(session.request, person.token, person.sealFieldId as number);

    expectRefusal(applied, SEAL_ERRORS.notAuthorised, `${who} applying`);

    const confirm = await getSealForField(session.request, person.token, person.sealFieldId as number);

    expect.soft(confirm.ok, `${who}: the confirmation step is refused`).toBe(false);
    expect.soft(bodyCarriesImage(confirm.text, png), `${who}: no image is returned`).toBe(false);
  }

  const { field, signature } = await readSealField(person.sealFieldId as number);

  expect(field.inserted, 'the field stays uninserted').toBe(false);
  expect(signature).toBeNull();
});

test('criterion_16_a_membership_removed_after_sending_blocks_application_and_completion', async ({
  signIn,
  request,
}) => {
  const { world, seal, built, person } = await setupMemberSeal(signIn, request);
  const owner = await signIn(world.owner.email);
  const member = await signIn(world.member.email);
  const png = await storedSealImage(seal);

  await removeFromOrganisation(world, owner, world.member.id);

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expectRefusal(applied, SEAL_ERRORS.notAuthorised, 'apply after removal');

  const confirm = await getSealForField(member.request, person.token, person.sealFieldId as number);

  expect.soft(confirm.ok, 'the confirmation step is refused').toBe(false);
  expect.soft(bodyCarriesImage(confirm.text, png), 'no image is returned').toBe(false);

  const signed = await signSignatureField(member.request, person.token, person.signatureFieldId as number);

  expect(signed.ok, `the signature itself is not a seal and still signs: ${signed.text}`).toBe(true);

  const completed = await completeWithToken(member.request, person.token, built.documentId);

  expect(completed.ok).toBe(false);
  expect(completed.code).toBe('RECIPIENT_HAS_UNSIGNED_FIELDS');

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } })).status).toBe('PENDING');
});
