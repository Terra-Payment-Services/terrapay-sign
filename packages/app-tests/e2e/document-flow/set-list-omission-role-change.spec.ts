/**
 * G1 round 6, C35: the editor's field set-list cannot delete an omitted field
 * of a recipient who has interacted, whatever that recipient's role is now.
 *
 * | Criterion | Test                                                                                 |
 * | --------- | ------------------------------------------------------------------------------------ |
 * | C35       | C35 set-list (V1 / V2) omitting the optional field of a signer who inserted, now a CC  |
 *
 * Setup through real routes only. The seed's signer B (the seed attaches extra
 * fields to B) holds a SIGNATURE field and an optional TEXT field; the seed's
 * signer A stays pending, so the envelope stays PENDING. B signs its SIGNATURE
 * field without completing (NOT_SIGNED, one inserted field). An administrator
 * then changes B's role to CC through admin.recipient.update, the route the
 * admin UI calls, which keeps B's fields. The owner then saves a set-list
 * (V1 field.setFieldsForDocument or V2 envelope.field.set) that keeps every
 * field except B's TEXT field. It must be refused with a 4xx, not a 5xx, and
 * the TEXT field must still exist. The administrator works in a browser
 * context of its own so that the two sessions do not share cookies.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import type { Field } from '@prisma/client';
import { FieldType, RecipientRole, SigningStatus } from '@prisma/client';

import {
  adminSession,
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

const ROUTES: Route[] = ['V1 field.setFieldsForDocument', 'V2 envelope.field.set'];

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
  test(`C35 set-list (${route}) omitting the optional field of a signer who inserted a field and is now a CC is refused`, async ({
    browser,
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

    expectOk(await signV2(request, seeded.b), 'B inserts its SIGNATURE field');

    const adminContext = await browser.newContext();
    const admin = await adminSession(await adminContext.newPage());
    const roleReply = await trpcRaw(admin, 'admin.recipient.update', { id: seeded.b.id, role: 'CC' });

    await adminContext.close();

    const b = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.b.id } });
    const optionalBefore = await prisma.field.findUnique({ where: { id: optional.id } });

    await keepRecord('C35-setup.json', {
      envelopeId: seeded.envelopeId,
      roleReply: roleReply.status,
      roleBody: roleReply.body.slice(0, 300),
      bRole: b.role,
      bStatus: b.signingStatus,
      optionalBefore: optionalBefore !== null,
    });

    expectOk(roleReply, "the administrator's change of B to CC");
    expect(b.role, 'premise: B is now a CC').toBe(RecipientRole.CC);
    expect(b.signingStatus, 'premise: B has not completed').toBe(SigningStatus.NOT_SIGNED);
    expect(
      (await prisma.field.findUniqueOrThrow({ where: { id: seeded.b.fieldId } })).inserted,
      "premise: B's SIGNATURE field is inserted",
    ).toBe(true);
    expect(optionalBefore?.inserted, "premise: B's TEXT field exists and is not inserted").toBe(false);
    expect((await envelopeRow(seeded)).status, 'premise: the envelope is PENDING').toBe('PENDING');

    const session = await sessionFor(page, seeded.userEmail);
    const kept = (
      await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } })
    ).filter((field) => field.id !== optional.id);

    const reply = await submit(session, route, seeded, kept);
    const optionalAfter = await prisma.field.findUnique({ where: { id: optional.id } });

    await keepRecord('C35.json', {
      route,
      envelopeId: seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 400),
      optionalStillThere: optionalAfter !== null,
    });

    expectRefused(reply, "the set-list that drops B's TEXT field");
    expect.soft(optionalAfter, "B's TEXT field still exists").not.toBeNull();
  });
}
