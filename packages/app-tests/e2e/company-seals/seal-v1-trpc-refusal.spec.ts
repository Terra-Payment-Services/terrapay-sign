/**
 * V1 tRPC field mutations leave a company seal field alone.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * Spec, criterion 10 and failure mode F10: "API v1 field creation with
 * COMPANY_SEAL, and the V1 tRPC field routes, answer 400". A COMPANY_SEAL field
 * stored on a V2 envelope must not be deleted, converted to another type or
 * dropped by any V1 tRPC field mutation, on documents or templates.
 *
 * | Procedure (document and template variants)                   | Criteria | Failure modes |
 * | ------------------------------------------------------------ | -------- | ------------- |
 * | field.update*Field, different type with matching meta        | 10       | F10           |
 * | field.update*Fields, different type with matching meta       | 10       | F10           |
 * | field.delete*Field on the seal field                         | 10       | F10           |
 * | field.setFieldsFor*, seal field omitted (replace all)        | 10       | F10           |
 * | field.setFieldsFor*, seal field resubmitted as another type  | 10       | F10           |
 * | field.setFieldsFor*, empty list                              | 10       | F10           |
 *
 * Each test calls the procedure as the envelope owner with a real session,
 * asserts HTTP 400, and reads the Field row afterwards: still present, still
 * COMPANY_SEAL, same fieldMeta and every other column unchanged. A control
 * call of the same shape on an ordinary field proves the request is well
 * formed, so a refusal cannot come from a malformed input.
 */
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';

