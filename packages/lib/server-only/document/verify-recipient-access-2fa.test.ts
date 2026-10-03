import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recipientFindFirst: vi.fn(),
  auditLogCreate: vi.fn(),
  validateEmailCode: vi.fn(),
  assertAttemptAllowed: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: { findFirst: mocks.recipientFindFirst },
    documentAuditLog: { create: mocks.auditLogCreate },
  },
}));
vi.mock('../2fa/email/validate-2fa-token-from-email', () => ({
  validateTwoFactorTokenFromEmail: mocks.validateEmailCode,
}));
vi.mock('./assert-access-auth-2fa-attempt-allowed', () => ({
  assertAccessAuth2FAAttemptAllowed: mocks.assertAttemptAllowed,
}));

const { verifyRecipientAccess2FA } = await import('./verify-recipient-access-2fa');

/**
 * The document used to be served before the emailed code was entered. This is
 * where the code is now checked, and only a correct one yields the cookie
 * that lets the page and the files through.
 */

const recipient = (accessAuth: string[]) => ({
  id: 22,
  envelopeId: 'envelope_1',
  token: 'tok',
  email: 'signer@terrapay.com',
  name: 'Signer',
  authOptions: { accessAuth, actionAuth: [] },
  envelope: { id: 'envelope_1', authOptions: null },
});

const verify = async () =>
  await verifyRecipientAccess2FA({
    token: 'tok',
    authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: '123456' },
  });

describe('verifyRecipientAccess2FA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-that-is-long-enough-to-sign');

    mocks.recipientFindFirst.mockResolvedValue(recipient(['TWO_FACTOR_AUTH']));
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.assertAttemptAllowed.mockResolvedValue(undefined);
  });

  it('returns a cookie for the recipient when the code is correct', async () => {
    mocks.validateEmailCode.mockResolvedValue(true);

    const { cookie } = await verify();

    expect(cookie).toMatch(/^recipientAccess2FA-22=/);
    expect(mocks.auditLogCreate.mock.calls[0][0].data.type).toBe('DOCUMENT_ACCESS_AUTH_2FA_VALIDATED');
  });

  it('refuses a wrong code and records the failure', async () => {
    mocks.validateEmailCode.mockResolvedValue(false);

    await expect(verify()).rejects.toMatchObject({ code: 'TWO_FACTOR_AUTH_FAILED' });

    expect(mocks.auditLogCreate.mock.calls[0][0].data.type).toBe('DOCUMENT_ACCESS_AUTH_2FA_FAILED');
  });

  it('does not check the code once the recipient is locked out', async () => {
    mocks.assertAttemptAllowed.mockRejectedValue(Object.assign(new Error('locked'), { code: 'TOO_MANY_REQUESTS' }));
    mocks.validateEmailCode.mockResolvedValue(true);

    await expect(verify()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(mocks.validateEmailCode).not.toHaveBeenCalled();
  });

  it('refuses a recipient who needs no code', async () => {
    mocks.recipientFindFirst.mockResolvedValue(recipient([]));

    await expect(verify()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(mocks.assertAttemptAllowed).not.toHaveBeenCalled();
  });
});
