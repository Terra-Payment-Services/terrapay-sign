import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A recipient whose access auth is "require account" was checked only when the
 * signing page loaded. The field mutations take nothing but the signing token,
 * so anyone holding a forwarded link could fill or clear the recipient's
 * fields without signing in.
 */

const mocks = vi.hoisted(() => ({
  recipient: vi.fn(),
  field: vi.fn(),
  user: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: { findFirstOrThrow: mocks.recipient },
    field: { findFirstOrThrow: mocks.field },
    user: { findFirst: mocks.user },
    documentMeta: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: mocks.transaction,
  },
}));

import { removeSignedFieldWithToken } from './remove-signed-field-with-token';
import { signFieldWithToken } from './sign-field-with-token';

const RECIPIENT_USER_ID = 7;

const signer = {
  id: 22,
  envelopeId: 'envelope_1',
  email: 'signer@terrapay.com',
  name: 'Signer',
  role: RecipientRole.SIGNER,
  signingOrder: 1,
  signingStatus: SigningStatus.NOT_SIGNED,
  expiresAt: null,
  authOptions: { accessAuth: ['ACCOUNT'], actionAuth: [] },
};

const textField = (inserted: boolean) => ({
  id: 99,
  secondaryId: 'field_99',
  type: FieldType.TEXT,
  recipientId: signer.id,
  inserted,
  customText: '',
  fieldMeta: null,
  envelope: {
    id: 'envelope_1',
    status: DocumentStatus.PENDING,
    deletedAt: null,
    authOptions: null,
    recipients: [],
  },
  recipient: signer,
});

const sign = async (userId?: number) =>
  await signFieldWithToken({ token: 'tok', fieldId: 99, value: 'Text', isBase64: false, userId });

const remove = async (userId?: number) => await removeSignedFieldWithToken({ token: 'tok', fieldId: 99, userId });

describe('field mutations enforce account access auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.recipient.mockResolvedValue(signer);
    mocks.user.mockResolvedValue({ id: RECIPIENT_USER_ID });
    // Reaching the transaction means the access check let the call through.
    mocks.transaction.mockRejectedValue(new Error('REACHED_TRANSACTION'));
  });

  it.each([undefined, 8])('signFieldWithToken refuses user %s and writes nothing', async (userId) => {
    mocks.field.mockResolvedValue(textField(false));

    await expect(sign(userId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([undefined, 8])('removeSignedFieldWithToken refuses user %s and writes nothing', async (userId) => {
    mocks.field.mockResolvedValue(textField(true));

    await expect(remove(userId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('lets the recipient signed in to their own account sign a field', async () => {
    mocks.field.mockResolvedValue(textField(false));

    await expect(sign(RECIPIENT_USER_ID)).rejects.toThrow('REACHED_TRANSACTION');
  });

  it('lets the recipient signed in to their own account clear a field', async () => {
    mocks.field.mockResolvedValue(textField(true));

    await expect(remove(RECIPIENT_USER_ID)).rejects.toThrow('REACHED_TRANSACTION');
  });

  it('leaves a recipient without access auth free to sign without an account', async () => {
    mocks.recipient.mockResolvedValue({ ...signer, authOptions: null });
    mocks.field.mockResolvedValue(textField(false));

    await expect(sign()).rejects.toThrow('REACHED_TRANSACTION');
  });
});

/**
 * The document is held back until a recipient with an emailed access code has
 * entered it, so no field may be filled or cleared before then either.
 */
describe('field mutations enforce the emailed access code', () => {
  const codeRecipient = { ...signer, authOptions: { accessAuth: ['TWO_FACTOR_AUTH'], actionAuth: [] } };

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.recipient.mockResolvedValue(codeRecipient);
    mocks.transaction.mockRejectedValue(new Error('REACHED_TRANSACTION'));
  });

  it('signFieldWithToken refuses a caller without the code cookie, and writes nothing', async () => {
    mocks.field.mockResolvedValue(textField(false));

    await expect(
      signFieldWithToken({ token: 'tok', fieldId: 99, value: 'Text', isBase64: false }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('removeSignedFieldWithToken refuses a caller without the code cookie, and writes nothing', async () => {
    mocks.field.mockResolvedValue(textField(true));

    await expect(removeSignedFieldWithToken({ token: 'tok', fieldId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('lets a recipient who entered the code sign and clear fields', async () => {
    mocks.field.mockResolvedValueOnce(textField(false)).mockResolvedValueOnce(textField(true));

    await expect(
      signFieldWithToken({ token: 'tok', fieldId: 99, value: 'Text', isBase64: false, isAccess2FAVerified: true }),
    ).rejects.toThrow('REACHED_TRANSACTION');
    await expect(removeSignedFieldWithToken({ token: 'tok', fieldId: 99, isAccess2FAVerified: true })).rejects.toThrow(
      'REACHED_TRANSACTION',
    );
  });
});
