import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobRunIO } from '../../client/_internal/job';

/**
 * The EMAIL_SENT audit rows this handler writes are read back by
 * `getDocumentCertificateAuditLogs` and printed on the signing certificate, which
 * is the evidence TerraPay produces when a counterparty disputes a signature.
 *
 * An in-person signer is allowed to have no email address. The schema permits it
 * and nothing is mailed to them. A row asserting an email was sent to such a
 * recipient is a statement on an evidence document that did not happen, so these
 * tests hold the audit log to what the transport was asked to do.
 *
 * The heavy dependencies are stubbed because none of them is under test. The
 * question is narrow: for a given recipient, was the transport called, and does
 * the audit log agree with the answer.
 */

const sendMail = vi.fn();

const userFindFirstOrThrow = vi.fn();
const envelopeFindFirstOrThrow = vi.fn();
const recipientFindFirstOrThrow = vi.fn();
const recipientUpdate = vi.fn();

type AuditRow = { envelopeId: string; type: string; data: Record<string, unknown> };

const auditLog: AuditRow[] = [];

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: {
      findFirstOrThrow: async (...args: unknown[]) => await userFindFirstOrThrow(...args),
    },
    envelope: {
      findFirstOrThrow: async (...args: unknown[]) => await envelopeFindFirstOrThrow(...args),
    },
    recipient: {
      findFirstOrThrow: async (...args: unknown[]) => await recipientFindFirstOrThrow(...args),
      update: async (...args: unknown[]) => await recipientUpdate(...args),
    },
    documentAuditLog: {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      create: async ({ data }: { data: AuditRow }) => {
        auditLog.push(data);

        return {};
      },
    },
  },
}));

vi.mock('@documenso/email/templates/document-invite', () => ({
  default: () => null,
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

vi.mock('../../../server-only/rate-limit/assert-organisation-rates-and-limits', () => ({
  assertOrganisationRatesAndLimits: async () => {},
}));

vi.mock('../../../server-only/recipient/update-recipient-next-reminder', () => ({
  updateRecipientNextReminder: async () => {},
}));

vi.mock('../../../client-only/providers/i18n-server', () => ({
  getI18nInstance: async () => ({ _: () => 'Please sign this document' }),
}));

vi.mock('../../../utils/render-email-with-i18n', () => ({
  renderEmailWithI18N: async () => '<p>rendered</p>',
}));

const { run } = await import('./send-signing-email.handler');

const user = { id: 9, email: 'owner@example.com', name: 'Owner' };

const envelope = () => ({
  id: 'envelope_abc123',
  title: 'Master Services Agreement',
  teamId: 1,
  source: 'DOCUMENT',
  documentMeta: { language: 'en', message: null, subject: null, emailSettings: null },
  user: { disabled: false },
  team: { teamEmail: null, name: 'Acme' },
});

const inPersonSigner = {
  id: 41,
  // An in-person signer. The schema allows the empty string and the UI produces it.
  email: '',
  name: 'محمد الفارسي',
  role: 'SIGNER',
  token: 'token-41',
};

const emailedSigner = {
  id: 42,
  email: 'counterparty@example.com',
  name: 'Counterparty',
  role: 'SIGNER',
  token: 'token-42',
};

const createIo = () => {
  const completed = new Set<string>();

  const io: JobRunIO = {
    runTask: async (cacheKey, callback) => {
      if (completed.has(cacheKey)) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        return undefined as never;
      }

      const result = await callback();

      completed.add(cacheKey);

      return result;
    },
    triggerJob: async () => undefined,
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn(), warn: vi.fn() },
    wait: async () => {},
  };

  return io;
};

const emailSentRows = () => auditLog.filter((row) => row.type === 'EMAIL_SENT');

const runFor = async (recipient: Record<string, unknown>) => {
  recipientFindFirstOrThrow.mockResolvedValue(recipient);

  await run({
    payload: {
      userId: user.id,
      documentId: 123,
      recipientId: Number(recipient.id),
      requestMetadata: undefined,
    },
    io: createIo(),
  });
};

describe('send-signing-email', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    userFindFirstOrThrow.mockReset();
    userFindFirstOrThrow.mockResolvedValue(user);
    envelopeFindFirstOrThrow.mockReset();
    envelopeFindFirstOrThrow.mockResolvedValue(envelope());
    recipientFindFirstOrThrow.mockReset();
    recipientUpdate.mockReset();
    recipientUpdate.mockResolvedValue({});
    auditLog.length = 0;
  });

  it('writes an EMAIL_SENT row for a recipient who was mailed', async () => {
    await runFor(emailedSigner);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(emailSentRows()).toHaveLength(1);
    expect(emailSentRows()[0].data.recipientEmail).toBe('counterparty@example.com');
  });

  it('writes no EMAIL_SENT row for an in-person signer with no email address', async () => {
    await runFor(inPersonSigner);

    // Nothing was mailed, so the certificate must not be told anything was.
    expect(sendMail).not.toHaveBeenCalled();
    expect(emailSentRows()).toEqual([]);
  });

  it('still marks the in-person signer as sent so the document can proceed', async () => {
    await runFor(inPersonSigner);

    // The recipient update is what moves the envelope forward. Suppressing the
    // false audit row must not also strand the signer.
    expect(recipientUpdate).toHaveBeenCalledTimes(1);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const call = recipientUpdate.mock.calls[0][0] as {
      where: { id: number };
      data: { sendStatus: string };
    };

    expect(call.where.id).toBe(inPersonSigner.id);
    expect(call.data.sendStatus).toBe('SENT');
  });

  it('never writes an EMAIL_SENT row naming an address the transport was not given', async () => {
    for (const recipient of [inPersonSigner, emailedSigner]) {
      await runFor(recipient);
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const addressesMailed = sendMail.mock.calls.map((call) => (call[0] as { to: { address: string } }).to.address);

    const addressesClaimed = emailSentRows().map((row) => row.data.recipientEmail);

    expect(addressesClaimed.sort()).toEqual(addressesMailed.sort());
  });

  it.each([
    'recipient.1@placeholder.invalid',
    'recipient.1@documenso.com',
  ])('does not mail a placeholder recipient (%s)', async (email) => {
    await runFor({ ...emailedSigner, email });

    expect(sendMail).not.toHaveBeenCalled();
    expect(emailSentRows()).toEqual([]);
  });
});
