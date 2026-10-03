import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobRunIO } from '../../client/_internal/job';

/**
 * Reminders write EMAIL_SENT rows with emailType REMINDER, and those rows are not
 * filtered out of the signing certificate. An in-person signer has no email address,
 * so a reminder for them is a mail to nowhere. If the transport tolerates an empty
 * address the certificate ends up asserting a reminder that nobody received.
 */

const sendMail = vi.fn();

const recipientUpdateMany = vi.fn();
const recipientFindFirst = vi.fn();

type AuditRow = { envelopeId: string; type: string; data: Record<string, unknown> };

const auditLog: AuditRow[] = [];

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: {
      updateMany: async (...args: unknown[]) => await recipientUpdateMany(...args),
      findFirst: async (...args: unknown[]) => await recipientFindFirst(...args),
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

vi.mock('@documenso/email/templates/document-reminder', () => ({
  default: () => null,
}));

vi.mock('../../../server-only/email/get-email-context', () => ({
  getEmailContext: async () => ({
    branding: {},
    emailLanguage: 'en',
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

vi.mock('../../../server-only/webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: async () => {},
  triggerTeamWebhook: async () => {},
}));

vi.mock('../../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: () => ({}),
  ZWebhookDocumentSchema: { parse: (value: unknown) => value },
}));

vi.mock('../../../client-only/providers/i18n-server', () => ({
  getI18nInstance: async () => ({ _: () => 'Reminder: Please sign this document' }),
}));

vi.mock('../../../utils/render-email-with-i18n', () => ({
  renderEmailWithI18N: async () => '<p>rendered</p>',
}));

const { run } = await import('./process-signing-reminder.handler');

const envelope = () => ({
  id: 'envelope_abc123',
  title: 'Master Services Agreement',
  teamId: 1,
  userId: 9,
  documentMeta: {
    language: 'en',
    message: null,
    subject: null,
    emailSettings: null,
    distributionMethod: 'EMAIL',
  },
  user: { id: 9, email: 'owner@example.com', name: 'Owner', disabled: false },
  recipients: [],
  team: { name: 'Acme' },
});

const recipient = (email: string) => ({
  id: 41,
  email,
  name: 'सुरेश कुमार',
  role: 'SIGNER',
  token: 'token-41',
  sentAt: new Date('2026-09-01T00:00:00Z'),
  envelope: envelope(),
});

const createIo = () => {
  const io: JobRunIO = {
    runTask: async (_cacheKey, callback) => await callback(),
    triggerJob: async () => undefined,
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn(), warn: vi.fn() },
    wait: async () => {},
  };

  return io;
};

const emailSentRows = () => auditLog.filter((row) => row.type === 'EMAIL_SENT');

describe('process-signing-reminder', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    recipientUpdateMany.mockReset();
    recipientUpdateMany.mockResolvedValue({ count: 1 });
    recipientFindFirst.mockReset();
    auditLog.length = 0;
  });

  it('reminds a recipient who has an email address', async () => {
    recipientFindFirst.mockResolvedValue(recipient('counterparty@example.com'));

    await run({ payload: { recipientId: 41 }, io: createIo() });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(emailSentRows()).toHaveLength(1);
  });

  it('sends nothing and writes nothing for an in-person signer with no email address', async () => {
    recipientFindFirst.mockResolvedValue(recipient(''));

    await run({ payload: { recipientId: 41 }, io: createIo() });

    expect(sendMail).not.toHaveBeenCalled();
    expect(emailSentRows()).toEqual([]);
  });
});
