/**
 * G1 round 5, C34: the editor's field set-list cannot delete a frozen
 * recipient's field by leaving it out.
 *
 * | Criterion | Test                                                                                    |
 * | --------- | --------------------------------------------------------------------------------------- |
 * | C34       | C34 set-list (V1 / V2) omitting a completed signer's uninserted optional field           |
 * | C34       | C34 set-list (V1 / V2) omitting the optional field of a signer frozen by an inserted field |
 *
 * The frozen signer here is the seed's signer B, because the seed gives extra
 * fields to B; the other signer (the seed's A) stays pending, so the envelope
 * stays PENDING. B holds its SIGNATURE field and an optional TEXT field.
 * Everything is reached through real routes:
 *
 *   - "completed": B signs its SIGNATURE field and completes, leaving the
 *     optional TEXT field uninserted; B is SIGNED.
 *   - "inserted, not completed": B signs its SIGNATURE field and does not
 *     complete; B is NOT_SIGNED with one inserted field. The app allows this:
 *     a recipient inserts fields one at a time before completing.
 *
 * The owner then saves a set-list (V1 field.setFieldsForDocument or V2
 * envelope.field.set) that keeps every field except B's optional TEXT field.
 * It must be refused with a 4xx, not a 5xx, and the field must still exist.
 * Sequential; no interleaving.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import type { Field } from '@prisma/client';
import { FieldType, SigningStatus } from '@prisma/client';

import {
  complete,
  envelopeRow,
  expectOk,
  expectRefused,
  keepRecord,
  type Seeded,
  seedEnvelope,
  sessionFor,
  signV2,
  trpcRaw,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

type Route = 'V1 field.setFieldsForDocument' | 'V2 envelope.field.set';
type State = 'completed' | 'inserted, not completed';

const ROUTES: Route[] = ['V1 field.setFieldsForDocument', 'V2 envelope.field.set'];
const STATES: State[] = ['completed', 'inserted, not completed'];

const submit = async (
  session: Awaited<ReturnType<typeof sessionFor>>,
  route: Route,
  seeded: Seeded,
  fields: Field[],
) => {
  if (route === 'V1 field.setFieldsForDocument') {
    return await trpcRaw(
      session,
      'field.setFieldsForDocument',
      {
        documentId: seeded.documentId,
        fields: fields.map((field) => ({
          id: field.id,
          type: field.type,
          recipientId: field.recipientId,
          envelopeItemId: field.envelopeItemId,
          pageNumber: field.page,
          pageX: Number(field.positionX),
          pageY: Number(field.positionY),
          pageWidth: Number(field.width),
          pageHeight: Number(field.height),
          fieldMeta: field.fieldMeta ?? undefined,
        })),
      },
      { teamId: seeded.teamId },
    );
  }

  return await trpcRaw(
    session,
    'envelope.field.set',
    {
      envelopeId: seeded.envelopeId,
      envelopeType: 'DOCUMENT',
      fields: fields.map((field) => ({
        id: field.id,
        envelopeItemId: field.envelopeItemId,
        recipientId: field.recipientId,
        type: field.type,
        page: field.page,
        positionX: Number(field.positionX),
        positionY: Number(field.positionY),
        width: Number(field.width),
        height: Number(field.height),
        ...(field.fieldMeta ? { fieldMeta: field.fieldMeta } : {}),
      })),
    },
    { teamId: seeded.teamId },
  );
};

for (const route of ROUTES) {
  for (const state of STATES) {
    test(`C34 set-list (${route}) omitting the optional field of a frozen signer (${state}) is refused`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);

      const seeded = await seedEnvelope(request, {
        bFields: [{ type: FieldType.TEXT, fieldMeta: { type: 'text', required: false, label: 'Optional note' } }],
      });
      const optional = seeded.bExtra.find((field) => field.type === FieldType.TEXT);

      if (!optional) {
        throw new Error('The seed gave B no optional TEXT field');
      }

      expectOk(await signV2(request, seeded.b), 'the frozen signer inserts its SIGNATURE field');

      if (state === 'completed') {
        expectOk(await complete(request, seeded, seeded.b), 'the frozen signer completes');
      }

      const frozen = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.b.id } });
      const optionalBefore = await prisma.field.findUniqueOrThrow({ where: { id: optional.id } });

      expect(frozen.signingStatus, 'premise: the frozen signer state').toBe(
        state === 'completed' ? SigningStatus.SIGNED : SigningStatus.NOT_SIGNED,
      );
      expect(
        (await prisma.field.findUniqueOrThrow({ where: { id: seeded.b.fieldId } })).inserted,
        "premise: the frozen signer's SIGNATURE field is inserted",
      ).toBe(true);
      expect(optionalBefore.inserted, 'premise: the optional TEXT field is not inserted').toBe(false);
      expect((await envelopeRow(seeded)).status, 'premise: the envelope is PENDING').toBe('PENDING');

      const session = await sessionFor(page, seeded.userEmail);
      const kept = (
        await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } })
      ).filter((field) => field.id !== optional.id);

      const reply = await submit(session, route, seeded, kept);
      const optionalAfter = await prisma.field.findUnique({ where: { id: optional.id } });

      await keepRecord('C34.json', {
        route,
        state,
        envelopeId: seeded.envelopeId,
        frozenStatus: frozen.signingStatus,
        reply: reply.status,
        body: reply.body.slice(0, 400),
        optionalStillThere: optionalAfter !== null,
      });

      expectRefused(reply, "the set-list that drops the frozen signer's optional field");
      expect.soft(optionalAfter, 'the optional field still exists').not.toBeNull();
    });
  }
}
