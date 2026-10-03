import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  envelopeFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
  fieldFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
  validateEmailCode: vi.fn(),
  assertAttemptAllowed: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: { findFirst: mocks.envelopeFindFirst },
    user: { findFirst: mocks.userFindFirst },
    field: { findMany: mocks.fieldFindMany },
    documentAuditLog: { create: mocks.auditLogCreate },
  },
}));

vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: vi.fn() } }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../2fa/email/validate-2fa-token-from-email', () => ({
  validateTwoFactorTokenFromEmail: mocks.validateEmailCode,
}));
vi.mock('./assert-access-auth-2fa-attempt-allowed', () => ({
  assertAccessAuth2FAAttemptAllowed: mocks.assertAttemptAllowed,
}));

const { completeDocumentWithToken } = await import('./complete-document-with-token');

const RECIPIENT_USER_ID = 7;

const envelopeWithRecipientAuth = (accessAuth: string[]) => ({
  id: 'envelope_1',
  secondaryId: 'document_1',
  status: 'PENDING',
  authOptions: null,
  documentMeta: null,
  recipients: [
    {
      id: 22,
      envelopeId: 'envelope_1',
      token: 'tok',
      email: 'signer@terrapay.com',
      name: 'Signer',
      role: 'SIGNER',
      signingStatus: 'NOT_SIGNED',
      expiresAt: null,
      authOptions: { accessAuth, actionAuth: [] },
    },
  ],
});

const complete = async (userId?: number, code?: string, isAccess2FAVerified?: boolean) =>
  await completeDocumentWithToken({
    token: 'tok',
    id: { type: 'documentId', id: 1 },
    userId,
    accessAuthOptions: code ? { type: 'TWO_FACTOR_AUTH', method: 'email', token: code } : undefined,
    isAccess2FAVerified,
  });

/**
 * "Require account" was enforced only when the signing page loaded, so a
 * forwarded link was enough to complete the document by calling the mutation
 * directly. Reaching `field.findMany` means the access check let the call past.
 */
describe('completeDocumentWithToken with account access auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.envelopeFindFirst.mockResolvedValue(envelopeWithRecipientAuth(['ACCOUNT']));
    mocks.userFindFirst.mockResolvedValue({ id: RECIPIENT_USER_ID });
    mocks.fieldFindMany.mockRejectedValue(new Error('REACHED_FIELDS'));
  });

  it.each([undefined, 8])('refuses user %s before touching the fields', async (userId) => {
    await expect(complete(userId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mocks.fieldFindMany).not.toHaveBeenCalled();
  });

  it('lets the recipient signed in to their own account through', async () => {
    await expect(complete(RECIPIENT_USER_ID)).rejects.toThrow('REACHED_FIELDS');
  });
});

/**
 * Nothing counted wrong guesses at the emailed access code, so a link holder
 * could keep calling the completion mutation until a code matched. A locked
 * recipient's code must not be evaluated at all.
 */
describe('completeDocumentWithToken with an emailed access code', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.envelopeFindFirst.mockResolvedValue(envelopeWithRecipientAuth(['TWO_FACTOR_AUTH']));
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.fieldFindMany.mockRejectedValue(new Error('REACHED_FIELDS'));
  });

  it('does not check the code once the recipient is locked out', async () => {
    mocks.assertAttemptAllowed.mockRejectedValue(Object.assign(new Error('locked'), { code: 'TOO_MANY_REQUESTS' }));
    mocks.validateEmailCode.mockResolvedValue(true);

    await expect(complete(undefined, '123456')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(mocks.assertAttemptAllowed).toHaveBeenCalledWith({ recipientId: 22 });
    expect(mocks.validateEmailCode).not.toHaveBeenCalled();
    expect(mocks.fieldFindMany).not.toHaveBeenCalled();
  });

  it('counts the attempt and then checks the code while attempts remain', async () => {
    mocks.assertAttemptAllowed.mockResolvedValue(undefined);
    mocks.validateEmailCode.mockResolvedValue(false);

    await expect(complete(undefined, '000000')).rejects.toMatchObject({ code: 'TWO_FACTOR_AUTH_FAILED' });

    expect(mocks.assertAttemptAllowed).toHaveBeenCalledOnce();
    expect(mocks.validateEmailCode).toHaveBeenCalledOnce();
  });
});

describe('completeDocumentWithToken after the access code was entered on the page', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.envelopeFindFirst.mockResolvedValue(envelopeWithRecipientAuth(['TWO_FACTOR_AUTH']));
    mocks.fieldFindMany.mockRejectedValue(new Error('REACHED_FIELDS'));
  });

  it('does not ask for the code again when the cookie vouches for the recipient', async () => {
    await expect(complete(undefined, undefined, true)).rejects.toThrow('REACHED_FIELDS');

    expect(mocks.validateEmailCode).not.toHaveBeenCalled();
  });

  it('asks for the code when the cookie is missing', async () => {
    await expect(complete(undefined, undefined, false)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mocks.fieldFindMany).not.toHaveBeenCalled();
  });
});
