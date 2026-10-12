/**
 * V1 setFieldsFor* may only resubmit a stored company seal unchanged.
 *
 * Written from the specification and the review finding, without reading the
 * implementation. Spec criterion 10: the V1 tRPC field routes refuse
 * COMPANY_SEAL with 400. The only permitted V1 interaction with a seal is a
 * setFieldsForDocument or setFieldsForTemplate call that resubmits each stored
 * seal exactly once, with the same id, type COMPANY_SEAL and sealId, and which
 * may move or resize its box.
 *
 * | Case                                                                  | Criterion |
 * | --------------------------------------------------------------------- | --------- |
 * | 1 resubmit unchanged with a new position: 200, type and sealId kept   | 10        |
 * | 2 extra COMPANY_SEAL entry without id: 400, no new row                | 10        |
 * | 3 ordinary field resubmitted as COMPANY_SEAL: 400, still TEXT         | 10        |
 * | 4 duplicate ids, seal and TEXT, both orders: 400, seal unchanged      | 10        |
 * | 5 changed or unknown sealId: 400, seal unchanged                      | 10        |
 * | 6 update*Field(s) converting TEXT to COMPANY_SEAL: 400, still TEXT    | 10        |
 *
 * Each test calls the procedure as the envelope owner with a real session and
 * reads the Field rows afterwards.
 */
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';

import {
  buildSealEnvelope,
  createBlueSeal,
  trpcCall as rawTrpcCall,
  SEAL_FIELD_META_TYPE,
  SEAL_FIELD_TYPE,
  type SealSession,
  seedSealWorld,
  test,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const trpcCall = async (
  ctx: Parameters<typeof rawTrpcCall>[0],
  procedure: string,
  input: Record<string, unknown>,
  teamId: number,
) =>
  await rawTrpcCall(ctx, procedure, input, {
    headers: { 'x-team-id': String(teamId) },
  });

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
  const otherSeal = await createBlueSeal(manager, world.organisation.id);

  const built = await buildSealEnvelope(request, world, {
    type: kind === 'document' ? 'DOCUMENT' : 'TEMPLATE',
    recipients: [
      {
        email: world.member.email,
        sealId: seal.id,
        extraFields: [{ type: 'TEXT', fieldMeta: { type: 'text', label: 'control' } }],
      },
    ],
    send: false,
  });

  const person = built.people[0];
  const textField = person.fields.find((f) => f.type === 'TEXT');

  expect(person.sealFieldId, 'precondition: the V2 envelope has a seal field').toBeTruthy();
  expect(textField, 'precondition: the envelope has a TEXT field').toBeTruthy();

  const idKey = kind === 'document' ? 'documentId' : 'templateId';
  const idValue = kind === 'document' ? built.documentId : mapSecondaryIdToTemplateId(built.secondaryId);
  const procedure = kind === 'document' ? 'field.setFieldsForDocument' : 'field.setFieldsForTemplate';

  const entry = (id: number | undefined, type: string, meta: Record<string, unknown>, box = {}) => ({
    ...(id === undefined ? {} : { id }),
    type,
    recipientId: person.id,
    envelopeItemId: built.envelopeItemId,
    pageNumber: 1,
    pageX: 10,
    pageY: 70,
    pageWidth: 20,
    pageHeight: 5,
    fieldMeta: meta,
    ...box,
  });

  const sealMeta = (sealId: string) => ({ type: SEAL_FIELD_META_TYPE, sealId });
  const textMeta = { type: 'text', label: 'control' };
  const sealFieldId = person.sealFieldId as number;
  const textFieldId = (textField as { id: number }).id;

  return {
    world,
    teamId: world.team.id,
    owner,
    seal,
    otherSeal,
    idKey,
    sealFieldId,
    textFieldId,
    entry,
    sealMeta,
    textMeta,
    sealEntry: (box = {}) => entry(sealFieldId, SEAL_FIELD_TYPE, sealMeta(seal.id), box),
    textEntry: () => entry(textFieldId, 'TEXT', textMeta),
    set: async (fields: unknown[]) =>
      await trpcCall(owner.request, procedure, { [idKey]: idValue, fields }, world.team.id),
    call: async (name: string, input: Record<string, unknown>) =>
      await trpcCall(owner.request, name, { [idKey]: idValue, ...input }, world.team.id),
    rows: async () =>
      await prisma.field.findMany({
        where: { envelopeId: built.envelopeId },
        orderBy: { id: 'asc' },
      }),
  };
};

const expect400 = (result: { status: number; text: string }) => {
  expect(result.status, result.text).toBe(400);
};

const byId = <T extends { id: number }>(rows: T[], id: number) => rows.find((r) => r.id === id);

