import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * A signing token speaks for one recipient. Every token mutation that writes or
 * clears a field must refuse a field belonging to another SIGNER in the same
 * envelope, or one signer could forge or tear out a co-signer's signature.
 * The assistant role, which may prefill other recipients' fields, is covered
 * in assistant-signing-auth.spec.ts.
 */

const trpcMutation = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  return await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });
};

const seedTwoSigners = async (request: APIRequestContext) => {
  const signerAEmail = `signer-a-${Date.now()}@documenso.com`;
  const signerBEmail = `signer-b-${Date.now()}@documenso.com`;

  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] Two signers',
    recipients: [
      { email: signerAEmail, name: 'Signer A', role: 'SIGNER' },
      { email: signerBEmail, name: 'Signer B', role: 'SIGNER' },
    ],
    fieldsPerRecipient: [
      [{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 5, height: 5 }],
      [{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 25, width: 5, height: 5 }],
    ],
  });

  const signerA = seeded.distributeResult.recipients.find((r) => r.email === signerAEmail);
  const signerB = seeded.distributeResult.recipients.find((r) => r.email === signerBEmail);

  if (!signerA || !signerB) {
    throw new Error('Expected two signers in the seeded envelope');
  }

  const signerBField = await prisma.field.findFirstOrThrow({
    where: { envelopeId: seeded.envelope.id, recipientId: signerB.id, type: FieldType.SIGNATURE },
  });

  return { signerAToken: signerA.token, signerBId: signerB.id, signerBFieldId: signerBField.id };
};

/** Marks signer B's field as signed, so a successful clear by signer A would be visible. */
const preSignForSignerB = async (fieldId: number, recipientId: number) => {
  await prisma.field.update({ where: { id: fieldId }, data: { inserted: true } });

  await prisma.signature.create({
    data: { fieldId, recipientId, typedSignature: 'Signer B' },
  });
};

const expectSignerBSignatureUntouched = async (fieldId: number) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });
  const signature = await prisma.signature.findUnique({ where: { fieldId } });

  expect(field.inserted).toBe(true);
  expect(signature?.typedSignature).toBe('Signer B');
};

test.describe('[RECIPIENT_FIELD_ISOLATION]: a signer cannot change a co-signer signature', () => {
  test('field.signFieldWithToken (V1) refuses to sign a co-signer SIGNATURE field', async ({ request }) => {
    const { signerAToken, signerBFieldId } = await seedTwoSigners(request);

    const res = await trpcMutation(request, 'field.signFieldWithToken', {
      token: signerAToken,
      fieldId: signerBFieldId,
      value: 'Forged By Signer A',
      isBase64: false,
    });

    expect(res.ok()).toBeFalsy();

    const field = await prisma.field.findUniqueOrThrow({ where: { id: signerBFieldId } });

    expect(field.inserted).toBe(false);
    expect(await prisma.signature.findUnique({ where: { fieldId: signerBFieldId } })).toBeNull();
  });

  test('envelope.field.sign (V2) refuses to sign a co-signer SIGNATURE field', async ({ request }) => {
    const { signerAToken, signerBFieldId } = await seedTwoSigners(request);

    const res = await trpcMutation(request, 'envelope.field.sign', {
      token: signerAToken,
      fieldId: signerBFieldId,
      fieldValue: { type: FieldType.SIGNATURE, value: 'Forged By Signer A' },
    });

    expect(res.ok()).toBeFalsy();

    const field = await prisma.field.findUniqueOrThrow({ where: { id: signerBFieldId } });

    expect(field.inserted).toBe(false);
    expect(await prisma.signature.findUnique({ where: { fieldId: signerBFieldId } })).toBeNull();
  });

  test('field.removeSignedFieldWithToken (V1) refuses to clear a co-signer signature', async ({ request }) => {
    const { signerAToken, signerBId, signerBFieldId } = await seedTwoSigners(request);

    await preSignForSignerB(signerBFieldId, signerBId);

    const res = await trpcMutation(request, 'field.removeSignedFieldWithToken', {
      token: signerAToken,
      fieldId: signerBFieldId,
    });

    expect(res.ok()).toBeFalsy();

    await expectSignerBSignatureUntouched(signerBFieldId);
  });

  // A null value is how V2 clears a field, so this is the V2 counterpart of the
  // V1 remove route above.
  test('envelope.field.sign (V2) refuses to clear a co-signer signature', async ({ request }) => {
    const { signerAToken, signerBId, signerBFieldId } = await seedTwoSigners(request);

    await preSignForSignerB(signerBFieldId, signerBId);

    const res = await trpcMutation(request, 'envelope.field.sign', {
      token: signerAToken,
      fieldId: signerBFieldId,
      fieldValue: { type: FieldType.SIGNATURE, value: null },
    });

    expect(res.ok()).toBeFalsy();

    await expectSignerBSignatureUntouched(signerBFieldId);
  });
});
