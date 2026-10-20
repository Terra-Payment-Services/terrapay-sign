/**
 * G1 round 3, C31: the editor's field set-list cannot move a field between
 * recipients, so it cannot be used to edit a rejecter's field under another
 * recipient's name.
 *
 * | Criterion | Test                                                                                  |
 * | --------- | ------------------------------------------------------------------------------------- |
 * | C31       | C31 set-list (V1 field.setFieldsForDocument / V2 envelope.field.set): A's field under B |
 * | C31       | C31 set-list (V1 field.setFieldsForDocument / V2 envelope.field.set): B's field under A |
 *
 * A has REJECTED (seedRejectedNotSealed) and B has not signed. Each test first
 * submits a control list through the same route that keeps every field with
 * its own recipient and moves only B's field; it must succeed, which proves the
 * payload shape is accepted. Then it submits the attack list: the same field
 * ids, but one field carries the other recipient's id, with changed geometry
 * and a changed label. That list must be refused with a 4xx, and the field it
 * names must keep its recipient, geometry and meta.
 *
 * Both are deterministic; there is no race.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import type { Field } from '@prisma/client';

import {
  expectOk,
  expectRefused,
  keepRecord,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  sessionFor,
  trpcRaw,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

type Route = 'V1 field.setFieldsForDocument' | 'V2 envelope.field.set';
type Direction = "A's field under B" | "B's field under A";

const ROUTES: Route[] = ['V1 field.setFieldsForDocument', 'V2 envelope.field.set'];
const DIRECTIONS: Direction[] = ["A's field under B", "B's field under A"];

type Entry = {
  id: number;
  recipientId: number;
  envelopeItemId: string;
  type: Field['type'];
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldMeta: Record<string, unknown> | undefined;
};

const entryOf = (field: Field): Entry => ({
  id: field.id,
  recipientId: field.recipientId,
  envelopeItemId: field.envelopeItemId,
  type: field.type,
  page: field.page,
  x: Number(field.positionX),
  y: Number(field.positionY),
  width: Number(field.width),
  height: Number(field.height),
  fieldMeta: (field.fieldMeta ?? undefined) as Record<string, unknown> | undefined,
});

/** What must not change about a field. */
const snapshot = async (fieldId: number) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });

  return {
    recipientId: field.recipientId,
    page: field.page,
    positionX: Number(field.positionX),
    positionY: Number(field.positionY),
    width: Number(field.width),
    height: Number(field.height),
    fieldMeta: field.fieldMeta,
  };
};

const submit = async (
  session: Awaited<ReturnType<typeof sessionFor>>,
  route: Route,
  seeded: Seeded,
  entries: Entry[],
) => {
  if (route === 'V1 field.setFieldsForDocument') {
    return await trpcRaw(
      session,
      'field.setFieldsForDocument',
      {
        documentId: seeded.documentId,
        fields: entries.map((entry) => ({
          id: entry.id,
          type: entry.type,
          recipientId: entry.recipientId,
          envelopeItemId: entry.envelopeItemId,
          pageNumber: entry.page,
          pageX: entry.x,
          pageY: entry.y,
          pageWidth: entry.width,
          pageHeight: entry.height,
          fieldMeta: entry.fieldMeta,
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
      fields: entries.map((entry) => ({
        id: entry.id,
        envelopeItemId: entry.envelopeItemId,
        recipientId: entry.recipientId,
        type: entry.type,
        page: entry.page,
        positionX: entry.x,
        positionY: entry.y,
        width: entry.width,
        height: entry.height,
        ...(entry.fieldMeta ? { fieldMeta: entry.fieldMeta } : {}),
      })),
    },
    { teamId: seeded.teamId },
  );
};

for (const route of ROUTES) {
  for (const direction of DIRECTIONS) {
    test(`C31 set-list (${route}) carrying ${direction} is refused and the field is unchanged`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);

      const seeded = await seedEnvelope(request);

      await seedRejectedNotSealed(seeded);

      const session = await sessionFor(page, seeded.userEmail);
      const rows = await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } });
      const own = rows.map(entryOf);

      expect(
        own.map((entry) => entry.id),
        "premise: the envelope holds A's and B's SIGNATURE fields",
      ).toEqual([seeded.a.fieldId, seeded.b.fieldId].sort((left, right) => left - right));

      // Control: every field with its own recipient, only B's field moved.
      const control = own.map((entry) => (entry.id === seeded.b.fieldId ? { ...entry, x: entry.x + 1 } : entry));
      const controlReply = await submit(session, route, seeded, control);

      const movedId = direction === "A's field under B" ? seeded.a.fieldId : seeded.b.fieldId;
      const otherRecipientId = direction === "A's field under B" ? seeded.b.id : seeded.a.id;
      const before = await snapshot(movedId);

      const attack = (await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } }))
        .map(entryOf)
        .map((entry) =>
          entry.id === movedId
            ? {
                ...entry,
                recipientId: otherRecipientId,
                x: entry.x + 7,
                y: entry.y - 5,
                width: entry.width - 4,
                fieldMeta: { ...(entry.fieldMeta ?? { type: 'signature' }), label: 'G1 C31 moved' },
              }
            : entry,
        );

      const reply = await submit(session, route, seeded, attack);
      const after = await snapshot(movedId);

      await keepRecord('C31.json', {
        route,
        direction,
        envelopeId: seeded.envelopeId,
        controlReply: controlReply.status,
        controlBody: controlReply.body.slice(0, 300),
        reply: reply.status,
        body: reply.body.slice(0, 400),
        before,
        after,
      });

      expectOk(controlReply, `the control list through ${route}`);
      expectRefused(reply, `the set-list carrying ${direction}`);
      expect.soft(after.recipientId, 'the field keeps its recipient').toBe(before.recipientId);
      expect.soft(after, 'the field keeps its geometry and meta').toEqual(before);
    });
  }
}