import {
  buildSealEnvelope,
  createBlueSeal,
  trpcCall as rawTrpcCall,
  SEAL_FIELD_TYPE,
  type SealSession,
  seedSealWorld,
  test,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

/** The field router resolves the team from the x-team-id header, as the web app sends it. */
const trpcCall = async (
  ctx: Parameters<typeof rawTrpcCall>[0],
  procedure: string,
  input: Record<string, unknown>,
  teamId: number,
) => await rawTrpcCall(ctx, procedure, input, { headers: { 'x-team-id': String(teamId) } });

type Kind = 'document' | 'template';

const KINDS: Kind[] = ['document', 'template'];

const setup = async (
  signIn: (email: string) => Promise<SealSession>,
  request: Parameters<typeof buildSealEnvelope>[0],
  kind: Kind,
) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const owner = await signIn(world.owner.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const build = async (sealId?: string) =>
    await buildSealEnvelope(request, world, {
      type: kind === 'document' ? 'DOCUMENT' : 'TEMPLATE',
      recipients: [
        {
          email: world.member.email,
          sealId,
          extraFields: [{ type: 'TEXT', fieldMeta: { type: 'text', label: 'control' } }],
        },
      ],
      send: false,
    });

  const built = await build(seal.id);
  const person = built.people[0];
  const textField = person.fields.find((f) => f.type === 'TEXT');

  expect(person.sealFieldId, 'precondition: the V2 envelope has a seal field').toBeTruthy();
  expect(textField, 'precondition: the envelope has a TEXT field').toBeTruthy();

  const idKey = kind === 'document' ? 'documentId' : 'templateId';
  const idOf = (b: typeof built) => (kind === 'document' ? b.documentId : mapSecondaryIdToTemplateId(b.secondaryId));

  return {
    world,
    teamId: world.team.id,
    owner,
    built,
    build,
    idKey,
    idOf,
    sealFieldId: person.sealFieldId as number,
    textFieldId: (textField as { id: number }).id,
    recipientId: person.id,
  };
};

const box = { pageNumber: 1, pageX: 10, pageY: 70, width: 20, height: 5 };
const setBox = { pageNumber: 1, pageX: 10, pageY: 70, pageWidth: 20, pageHeight: 5 };

const expectSealUntouched = async (sealFieldId: number, before: unknown) => {
  const after = await prisma.field.findUnique({ where: { id: sealFieldId } });

  expect(after, 'the seal field still exists').not.toBeNull();
  expect(String(after?.type), 'still a company seal').toBe(SEAL_FIELD_TYPE);
  expect(after, 'every column of the seal field is unchanged').toEqual(before);
};

const expect400 = (result: Awaited<ReturnType<typeof trpcCall>>) => {
  expect(result.status, `${result.text}`).toBe(400);
};

for (const kind of KINDS) {
  const cap = kind === 'document' ? 'Document' : 'Template';

  const updates = [
    { label: 'to_text', data: { type: 'TEXT', fieldMeta: { type: 'text', label: 'now text' } } },
    { label: 'to_signature', data: { type: 'SIGNATURE', fieldMeta: { type: 'signature' } } },
  ];

  for (const update of updates) {
    for (const many of [false, true]) {
      const procedure = `field.update${cap}Field${many ? 's' : ''}`;

      test(`criterion_10_v1_trpc_${kind}_update${many ? '_many' : ''}_${update.label}_is_refused_and_the_seal_field_is_unchanged`, async ({
        signIn,
        request,
      }) => {
        const s = await setup(signIn, request, kind);
        const wrap = (id: number, extra: Record<string, unknown>) => {
          const field = { id, ...box, ...update.data, ...extra };

          return { [s.idKey]: s.idOf(s.built), ...(many ? { fields: [field] } : { field }) };
        };

        // Control: the same shape on the ordinary TEXT field works.
        const control = await trpcCall(
          s.owner.request,
          procedure,
          wrap(s.textFieldId, { type: 'TEXT', fieldMeta: { type: 'text', label: 'control ok' } }),
          s.teamId,
        );

        expect(control.ok, `control (TEXT field) must work: ${control.status} ${control.text}`).toBe(true);

        const before = await prisma.field.findUniqueOrThrow({ where: { id: s.sealFieldId } });
        const result = await trpcCall(s.owner.request, procedure, wrap(s.sealFieldId, {}), s.teamId);

        expect400(result);
        await expectSealUntouched(s.sealFieldId, before);
      });
    }
  }

  test(`criterion_10_v1_trpc_${kind}_delete_of_a_seal_field_is_refused_and_the_field_remains`, async ({
    signIn,
    request,
  }) => {
    const s = await setup(signIn, request, kind);
    const procedure = `field.delete${cap}Field`;

    const before = await prisma.field.findUniqueOrThrow({ where: { id: s.sealFieldId } });
    const result = await trpcCall(s.owner.request, procedure, { fieldId: s.sealFieldId }, s.teamId);

    expect400(result);
    await expectSealUntouched(s.sealFieldId, before);

    // Control: the same procedure deletes an ordinary field.
    const control = await trpcCall(s.owner.request, procedure, { fieldId: s.textFieldId }, s.teamId);

    expect(control.ok, `control delete of the TEXT field: ${control.status} ${control.text}`).toBe(true);
    expect(await prisma.field.findUnique({ where: { id: s.textFieldId } })).toBeNull();
  });

  const setVariants = [
    {
      label: 'omitting_the_seal_field',
      fields: (s: { recipientId: number; textFieldId: number; built: { envelopeItemId: string } }) => [
        {
          id: s.textFieldId,
          type: 'TEXT',
          recipientId: s.recipientId,
          envelopeItemId: s.built.envelopeItemId,
          ...setBox,
          fieldMeta: { type: 'text', label: 'kept' },
        },
      ],
    },
    {
      label: 'resubmitting_the_seal_field_as_text',
      fields: (s: { recipientId: number; sealFieldId: number; built: { envelopeItemId: string } }) => [
        {
          id: s.sealFieldId,
          type: 'TEXT',
          recipientId: s.recipientId,
          envelopeItemId: s.built.envelopeItemId,
          ...setBox,
          fieldMeta: { type: 'text', label: 'converted' },
        },
      ],
    },
    { label: 'with_an_empty_list', fields: () => [] },
  ];

  for (const variant of setVariants) {
    test(`criterion_10_v1_trpc_${kind}_set_fields_${variant.label}_is_refused_and_the_seal_field_remains`, async ({
      signIn,
      request,
    }) => {
      const s = await setup(signIn, request, kind);
      const procedure = kind === 'document' ? 'field.setFieldsForDocument' : 'field.setFieldsForTemplate';

      const call = async (target: { id: unknown; fields: unknown[] }) =>
        await trpcCall(s.owner.request, procedure, { [s.idKey]: target.id, fields: target.fields }, s.teamId);

      // Control: the same call shape on an envelope without a seal field works.
      const plain = await s.build(undefined);
      const plainPerson = plain.people[0];
      const plainText = plainPerson.fields.find((f) => f.type === 'TEXT') as { id: number };
      const controlFields = variant.fields({
        recipientId: plainPerson.id,
        textFieldId: plainText.id,
        sealFieldId: plainText.id,
        built: plain,
      });
      const control = await call({ id: s.idOf(plain), fields: controlFields });

      expect(control.ok, `control (no seal field) must work: ${control.status} ${control.text}`).toBe(true);

      const before = await prisma.field.findUniqueOrThrow({ where: { id: s.sealFieldId } });
      const result = await call({
        id: s.idOf(s.built),
        fields: variant.fields({
          recipientId: s.recipientId,
          textFieldId: s.textFieldId,
          sealFieldId: s.sealFieldId,
          built: s.built,
        }),
      });

      expect400(result);
      await expectSealUntouched(s.sealFieldId, before);
    });
  }
}
