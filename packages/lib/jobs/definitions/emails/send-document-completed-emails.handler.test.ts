import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobRunIO } from '../../client/_internal/job';

/**
 * The completion emails are the part of the fan-out a counterparty sees. A
 * second copy of "Signing Complete!" for a contract they signed once reads like
 * the document was signed twice, so this covers what a retry of the job does.
 *
 * The heavy dependencies are stubbed because none of them is what is under
 * test here: the question is which recipients the transport is asked to mail,
 * and how that changes when the job runs again after a failure.
 */

const sendMail = vi.fn();

const findUnique = vi.fn();

type AuditRow = { envelopeId: string; type: string; data: Record<string, unknown> };

type JsonCondition = { data: { path: string[]; equals: unknown } };

/**
 * The audit log, kept as rows rather than as a call count, because the handler
 * now reads it back to decide whether somebody already has their copy. A stub
 * that only counted calls would answer that question with a shrug.
 */
const auditLog: AuditRow[] = [];

const matchesJsonConditions = (row: AuditRow, conditions: JsonCondition[]) =>
  conditions.every((condition) => row.data[condition.data.path[0]] === condition.data.equals);

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findUnique: async (...args: unknown[]) => await findUnique(...args),
    },
    documentAuditLog: {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      create: async ({ data }: { data: AuditRow }) => {
        auditLog.push(data);

        return {};
      },
      findFirst: async ({ where }: { where: AuditRow & { AND: JsonCondition[] } }) =>
        auditLog.find(
          (row) =>
            row.envelopeId === where.envelopeId && row.type === where.type && matchesJsonConditions(row, where.AND),
        ) ?? null,
    },
  },
}));

vi.mock('@documenso/email/templates/document-completed', () => ({
  DocumentCompletedEmailTemplate: () => null,
}));

vi.mock('../../../server-only/email/get-email-context', () => ({
  getEmailContext: async () => ({
    branding: {},
    emailLanguage: 'en',
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

vi.mock('../../../client-only/providers/i18n-server', () => ({
  getI18nInstance: async () => ({ _: () => 'Signing Complete!' }),
}));

vi.mock('../../../utils/render-email-with-i18n', () => ({
  renderEmailWithI18N: async () => '<p>rendered</p>',
}));

vi.mock('../../../universal/upload/get-file.server', () => ({
  getFileServerSide: async () => new Uint8Array(4),
}));

const { run } = await import('./send-document-completed-emails.handler');

const recipient = (id: number, email: string) => ({
  id,
  email,
  name: `Signer ${id}`,
  role: 'SIGNER',
  token: `token-${id}`,
  signingStatus: 'SIGNED',
  sendStatus: 'SENT',
});

const envelope = () => ({
  id: 'envelope_abc123',
  title: 'Master Services Agreement',
  internalVersion: 2,
  source: 'DOCUMENT',
  teamId: 1,
  documentMeta: { language: 'en', message: null, subject: null, emailSettings: null },
  recipients: [recipient(1, 'one@example.com'), recipient(2, 'two@example.com'), recipient(3, 'three@example.com')],
  user: { id: 9, email: 'owner@example.com', name: 'Owner', disabled: false },
  team: { id: 1, url: 'acme' },
  envelopeItems: [
    { id: 'envelope_item_1', title: 'Agreement', documentData: { type: 'S3_PATH', id: 'dd_1', data: '' } },
  ],
});

/**
 * A job runtime with the same task semantics the real providers give: a task
 * that completed once is never run again for this job.
 */
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

const addressesMailed = () =>
  sendMail.mock.calls.map((call) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const options = call[0] as { to: Array<{ address: string }> };

    return options.to[0].address;
  });

describe('send-document-completed-emails', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    findUnique.mockReset();
    findUnique.mockResolvedValue(envelope());
    auditLog.length = 0;
  });

  it('mails every recipient once', async () => {
    await run({ payload: { envelopeId: 'envelope_abc123' }, io: createIo() });

    expect(addressesMailed().sort()).toEqual([
      'one@example.com',
      'owner@example.com',
      'three@example.com',
      'two@example.com',
    ]);
  });

  it('does not mail a recipient again when the job is retried after a failure', async () => {
    const io = createIo();

    let hasFailed = false;

    sendMail.mockImplementation(async (options: { to: Array<{ address: string }> }) => {
      if (options.to[0].address === 'two@example.com' && !hasFailed) {
        hasFailed = true;

        throw new Error('smtp: connection reset');
      }
    });

    await expect(run({ payload: { envelopeId: 'envelope_abc123' }, io })).rejects.toThrow(/connection reset/);

    const firstRun = addressesMailed();

    expect(firstRun).toContain('two@example.com');

    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);

    await run({ payload: { envelopeId: 'envelope_abc123' }, io });

    const secondRun = addressesMailed();

    // Only the recipient the first run failed on is mailed again. Everybody
    // whose email went out stays out of the second round.
    expect(secondRun).toEqual(['two@example.com']);

    for (const address of firstRun.filter((mailed) => mailed !== 'two@example.com')) {
      expect(secondRun).not.toContain(address);
    }
  });

  it('does not mail anybody again when the job is enqueued a second time', async () => {
    // A duplicated enqueue is a new job, and runTask namespaces its markers by
    // job id, so the second run starts with an entirely clean set of them. The
    // audit log is the only thing that remembers across the two.
    await run({ payload: { envelopeId: 'envelope_abc123' }, io: createIo() });

    expect(addressesMailed()).toHaveLength(4);

    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);

    await run({ payload: { envelopeId: 'envelope_abc123' }, io: createIo() });

    expect(addressesMailed()).toEqual([]);
  });

  it('mails the one recipient the audit log has no record of', async () => {
    // The first run fell over after mailing two of the three. A fresh job
    // carries no markers, so what it does is decided entirely by the audit log.
    const io = createIo();

    sendMail.mockImplementation(async (options: { to: Array<{ address: string }> }) => {
      if (options.to[0].address === 'three@example.com') {
        throw new Error('smtp: connection reset');
      }
    });

    await expect(run({ payload: { envelopeId: 'envelope_abc123' }, io })).rejects.toThrow(/connection reset/);

    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);

    await run({ payload: { envelopeId: 'envelope_abc123' }, io: createIo() });

    expect(addressesMailed()).toEqual(['three@example.com']);
  });

  it('tells the owner apart from a recipient carrying the same id', async () => {
    // The owner's audit row holds a user id and a recipient's holds a recipient
    // id, both integers, in the same field. Without the role in the test one
    // would suppress the other and somebody would silently go unmailed.
    findUnique.mockResolvedValue({
      ...envelope(),
      user: { id: 1, email: 'owner@example.com', name: 'Owner', disabled: false },
    });

    await run({ payload: { envelopeId: 'envelope_abc123' }, io: createIo() });

    expect(addressesMailed().sort()).toEqual([
      'one@example.com',
      'owner@example.com',
      'three@example.com',
      'two@example.com',
    ]);
  });
});
