import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C40, resend (C27, C32). The exported prisma client reads from replicas when NEXT_PRIVATE_DATABASE_REPLICA_URLS is
 * set. The envelope read at the top of `resendDocument` can be stale, and the real `hasEnvelopeRejection` helper is
 * the check just before each send, so the test follows its read.
 *
 * Failure modes this file pins:
 *  1. The envelope read shows no rejected recipient, the replica answers null to the helper, and the primary has a
 *     REJECTED recipient: no reminder may be mailed. The call may resolve or throw; only the mail is pinned.
 *  2. A suppressed reminder records nothing: no SENT mark and no EMAIL_SENT audit row.
 *  3. No rejection anywhere: the reminder is mailed, so the harness is proven able to send and a fix cannot pass by
 *     always suppressing.
 */

const sendMail = vi.fn();
const replicaRecipientFindFirst = vi.fn();
const primaryRecipientFindFirst = vi.fn();
const recipientUpdateMany = vi.fn();
const auditCreate = vi.fn();

const envelopeRow = () => ({
  id: 'envelope_1',
  userId: 1,
  teamId: 7,
  title: 'Contract',
  status: 'PENDING',
  internalVersion: 2,
  documentMeta: { subject: '', message: '', envelopeExpirationPeriod: null },
  envelopeItems: [],
  recipients: [
    {
      id: 41,
      email: 'counterparty@example.com',
      name: 'Counterparty',
      role: 'SIGNER',
      token: 'token-41',
      signingStatus: 'NOT_SIGNED',
    },
  ],
  team: { teamEmail: null, name: 'Team', organisation: { organisationClaim: { recipientCount: 0 } } },
});

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: {
      findFirstOrThrow: async () => ({ id: 1, email: 'owner@example.com', name: 'Owner', disabled: false }),
    },
    envelope: { findUnique: async () => envelopeRow() },
    recipient: {
      findFirst: async (...args: unknown[]) => await replicaRecipientFindFirst(...args),
      updateMany: async (...args: unknown[]) => await recipientUpdateMany(...args),
    },
    documentAuditLog: { create: async (...args: unknown[]) => await auditCreate(...args) },
    $primary: () => ({
      recipient: { findFirst: async (...args: unknown[]) => await primaryRecipientFindFirst(...args) },
    }),
  },
}));

vi.mock('@documenso/email/templates/document-invite', () => ({ DocumentInviteEmailTemplate: () => null }));
vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: async () => ({
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    _: (message: unknown) =>
      typeof message === 'string' ? message : ((message as { message?: string })?.message ?? 'x'),
  }),
}));
vi.mock('../email/get-email-context', () => ({
  getEmailContext: async () => ({
    branding: {},
    emailLanguage: 'en',
    settings: { includeSenderDetails: false },
    organisationType: 'PERSONAL',
    senderEmail: { name: 'Documenso', address: 'noreply@example.com' },
    replyToEmail: undefined,
    organisationId: 'organisation_1',
    claims: {},
    emailsDisabled: false,
    emailTransport: { sendMail },
  }),
}));
vi.mock('../email/build-envelope-email-headers', () => ({ buildEnvelopeEmailHeaders: () => ({}) }));
vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: async () => ({ envelopeWhereInput: { id: 'envelope_1' } }),
}));
vi.mock('../pdf/normalize-pdf', () => ({ assertLegacyEnvelopeAcceptsPdf: async () => {} }));
vi.mock('../rate-limit/assert-organisation-rates-and-limits', () => ({
  assertOrganisationRatesAndLimits: async () => {},
}));
vi.mock('../recipient/update-recipient-next-reminder', () => ({ updateRecipientNextReminder: async () => {} }));
vi.mock('../user/assert-user-not-disabled', () => ({ assertUserNotDisabled: () => {} }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: async () => {} }));
vi.mock('../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: (envelope: unknown) => envelope,
  ZWebhookDocumentSchema: { parse: (value: unknown) => value },
}));
vi.mock('../../universal/upload/get-file.server', () => ({ getFileServerSide: async () => new Uint8Array() }));
vi.mock('../../utils/render-email-with-i18n', () => ({ renderEmailWithI18N: async () => '<p>reminder</p>' }));

const { resendDocument } = await import('./resend-document');

const resend = async () =>
  await resendDocument({
    id: { type: 'documentId', id: 11 },
    userId: 1,
    recipients: [41],
    teamId: 7,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    requestMetadata: { auth: null, requestMetadata: {} } as never,
  }).then(
    () => ({ threw: false }),
    () => ({ threw: true }),
  );

describe('resend-document replica lag (C40)', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    replicaRecipientFindFirst.mockReset();
    primaryRecipientFindFirst.mockReset();
    recipientUpdateMany.mockReset();
    auditCreate.mockReset();
  });

  it('mails nobody when the replica shows no rejection and the primary has a REJECTED recipient', async () => {
    replicaRecipientFindFirst.mockResolvedValue(null);
    primaryRecipientFindFirst.mockResolvedValue({ id: 99 });

    await resend();

    expect(sendMail).not.toHaveBeenCalled();
    expect(recipientUpdateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('mails the reminder when no recipient has rejected', async () => {
    replicaRecipientFindFirst.mockResolvedValue(null);
    primaryRecipientFindFirst.mockResolvedValue(null);

    const outcome = await resend();

    expect(outcome.threw).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
