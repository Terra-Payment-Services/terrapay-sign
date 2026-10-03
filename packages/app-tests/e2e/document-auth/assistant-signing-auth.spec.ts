import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

type SeededEnvelopes = {
  assistantToken: string;
  otherEnvelopeFieldId: number;
};

/**
 * Seeds two unrelated pending envelopes:
 * - Envelope A has an ASSISTANT (with a token) plus a SIGNER.
 * - Envelope B is owned by a different user and has a SIGNER with a TEXT field.
 *
 * Returns the assistant's token from envelope A and the TEXT field id from
 * envelope B so callers can exercise signing routes across envelopes.
 */
const seedTwoPendingEnvelopes = async (request: APIRequestContext): Promise<SeededEnvelopes> => {
  const envelopeA = await apiSeedPendingDocument(request, {
    title: '[TEST] Envelope A',
    recipients: [
      {
        email: `assistant-${Date.now()}@documenso.com`,
        name: 'Assistant',
        role: 'ASSISTANT',
        signingOrder: 1,
      },
      {
        email: `signer-a-${Date.now()}@documenso.com`,
        name: 'Signer A',
        role: 'SIGNER',
        signingOrder: 2,
      },
    ],
    fieldsPerRecipient: [
      [],
      // SIGNER needs a SIGNATURE field so distribution succeeds.
      [{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 5, height: 5 }],
    ],
  });

  const assistant = envelopeA.distributeResult.recipients.find((r) => r.role === 'ASSISTANT');

  if (!assistant) {
    throw new Error('Assistant recipient not found in envelope A');
  }

  const envelopeB = await apiSeedPendingDocument(request, {
    title: '[TEST] Envelope B',
    recipients: [
      {
        email: `signer-b-${Date.now()}@documenso.com`,
        name: 'Signer B',
        role: 'SIGNER',
        signingOrder: 1,
      },
    ],
    // A TEXT field is used as the cross-envelope target. The V2 route has a
    // separate guard that blocks assistants from signing SIGNATURE fields,
    // which would mask whether the recipient lookup itself was scoped.
    fieldsPerRecipient: [
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 5, height: 5 },
        { type: FieldType.TEXT, page: 1, positionX: 5, positionY: 15, width: 5, height: 5 },
      ],
    ],
  });

  const otherEnvelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeB.envelope.id },
    include: { fields: true },
  });

  const textField = otherEnvelope.fields.find((f) => f.type === FieldType.TEXT);

  if (!textField) {
    throw new Error('TEXT field not found in envelope B');
  }

  return {
    assistantToken: assistant.token,
    otherEnvelopeFieldId: textField.id,
  };
};

type SameEnvelopeSeed = {
  assistantToken: string;
  assistantId: number;
  envelopeId: string;
  signerSignatureFieldId: number;
  signerTextFieldId: number;
};

/**
 * Seeds one pending envelope containing an ASSISTANT at signing order 1 and a
 * SIGNER at signing order 2 who owns both a SIGNATURE and a TEXT field.
 *
 * The assistant is legitimately allowed to prefill the SIGNER's TEXT field.
 * It must not be able to touch the SIGNER's SIGNATURE field, because the
 * Signature row is written against the field's own recipientId and would be
 * attributed to a signer who never made it.
 */
const seedAssistantWithCoRecipient = async (request: APIRequestContext): Promise<SameEnvelopeSeed> => {
  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] Assistant same-envelope',
    recipients: [
      {
        email: `assistant-same-${Date.now()}@documenso.com`,
        name: 'Assistant',
        role: 'ASSISTANT',
        signingOrder: 1,
      },
      {
        email: `signer-same-${Date.now()}@documenso.com`,
        name: 'Signer',
        role: 'SIGNER',
        signingOrder: 2,
      },
    ],
    fieldsPerRecipient: [
      [],
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 5, height: 5 },
        { type: FieldType.TEXT, page: 1, positionX: 5, positionY: 15, width: 5, height: 5 },
      ],
    ],
  });

  const assistant = seeded.distributeResult.recipients.find((r) => r.role === 'ASSISTANT');
  const signer = seeded.distributeResult.recipients.find((r) => r.role === 'SIGNER');

  if (!assistant || !signer) {
    throw new Error('Expected both an ASSISTANT and a SIGNER in the seeded envelope');
  }

  const fields = await prisma.field.findMany({
    where: { envelopeId: seeded.envelope.id, recipientId: signer.id },
  });

  const signatureField = fields.find((f) => f.type === FieldType.SIGNATURE);
  const textField = fields.find((f) => f.type === FieldType.TEXT);

  if (!signatureField || !textField) {
    throw new Error("Signer's SIGNATURE and TEXT fields not found");
  }

  return {
    assistantToken: assistant.token,
    assistantId: assistant.id,
    envelopeId: seeded.envelope.id,
    signerSignatureFieldId: signatureField.id,
    signerTextFieldId: textField.id,
  };
};

const trpcMutation = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  return await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });
};

