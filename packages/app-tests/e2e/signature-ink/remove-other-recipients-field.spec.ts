import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentSigningOrder, FieldType, RecipientRole, SigningStatus } from '@prisma/client';

import { keepRecord } from '../fixtures/reject-seal';
import {
  errorOf,
  fieldAuditRowsOf,
  fieldState,
  type G4Seeded,
  seedG4Envelope,
  seedInserted,
  signV2,
  unsignV1,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const seedWithActor = async (
  internalVersion: 1 | 2,
  role: RecipientRole,
  signingOrder: DocumentSigningOrder,
): Promise<G4Seeded> => {
  const seeded = await seedG4Envelope({
    internalVersion,
    signingOrder,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        signingStatus: SigningStatus.SIGNED,
        fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: true }],
      },
      // The actor: a later step, so in turn once s1 has signed; an assistant also gets a field of its own.
      { key: 's2', signingOrder: 2, role, fields: [{ key: 'own', type: FieldType.SIGNATURE }] },
      { key: 's3', signingOrder: 3, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
    ],
  });

  await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });
  // s3, a later step, has signed its field but not completed: the field an assistant's scope reaches.
  await seedInserted(seeded, 's3', 'sig', { typed: 'S Three' });

  return seeded;
};

const removeAs = async (request: APIRequestContext, seeded: G4Seeded, actorKey: string, fieldId: number) =>
  seeded.internalVersion === 1
    ? await unsignV1(request, seeded.r[actorKey].token, fieldId, false)
    : await signV2(request, seeded.r[actorKey].token, fieldId, { type: FieldType.SIGNATURE, value: null }, false);

/** The other recipients' signed fields: s1's (an earlier, completed step) and s3's (a later step, not completed). */
const TARGETS = [
  { key: 's1', typed: 'S One' },
  { key: 's3', typed: 'S Three' },
] as const;

for (const version of [1, 2] as const) {
  for (const role of [RecipientRole.SIGNER, RecipientRole.ASSISTANT]) {
    for (const order of [DocumentSigningOrder.PARALLEL, DocumentSigningOrder.SEQUENTIAL]) {
      for (const target of TARGETS) {
        test(`C103 V${version} ${order}: a ${role} removing ${target.key}'s signed field gets 4xx with an AppError code`, async ({
          request,
        }) => {
          test.setTimeout(60_000);

          const seeded = await seedWithActor(version, role, order);
          const field = seeded.r[target.key].fields.sig;
          const before = await fieldState(field.id);

          expect(before, `premise: ${target.key}'s field is inserted with its typed signature`).toMatchObject({
            inserted: true,
            signatureCount: 1,
            signature: { typed: target.typed },
          });
          expect(seeded.r.s2.role, `premise: the actor is a ${role}`).toBe(role);

          const reply = await removeAs(request, seeded, 's2', field.id);
          const error = errorOf(reply);
          const after = await fieldState(field.id);
          const uninserts = await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId, ['DOCUMENT_FIELD_UNINSERTED']);

          await keepRecord(`C103-v${version}-${role}-${order}-${target.key}.json`, {
            status: reply.status,
            code: error.code,
            body: reply.body.slice(0, 400),
            before,
            after,
            uninserts: uninserts.length,
          });

          expect.soft(reply.status, `refused, not a 500 (${reply.body.slice(0, 200)})`).not.toBe(500);
          expect.soft(reply.status >= 400 && reply.status < 500, `a 4xx status, got ${reply.status}`).toBe(true);
          expect.soft(error.code, 'the refusal carries an AppError code').toBeTruthy();
          expect.soft(after, `${target.key}'s field is unchanged`).toEqual(before);
          expect.soft(uninserts.length, 'no uninsert audit row').toBe(0);
        });
      }
    }
  }
}
