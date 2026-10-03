import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recipient: vi.fn(),
  field: vi.fn(),
  transaction: vi.fn(),
  auditLogCreate: vi.fn(),
  fieldUpdate: vi.fn(),
  signatureDeleteMany: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: { findFirstOrThrow: mocks.recipient },
    field: { findFirstOrThrow: mocks.field },
    documentMeta: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../document/validate-field-auth', () => ({
  validateFieldAuth: vi.fn().mockResolvedValue(undefined),
}));

import { removeSignedFieldWithToken } from './remove-signed-field-with-token';
import { signFieldWithToken } from './sign-field-with-token';

const ASSISTANT_ID = 11;
const SIGNER_ID = 22;

const assistant = {
  id: ASSISTANT_ID,
  envelopeId: 'envelope_1',
  email: 'assistant@terrapay.com',
  name: 'Assistant',
  role: RecipientRole.ASSISTANT,
  signingOrder: 1,
  signingStatus: SigningStatus.NOT_SIGNED,
  expiresAt: null,
  authOptions: null,
};

const envelope = {
  id: 'envelope_1',
  status: DocumentStatus.PENDING,
  deletedAt: null,
  authOptions: null,
  recipients: [],
};

/** A field owned by the SIGNER, not by the assistant acting on it. */
const fieldOwnedBySigner = (type: FieldType) => ({
  id: 99,
  secondaryId: 'field_99',
  type,
  recipientId: SIGNER_ID,
  inserted: false,
  customText: '',
  fieldMeta: null,
  envelope,
  recipient: {
    id: SIGNER_ID,
    signingStatus: SigningStatus.NOT_SIGNED,
    email: 'signer@terrapay.com',
    name: 'Signer',
    role: RecipientRole.SIGNER,
  },
});

describe('assistants cannot act on a co-recipient signature', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.recipient.mockResolvedValue(assistant);
    // Reaching the transaction means the guard let the call through.
    mocks.transaction.mockRejectedValue(new Error('REACHED_TRANSACTION'));
  });

  // CVE-2026-71247. The V1 field query deliberately widens to every
  // later-or-equal-order recipient so an assistant can prefill on their behalf,
  // but it places no restriction on field type. The Signature row is then written
  // with `recipientId: field.recipientId`, so an unguarded call attributes a
  // signature to a signer who never made it.
  it.each([
    FieldType.SIGNATURE,
    FieldType.FREE_SIGNATURE,
  ])('signFieldWithToken refuses a %s field belonging to another recipient', async (type) => {
    mocks.field.mockResolvedValue(fieldOwnedBySigner(type));

    await expect(signFieldWithToken({ token: 'tok', fieldId: 99, value: 'Forged', isBase64: false })).rejects.toThrow(
      `Assistant ${ASSISTANT_ID} cannot sign for recipient ${SIGNER_ID}`,
    );

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    FieldType.SIGNATURE,
    FieldType.FREE_SIGNATURE,
  ])('removeSignedFieldWithToken refuses a %s field belonging to another recipient', async (type) => {
    mocks.field.mockResolvedValue({ ...fieldOwnedBySigner(type), inserted: true });

    await expect(removeSignedFieldWithToken({ token: 'tok', fieldId: 99 })).rejects.toThrow(
      `Assistant ${ASSISTANT_ID} cannot remove the signature of recipient ${SIGNER_ID}`,
    );

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  // The controls. Prefilling another recipient's non-signature fields is the
  // assistant role's whole purpose, and an assistant still owns its own fields.
  // Both must reach the transaction, or the guard has been drawn too wide.
  it('lets an assistant prefill a TEXT field belonging to another recipient', async () => {
    mocks.field.mockResolvedValue(fieldOwnedBySigner(FieldType.TEXT));

    await expect(
      signFieldWithToken({ token: 'tok', fieldId: 99, value: 'Prefilled', isBase64: false }),
    ).rejects.toThrow('REACHED_TRANSACTION');
  });

  it('lets an assistant sign a SIGNATURE field of its own', async () => {
    mocks.field.mockResolvedValue({
      ...fieldOwnedBySigner(FieldType.SIGNATURE),
      recipientId: ASSISTANT_ID,
    });

    await expect(signFieldWithToken({ token: 'tok', fieldId: 99, value: 'Mine', isBase64: false })).rejects.toThrow(
      'REACHED_TRANSACTION',
    );
  });
});

describe('an assistant clearing a field it prefilled is audited', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.recipient.mockResolvedValue(assistant);
    mocks.field.mockResolvedValue({ ...fieldOwnedBySigner(FieldType.TEXT), inserted: true });

    // Run the callback against a stub tx so the writes inside it are observable.
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        field: { update: mocks.fieldUpdate },
        signature: { deleteMany: mocks.signatureDeleteMany },
        documentAuditLog: { create: mocks.auditLogCreate },
      }),
    );
  });

  // The removal used to be logged only when the actor was not an assistant, so
  // an assistant could clear a field and leave nothing behind to show it.
  it('writes a DOCUMENT_FIELD_UNINSERTED audit log', async () => {
    await removeSignedFieldWithToken({ token: 'tok', fieldId: 99 });

    expect(mocks.fieldUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);

    const logged = mocks.auditLogCreate.mock.calls[0][0].data;

    expect(logged.type).toBe('DOCUMENT_FIELD_UNINSERTED');
    expect(logged.email).toBe(assistant.email);
  });
});