test.describe('[ASSISTANT_SIGNING_AUTH]: cross-envelope field access', () => {
  test('envelope.field.sign (V2) rejects fieldId from another envelope', async ({ request }) => {
    const { assistantToken, otherEnvelopeFieldId } = await seedTwoPendingEnvelopes(request);

    const res = await trpcMutation(request, 'envelope.field.sign', {
      token: assistantToken,
      fieldId: otherEnvelopeFieldId,
      fieldValue: { type: FieldType.TEXT, value: 'TEXT' },
    });

    expect(res.ok()).toBeFalsy();

    const fieldAfter = await prisma.field.findUniqueOrThrow({
      where: { id: otherEnvelopeFieldId },
    });

    expect(fieldAfter.inserted).toBe(false);
    expect(fieldAfter.customText).toBe('');
  });

  test('field.signFieldWithToken (V1) rejects fieldId from another envelope', async ({ request }) => {
    const { assistantToken, otherEnvelopeFieldId } = await seedTwoPendingEnvelopes(request);

    const res = await trpcMutation(request, 'field.signFieldWithToken', {
      token: assistantToken,
      fieldId: otherEnvelopeFieldId,
      value: 'TEXT',
      isBase64: false,
    });

    expect(res.ok()).toBeFalsy();

    const fieldAfter = await prisma.field.findUniqueOrThrow({
      where: { id: otherEnvelopeFieldId },
    });

    expect(fieldAfter.inserted).toBe(false);
    expect(fieldAfter.customText).toBe('');
  });

  test('field.removeSignedFieldWithToken (V1) rejects fieldId from another envelope', async ({ request }) => {
    const { assistantToken, otherEnvelopeFieldId } = await seedTwoPendingEnvelopes(request);

    // Pre-insert the field so a successful (incorrect) uninsert is detectable.
    await prisma.field.update({
      where: { id: otherEnvelopeFieldId },
      data: { inserted: true, customText: 'pre-existing-value' },
    });

    const res = await trpcMutation(request, 'field.removeSignedFieldWithToken', {
      token: assistantToken,
      fieldId: otherEnvelopeFieldId,
    });

    expect(res.ok()).toBeFalsy();

    const fieldAfter = await prisma.field.findUniqueOrThrow({
      where: { id: otherEnvelopeFieldId },
      include: { recipient: true },
    });

    expect(fieldAfter.inserted).toBe(true);
    expect(fieldAfter.customText).toBe('pre-existing-value');
    expect(fieldAfter.recipient.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  });
});

test.describe('[ASSISTANT_SIGNING_AUTH]: same-envelope signature forgery', () => {
  test('field.signFieldWithToken (V1) refuses to sign a co-recipient SIGNATURE field', async ({ request }) => {
    const { assistantToken, signerSignatureFieldId } = await seedAssistantWithCoRecipient(request);

    const res = await trpcMutation(request, 'field.signFieldWithToken', {
      token: assistantToken,
      fieldId: signerSignatureFieldId,
      value: 'Forged By Assistant',
      isBase64: false,
    });

    expect(res.ok()).toBeFalsy();

    const fieldAfter = await prisma.field.findUniqueOrThrow({
      where: { id: signerSignatureFieldId },
    });

    expect(fieldAfter.inserted).toBe(false);

    const signature = await prisma.signature.findUnique({
      where: { fieldId: signerSignatureFieldId },
    });

    expect(signature).toBeNull();
  });

  test('field.signFieldWithToken (V1) still lets an assistant prefill a co-recipient TEXT field', async ({
    request,
  }) => {
    const { assistantToken, signerTextFieldId } = await seedAssistantWithCoRecipient(request);

    const res = await trpcMutation(request, 'field.signFieldWithToken', {
      token: assistantToken,
      fieldId: signerTextFieldId,
      value: 'Prefilled',
      isBase64: false,
    });

    expect(res.ok()).toBeTruthy();

    const fieldAfter = await prisma.field.findUniqueOrThrow({
      where: { id: signerTextFieldId },
    });

    expect(fieldAfter.inserted).toBe(true);
    expect(fieldAfter.customText).toBe('Prefilled');
  });

  test('field.removeSignedFieldWithToken (V1) refuses to clear a co-recipient signature', async ({ request }) => {
    const { assistantToken, signerSignatureFieldId } = await seedAssistantWithCoRecipient(request);

    const signerField = await prisma.field.update({
      where: { id: signerSignatureFieldId },
      data: { inserted: true },
    });

    await prisma.signature.create({
      data: {
        fieldId: signerField.id,
        recipientId: signerField.recipientId,
        typedSignature: 'Signer',
      },
    });

    const res = await trpcMutation(request, 'field.removeSignedFieldWithToken', {
      token: assistantToken,
      fieldId: signerSignatureFieldId,
    });

    expect(res.ok()).toBeFalsy();

    const fieldAfter = await prisma.field.findUniqueOrThrow({
      where: { id: signerSignatureFieldId },
    });

    expect(fieldAfter.inserted).toBe(true);

    const signature = await prisma.signature.findUnique({
      where: { fieldId: signerSignatureFieldId },
    });

    expect(signature?.typedSignature).toBe('Signer');
  });

  test('an assistant clearing a field it prefilled is written to the audit log', async ({ request }) => {
    const { assistantToken, envelopeId, signerTextFieldId } = await seedAssistantWithCoRecipient(request);

    const signResponse = await trpcMutation(request, 'field.signFieldWithToken', {
      token: assistantToken,
      fieldId: signerTextFieldId,
      value: 'Prefilled',
      isBase64: false,
    });

    expect(signResponse.ok()).toBeTruthy();

    const removeResponse = await trpcMutation(request, 'field.removeSignedFieldWithToken', {
      token: assistantToken,
      fieldId: signerTextFieldId,
    });

    expect(removeResponse.ok()).toBeTruthy();

    const uninsertLogs = await prisma.documentAuditLog.findMany({
      where: {
        envelopeId,
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
      },
    });

    expect(uninsertLogs).toHaveLength(1);
  });
});
