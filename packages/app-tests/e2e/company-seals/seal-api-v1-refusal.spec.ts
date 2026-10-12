/**
 * API v1 refuses company seals on every path.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * | Test                                                                  | Criteria | Failure modes |
 * | --------------------------------------------------------------------- | -------- | ------------- |
 * | create-document from a V2 template with a seal field is refused       | 10       | F10           |
 * | generate-document from a V2 template with a seal field is refused    | 10       | F10           |
 * | v1 PATCH of an existing seal field, to each type, is refused          | 10       | F10           |
 * | v1 DELETE of a seal field is refused and the field remains            | 10       | F10           |
 *
 * Spec, "API and embed scope": "API v1 and the V1 tRPC field routes refuse
 * COMPANY_SEAL with 400 and a message that company seals need a V2 document."
 * The specification defines no error code for the v1 refusal, so the tests
 * check the 400 status and the message, as the existing criterion 10 tests
 * do. The spec is silent on update and delete of an existing field, and on
 * template instantiation; the strictest reading of "refuse COMPANY_SEAL" on
 * every v1 path is taken: 400 and the V2 message, and nothing changes.
 *
 * Each test first proves with a control that the same call works without a
 * seal, so a refusal cannot come from a malformed request.
 */
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';

import {
  API_V1,
  authHeader,
  buildSealEnvelope,
  createBlueSeal,
  SEAL_FIELD_META_TYPE,
  SEAL_FIELD_TYPE,
  seedSealWorld,
  test,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const V1_MESSAGE = /company seals? .*v2|v2 document/i;

const documentsOf = async (teamId: number) => await prisma.envelope.count({ where: { teamId, type: 'DOCUMENT' } });

const sealFieldsInDocuments = async (teamId: number) =>
  await prisma.field.count({ where: { type: SEAL_FIELD_TYPE as never, envelope: { teamId, type: 'DOCUMENT' } } });

// ---------------------------------------------------------------------------
// Template instantiation
// ---------------------------------------------------------------------------

const ENDPOINTS = ['create-document', 'generate-document'] as const;

for (const endpoint of ENDPOINTS) {
  test(`criterion_10_api_v1_${endpoint.replace('-', '_')}_from_a_v2_template_with_a_seal_field_is_refused`, async ({
    signIn,
    request,
  }) => {
    const world = await seedSealWorld();
    const manager = await signIn(world.manager.email);
    const seal = await createBlueSeal(manager, world.organisation.id);

    const call = async (template: Awaited<ReturnType<typeof buildSealEnvelope>>) =>
      await request.post(`${API_V1}/templates/${mapSecondaryIdToTemplateId(template.secondaryId)}/${endpoint}`, {
        headers: authHeader(world.ownerApiToken),
        data:
          endpoint === 'create-document'
            ? {
                title: 'From template',
                recipients: [{ name: 'Member', email: world.member.email, role: 'SIGNER' }],
              }
            : {
                title: 'From template',
                recipients: [{ id: template.people[0].id, email: world.member.email, name: 'Member' }],
              },
      });

    // Control: the same call on a V2 template without a seal field works.
    const plain = await buildSealEnvelope(request, world, {
      type: 'TEMPLATE',
      recipients: [{ email: world.member.email }],
      send: false,
    });
    const control = await call(plain);

    expect(control.ok(), `control (no seal field) must work: ${control.status()} ${await control.text()}`).toBe(true);

    const documentsBefore = await documentsOf(world.team.id);

    expect(await sealFieldsInDocuments(world.team.id), 'precondition: no seal field in any document').toBe(0);

    const template = await buildSealEnvelope(request, world, {
      type: 'TEMPLATE',
      recipients: [{ email: world.member.email, sealId: seal.id }],
      send: false,
    });
    const res = await call(template);
    const text = await res.text();

    expect(res.status(), text).toBe(400);
    expect(text, 'the message says company seals need a V2 document').toMatch(V1_MESSAGE);
    expect(await documentsOf(world.team.id), 'no document was created').toBe(documentsBefore);
    expect(await sealFieldsInDocuments(world.team.id), 'no seal field was copied').toBe(0);
  });
}

// ---------------------------------------------------------------------------
// Update and delete of an existing seal field
// ---------------------------------------------------------------------------

const draftWithSealAndTextField = async (
  request: Parameters<typeof buildSealEnvelope>[0],
  world: Awaited<ReturnType<typeof seedSealWorld>>,
  sealId: string,
) => {
  const built = await buildSealEnvelope(request, world, {
    recipients: [
      {
        email: world.member.email,
        sealId,
        extraFields: [{ type: 'TEXT', fieldMeta: { type: 'text', label: 'control' } }],
      },
    ],
    send: false,
  });
  const person = built.people[0];
  const textField = person.fields.find((f) => f.type === 'TEXT');

  expect(person.sealFieldId, 'precondition: the V2 draft has a seal field').toBeTruthy();
  expect(textField, 'precondition: the draft has a TEXT field for the control').toBeTruthy();

  return { built, sealFieldId: person.sealFieldId as number, textFieldId: (textField as { id: number }).id };
};

const UPDATES = [
  {
    label: 'to_text',
    data: {
      type: 'TEXT',
      pageNumber: 1,
      pageX: 10,
      pageY: 70,
      pageWidth: 20,
      pageHeight: 5,
      fieldMeta: { type: 'text', label: 'now text' },
    },
  },
  {
    label: 'to_signature',
    data: {
      type: 'SIGNATURE',
      pageNumber: 1,
      pageX: 10,
      pageY: 70,
      pageWidth: 20,
      pageHeight: 5,
      fieldMeta: { type: 'signature' },
    },
  },
  {
    label: 'to_company_seal',
    data: {
      type: SEAL_FIELD_TYPE,
      pageNumber: 1,
      pageX: 10,
      pageY: 70,
      pageWidth: 20,
      pageHeight: 15,
      fieldMeta: { type: SEAL_FIELD_META_TYPE, sealId: 'placeholder' },
    },
  },
  { label: 'position_only', data: { pageX: 11, pageY: 71 } },
] as const;

for (const update of UPDATES) {
  test(`criterion_10_api_v1_update_of_a_seal_field_${update.label}_is_refused_and_the_field_is_unchanged`, async ({
    signIn,
    request,
  }) => {
    const world = await seedSealWorld();
    const manager = await signIn(world.manager.email);
    const seal = await createBlueSeal(manager, world.organisation.id);
    const { built, sealFieldId, textFieldId } = await draftWithSealAndTextField(request, world, seal.id);

    const patch = async (fieldId: number, data: Record<string, unknown>) =>
      await request.patch(`${API_V1}/documents/${built.documentId}/fields/${fieldId}`, {
        headers: authHeader(world.ownerApiToken),
        data: { recipientId: built.people[0].id, ...data },
      });

    // Control: a v1 update of an ordinary field on this draft works.
    const control = await patch(textFieldId, { pageX: 12 });

    expect(control.ok(), `control update of the TEXT field: ${control.status()} ${await control.text()}`).toBe(true);

    const data = JSON.parse(JSON.stringify(update.data).replace('placeholder', seal.id));
    const before = await prisma.field.findUniqueOrThrow({ where: { id: sealFieldId } });

    const res = await patch(sealFieldId, data);
    const text = await res.text();

    expect(res.status(), text).toBe(400);
    expect(text, 'the message says company seals need a V2 document').toMatch(V1_MESSAGE);

    const after = await prisma.field.findUniqueOrThrow({ where: { id: sealFieldId } });

    expect(after, 'the seal field is unchanged').toEqual(before);
  });
}

test('criterion_10_api_v1_delete_of_a_seal_field_is_refused_and_the_field_remains', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const { built, sealFieldId, textFieldId } = await draftWithSealAndTextField(request, world, seal.id);

  const remove = async (fieldId: number) =>
    await request.delete(`${API_V1}/documents/${built.documentId}/fields/${fieldId}`, {
      headers: authHeader(world.ownerApiToken),
    });

  const before = await prisma.field.findUniqueOrThrow({ where: { id: sealFieldId } });

  const res = await remove(sealFieldId);
  const text = await res.text();

  expect(res.status(), text).toBe(400);
  expect(text, 'the message says company seals need a V2 document').toMatch(V1_MESSAGE);

  const after = await prisma.field.findUnique({ where: { id: sealFieldId } });

  expect(after, 'the seal field still exists').toEqual(before);

  // Control: the same route deletes an ordinary field, so the refusal above is about the seal.
  const control = await remove(textFieldId);

  expect(control.ok(), `control delete of the TEXT field: ${control.status()} ${await control.text()}`).toBe(true);
  expect(await prisma.field.findUnique({ where: { id: textFieldId } })).toBeNull();
});