for (const kind of KINDS) {
  const cap = kind === 'document' ? 'Document' : 'Template';

  test(`criterion_10_${kind}_set_fields_resubmitting_the_stored_seal_unchanged_with_a_new_position_is_accepted`, async ({
    signIn,
    request,
  }) => {
    const s = await setup(signIn, request, kind);
    const before = await prisma.field.findUniqueOrThrow({
      where: { id: s.sealFieldId },
    });

    const result = await s.set([s.sealEntry({ pageX: 30, pageY: 50, pageWidth: 25, pageHeight: 8 }), s.textEntry()]);

    expect(result.status, result.text).toBe(200);

    const after = await prisma.field.findUniqueOrThrow({
      where: { id: s.sealFieldId },
    });

    expect(String(after.type)).toBe(SEAL_FIELD_TYPE);
    expect((after.fieldMeta as { sealId?: string } | null)?.sealId, 'sealId kept').toBe(s.seal.id);
    expect(Number(after.positionX), 'moved').toBeCloseTo(30, 3);
    expect(Number(after.positionY), 'moved').toBeCloseTo(50, 3);
    expect(Number(after.width)).toBeCloseTo(25, 3);
    expect(Number(after.height)).toBeCloseTo(8, 3);
    expect(Number(before.positionX), 'precondition: the box really moved').not.toBeCloseTo(30, 3);
  });

  test(`criterion_10_${kind}_set_fields_with_an_extra_new_company_seal_is_refused_and_no_row_is_added`, async ({
    signIn,
    request,
  }) => {
    const s = await setup(signIn, request, kind);
    const before = await s.rows();

    const result = await s.set([
      s.sealEntry(),
      s.textEntry(),
      s.entry(undefined, SEAL_FIELD_TYPE, s.sealMeta(s.seal.id), { pageY: 20 }),
    ]);

    expect400(result);

    const after = await s.rows();

    expect(after.length, 'no field row was added').toBe(before.length);
    expect(after.filter((r) => String(r.type) === SEAL_FIELD_TYPE)).toHaveLength(1);
    expect(byId(after, s.sealFieldId)).toEqual(byId(before, s.sealFieldId));
  });

  test(`criterion_10_${kind}_set_fields_converting_an_ordinary_field_to_a_company_seal_is_refused`, async ({
    signIn,
    request,
  }) => {
    const s = await setup(signIn, request, kind);
    const before = await s.rows();

    const result = await s.set([s.sealEntry(), s.entry(s.textFieldId, SEAL_FIELD_TYPE, s.sealMeta(s.otherSeal.id))]);

    expect400(result);

    const after = await s.rows();

    expect(String(byId(after, s.textFieldId)?.type), 'the field is still TEXT').toBe('TEXT');
    expect(byId(after, s.textFieldId)).toEqual(byId(before, s.textFieldId));
    expect(byId(after, s.sealFieldId)).toEqual(byId(before, s.sealFieldId));
  });

  for (const order of ['seal_first', 'seal_last']) {
    test(`criterion_10_${kind}_set_fields_with_the_seal_id_submitted_twice_${order}_is_refused`, async ({
      signIn,
      request,
    }) => {
      const s = await setup(signIn, request, kind);
      const before = await s.rows();
      const asText = s.entry(s.sealFieldId, 'TEXT', s.textMeta);
      const fields =
        order === 'seal_first' ? [s.sealEntry(), asText, s.textEntry()] : [asText, s.sealEntry(), s.textEntry()];

      const result = await s.set(fields);

      expect400(result);

      const after = await s.rows();

      expect(byId(after, s.sealFieldId)).toEqual(byId(before, s.sealFieldId));
      expect(String(byId(after, s.sealFieldId)?.type)).toBe(SEAL_FIELD_TYPE);
    });
  }

  const sealIdVariants = [
    {
      label: 'another_seal_of_the_same_organisation',
      pick: (s: { otherSeal: { id: string } }) => s.otherSeal.id,
    },
    { label: 'an_unknown_seal', pick: () => 'seal_does_not_exist_0000' },
  ];

  for (const variant of sealIdVariants) {
    test(`criterion_10_${kind}_set_fields_resubmitting_the_seal_with_${variant.label}_is_refused`, async ({
      signIn,
      request,
    }) => {
      const s = await setup(signIn, request, kind);
      const before = await s.rows();

      const result = await s.set([s.entry(s.sealFieldId, SEAL_FIELD_TYPE, s.sealMeta(variant.pick(s))), s.textEntry()]);

      expect400(result);

      const after = await s.rows();

      expect(byId(after, s.sealFieldId)).toEqual(byId(before, s.sealFieldId));
      expect((byId(after, s.sealFieldId)?.fieldMeta as { sealId?: string }).sealId).toBe(s.seal.id);
    });
  }

  for (const many of [false, true]) {
    const procedure = `field.update${cap}Field${many ? 's' : ''}`;

    test(`criterion_10_${kind}_update${many ? '_many' : ''}_converting_an_ordinary_field_to_a_company_seal_is_refused`, async ({
      signIn,
      request,
    }) => {
      const s = await setup(signIn, request, kind);
      const before = await s.rows();
      const field = {
        id: s.textFieldId,
        type: SEAL_FIELD_TYPE,
        fieldMeta: s.sealMeta(s.seal.id),
        pageNumber: 1,
        pageX: 10,
        pageY: 70,
        width: 20,
        height: 5,
      };

      const result = await s.call(procedure, many ? { fields: [field] } : { field });

      expect400(result);

      const after = await s.rows();

      expect(String(byId(after, s.textFieldId)?.type), 'the field is still TEXT').toBe('TEXT');
      expect(byId(after, s.textFieldId)).toEqual(byId(before, s.textFieldId));
      expect(after.length).toBe(before.length);
    });
  }
}
