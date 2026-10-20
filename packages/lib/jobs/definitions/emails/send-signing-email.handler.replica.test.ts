import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobRunIO } from '../../client/_internal/job';

/**
 * C40, the signing email handler (C27, C32; C20 when the recipient read is stale). The exported prisma client reads
 * from replicas when NEXT_PRIVATE_DATABASE_REPLICA_URLS is set. A rejection committed on the primary can be missing
 * from the replica, and the real `hasEnvelopeRejection` helper is used here so the test follows its read.
 *
 * Failure modes this file pins:
 *  1. Replica shows no rejection, the primary has a REJECTED recipient: no invitation may be mailed. The handler asks
 *     twice, once up front and once just before the send; either may be fooled by lag, so neither may mail.
 *  2. The recipient's own row is stale on the replica (NOT_SIGNED while the primary says REJECTED): the envelope-wide
 *     check must still stop the mail.
 *  3. No rejection anywhere: the invitation is mailed, so the harness is proven able to send and a fix cannot pass by
 *     always suppressing.
 *  4. A suppressed invitation records nothing: no SENT mark and no EMAIL_SENT audit row.
 */

const sendMail = vi.fn();
const replicaRecipientFindFirst = vi.fn();
const primaryRecipientFindFirst = vi.fn();
const recipientUpdate = vi.fn();
const auditCreate = vi.fn();

const envelopeRow = () => ({
  id: 'envelope_1',
  teamId: 7,
  title: 'Contract',
  status: 'PENDING',
  source: 'DOCUMENT',
  internalVersion: 2,
  documentMeta: { subject: '', message: '' },
  envelopeItems: [],
  user: { disabled: false },
  team: { teamEmail: null, name: 'Team' },
});

const recipientRow = () => ({
  id: 41,
  email: 'counterparty@example.com',
  name: 'Counterparty',
  role: 'SIGNER',
  token: 'token-41',
  signingStatus: 'NOT_SIGNED',
});

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirstOrThrow: async () => ({ id: 1, email: 'owner@example.com', name: 'Owner' }) },
    envelope: { findFirstOrThrow: async () => envelopeRow() },
    recipient: {
      findFirstOrThrow: async () => recipientRow(),
      findFirst: async (...args: unknown[]) => await replicaRecipientFindFirst(...args),
      update: async (...args: unknown[]) => await recipientUpdate(...args),
    },
    documentAuditLog: { create: async (...args: unknown[]) => await auditCreate(...args) },
    $primary: () => ({
      recipient: { findFirst: async (...args: unknown[]) => await primaryRecipientFindFirst(...args) },
    }),
  },
}));

vi.mock('@documenso/email/templates/document-invite', () => ({ default: () => null }));
vi.mock('../../../client-only/providers/i18n-server', () => ({
  getI18nInstance: async () => ({
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    _: (message: unknown) =>
      typeof message === 'string' ? message : ((message as { message?: string })?.message ?? 'x'),
  }),
}));
vi.mock('../../../server-only/email/get-email-context', () => ({
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
vi.mock('../../../server-only/email/build-envelope-email-headers', () => ({ buildEnvelopeEmailHeaders: () => ({}) }));
vi.mock('../../../server-only/pdf/normalize-pdf', () => ({ assertLegacyEnvelopeAcceptsPdf: async () => {} }));
vi.mock('../../../server-only/rate-limit/assert-organisation-rates-and-limits', () => ({
  assertOrganisationRatesAndLimits: async () => {},
}));
vi.mock('../../../server-only/recipient/update-recipient-next-reminder', () => ({
  updateRecipientNextReminder: async () => {},
}));
vi.mock('../../../universal/upload/get-file.server', () => ({ getFileServerSide: async () => new Uint8Array() }));
vi.mock('../../../utils/render-email-with-i18n', () => ({ renderEmailWithI18N: async () => '<p>invite</p>' }));

const { run } = await import('./send-signing-email.handler');

const createIo = () => {
  const io: JobRunIO = {
    runTask: async (_cacheKey, callback) => await callback(),
    triggerJob: async () => undefined,
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn(), warn: vi.fn() },
    wait: async () => {},
  };

  return io;
};

const invite = async () => await run({ payload: { userId: 1, documentId: 11, recipientId: 41 }, io: createIo() });

describe('send-signing-email replica lag (C40)', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    replicaRecipientFindFirst.mockReset();
    primaryRecipientFindFirst.mockReset();
    recipientUpdate.mockReset();
    auditCreate.mockReset();
  });

  it('mails nobody when the replica shows no rejection and the primary has a REJECTED recipient', async () => {
    replicaRecipientFindFirst.mockResolvedValue(null);
    primaryRecipientFindFirst.mockResolvedValue({ id: 99 });

    await invite();

    expect(sendMail).not.toHaveBeenCalled();
    expect(recipientUpdate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('mails the invitation when no recipient has rejected', async () => {
    replicaRecipientFindFirst.mockResolvedValue(null);
    primaryRecipientFindFirst.mockResolvedValue(null);

    await invite();

    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
