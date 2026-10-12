/**
 * A caller who cannot see an envelope learns nothing from a field id.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * Spec: a caller who cannot see an envelope must get the same answer for a
 * company seal field id as for an ordinary field id, so existence and type do
 * not leak.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | V1 tRPC deleteTemplateField, hidden template, seal vs TEXT id     | 10       | F10           |
 * | API v1 DELETE document field, hidden document, seal vs TEXT id    | 10       | F10           |
 *
 * The envelope is made visible to ADMIN only, and the caller is a MEMBER. Both
 * tests compare status and error code between the two ids, and read both Field
 * rows afterwards.
 */

import { hashString } from '@documenso/lib/server-only/auth/hash';
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';

import {
  API_V1,
  authHeader,
  buildSealEnvelope,
  createBlueSeal,
  seedSealWorld,
  test,
  trpcCall,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const setup = async (
  signIn: Parameters<Parameters<typeof test>[2]>[0]['signIn'],
  request: Parameters<typeof buildSealEnvelope>[0],
  type: 'DOCUMENT' | 'TEMPLATE',
) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const member = await signIn(world.member.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const built = await buildSealEnvelope(request, world, {
    type,
    recipients: [
      {
        email: world.otherMember.email,
        sealId: seal.id,
        extraFields: [{ type: 'TEXT', fieldMeta: { type: 'text', label: 'control' } }],
      },
    ],
    send: false,
  });

  const person = built.people[0];
  const sealFieldId = person.sealFieldId as number;
  const textFieldId = (person.fields.find((f) => f.type === 'TEXT') as { id: number }).id;

  expect(sealFieldId, 'precondition: seal field exists').toBeTruthy();

  await prisma.envelope.update({
    where: { id: built.envelopeId },
    data: { visibility: 'ADMIN' },
  });

  return { world, member, built, sealFieldId, textFieldId };
};

/** Blanks the ids that legitimately differ between the two calls. */
const norm = (value: string | undefined, s: { sealFieldId: number; textFieldId: number }) =>
  (value ?? '').split(String(s.sealFieldId)).join('<id>').split(String(s.textFieldId)).join('<id>');

const expectBothStillThere = async (sealFieldId: number, textFieldId: number) => {
  expect(await prisma.field.findUnique({ where: { id: sealFieldId } }), 'seal field still exists').not.toBeNull();
  expect(await prisma.field.findUnique({ where: { id: textFieldId } }), 'TEXT field still exists').not.toBeNull();
};

test('criterion_10_v1_trpc_delete_template_field_on_a_hidden_template_answers_alike_for_seal_and_text', async ({
  signIn,
  request,
}) => {
  const s = await setup(signIn, request, 'TEMPLATE');
  const headers = { 'x-team-id': String(s.world.team.id) };

  const onSeal = await trpcCall(s.member.request, 'field.deleteTemplateField', { fieldId: s.sealFieldId }, { headers });
  const onText = await trpcCall(s.member.request, 'field.deleteTemplateField', { fieldId: s.textFieldId }, { headers });

  expect(onText.ok, `precondition: the hidden template must refuse the member: ${onText.text}`).toBe(false);
  expect(onSeal.status, `seal: ${onSeal.text} / text: ${onText.text}`).toBe(onText.status);
  expect(onSeal.code, `seal: ${onSeal.text} / text: ${onText.text}`).toBe(onText.code);
  expect(norm(onSeal.message, s), 'same error message').toBe(norm(onText.message, s));
  await expectBothStillThere(s.sealFieldId, s.textFieldId);
});

test('criterion_10_api_v1_delete_document_field_on_a_hidden_document_answers_alike_for_seal_and_text', async ({
  signIn,
  request,
}) => {
  const s = await setup(signIn, request, 'DOCUMENT');
  // A MEMBER cannot mint a team token, so the row is seeded directly; the call under test goes over HTTP.
  const token = `api_${Date.now().toString(36)}memberseal`;

  await prisma.apiToken.create({
    data: {
      name: 'seal-member',
      token: hashString(token),
      expires: null,
      userId: s.world.member.id,
      teamId: s.world.team.id,
    },
  });

  const remove = async (fieldId: number) =>
    await request.delete(`${API_V1}/documents/${s.built.documentId}/fields/${fieldId}`, {
      headers: authHeader(token),
    });

  const onSeal = await remove(s.sealFieldId);
  const onText = await remove(s.textFieldId);
  const sealText = await onSeal.text();
  const textText = await onText.text();

  expect(onText.ok(), `precondition: the hidden document must refuse the member: ${textText}`).toBe(false);
  expect(onSeal.status(), `seal: ${sealText} / text: ${textText}`).toBe(onText.status());
  await expectBothStillThere(s.sealFieldId, s.textFieldId);
  expect(norm(sealText, s), 'same response body').toBe(norm(textText, s));
});
