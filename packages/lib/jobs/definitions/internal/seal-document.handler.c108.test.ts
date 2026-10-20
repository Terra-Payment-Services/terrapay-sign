import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobRunIO } from '../../client/_internal/job';

/**
 * C108. The rejection and cancellation emails go out exactly once per rejection, on the seal that first moves the
 * envelope out of PENDING: the first attempt, or a sweep recovery (`isResealing: true` on an envelope whose pre-seal
 * status is not completed). A reseal of an envelope already REJECTED or COMPLETED sends neither. A rejected envelope
 * never queues the completion email. Completion emails for a non-rejected envelope are unchanged. A seal that stops
 * sends none of these.
 *
 * The seal runs end to end here with the database, the PDF work and the job queue faked, and every
 * `jobs.triggerJob` name is recorded. The archive job is left out of the comparison: it is not part of C108.
 */

const envelopeFindFirst = vi.fn();
const triggerJob = vi.fn();
const prepareStoredSignatureImage = vi.fn();

const tx = {
  envelope: { updateMany: vi.fn(async () => ({ count: 1 })) },
  envelopeItem: { updateMany: vi.fn(async () => ({ count: 1 })) },
  documentData: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  documentAuditLog: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
  $queryRaw: vi.fn(async () => []),
};

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: async (...args: unknown[]) => await envelopeFindFirst(...args),
      update: vi.fn(async () => ({})),
    },
    recipient: { updateMany: vi.fn(async () => ({ count: 0 })) },
    documentData: { deleteMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 0) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => await callback(tx),
  },
}));

const fakePdf = () => ({
  flattenAll: vi.fn(),
  upgradeVersion: vi.fn(),
  isEncrypted: false,
  save: async () => new Uint8Array([1]),
});

vi.mock('@documenso/signing', () => ({ signPdf: async () => new Uint8Array([1]) }));
vi.mock('@libpdf/core', () => ({ PDF: { load: async () => fakePdf() } }));
vi.mock('@cantoo/pdf-lib', () => ({ PDFDocument: {} }));
vi.mock('@documenso/lib/server-only/pdf/add-rejection-stamp-to-pdf', () => ({ addRejectionStampToPdf: vi.fn() }));
vi.mock('@documenso/lib/server-only/pdf/existing-signatures', () => ({
  inspectExistingSignatures: () => ({ signedFieldCount: 0, canPreserve: true }),
}));
vi.mock('@documenso/lib/server-only/pdf/generate-audit-log-pdf', () => ({ generateAuditLogPdf: vi.fn() }));
vi.mock('@documenso/lib/server-only/pdf/generate-certificate-pdf', () => ({ generateCertificatePdf: vi.fn() }));
vi.mock('@documenso/lib/server-only/pdf/get-page-size', () => ({ getLastPageDimensions: vi.fn() }));
vi.mock('../../../server-only/htmltopdf/get-audit-logs-pdf', () => ({ getAuditLogsPdf: vi.fn() }));
vi.mock('../../../server-only/htmltopdf/get-certificate-pdf', () => ({ getCertificatePdf: vi.fn() }));
vi.mock('../../../server-only/pdf/insert-field-in-pdf-v1', () => ({ insertFieldInPDFV1: vi.fn() }));
vi.mock('../../../server-only/pdf/insert-field-in-pdf-v2', () => ({ insertFieldInPDFV2: vi.fn() }));
vi.mock('../../../server-only/pdf/legacy-insert-field-in-pdf', () => ({ legacy_insertFieldInPDF: vi.fn() }));
vi.mock('../../../server-only/signature/prepare-stored-signature-image', () => ({
  prepareStoredSignatureImage: async (...args: unknown[]) => await prepareStoredSignatureImage(...args),
}));
vi.mock('../../../server-only/team/get-team-settings', () => ({
  getTeamSettings: async () => ({ includeSigningCertificate: false, includeAuditLog: false }),
}));
vi.mock('../../../server-only/webhooks/trigger/trigger-webhook', () => ({ triggerTeamWebhook: vi.fn() }));
vi.mock('../../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: (envelope: unknown) => envelope,
  ZWebhookDocumentSchema: { parse: (value: unknown) => value },
}));
vi.mock('../../../universal/upload/delete-file', () => ({ deleteFile: vi.fn() }));
vi.mock('../../../universal/upload/get-file.server', () => ({ getFileServerSide: async () => new Uint8Array([1]) }));
vi.mock('../../../universal/upload/put-file.server', () => ({
  putPdfFileServerSide: async () => ({ documentData: { id: 'dd_new', type: 'BYTES_64', data: 'x' } }),
}));
vi.mock('../../client', () => ({
  jobs: { triggerJob: async (...args: unknown[]) => await triggerJob(...args) },
}));

const { run } = await import('./seal-document.handler');

type Status = 'PENDING' | 'COMPLETED' | 'REJECTED';

const recipients = (rejected: boolean) => [
  {
    id: 1,
    role: 'SIGNER',
    email: 'a@example.com',
    name: 'A',
    signingStatus: rejected ? 'REJECTED' : 'SIGNED',
    rejectionReason: rejected ? 'no thanks' : null,
  },
];

const envelope = (status: Status, rejected: boolean, withBadImage = false) => ({
  id: 'envelope_1',
  teamId: 7,
  status,
  signatureLevel: 'SES',
  internalVersion: 2,
  qrToken: 'qr_1',
  user: { name: 'Owner', email: 'o@example.com' },
  documentMeta: { language: 'en' },
  recipients: recipients(rejected),
  fields: [],
  envelopeItems: [
    {
      id: 'item_1',
      title: 'doc.pdf',
      documentData: { id: 'dd_old', data: 'sealed', initialData: 'initial' },
      field: withBadImage
        ? [{ id: 5, secondaryId: 'field_5', recipientId: 1, signature: { signatureImageAsBase64: 'bad' } }]
        : [],
    },
  ],
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

type Scenario = {
  isResealing: boolean;
  preStatus: Status;
  rejected: boolean;
  sendEmail?: boolean;
  badImage?: boolean;
};

/** Runs the seal once and returns the `send.*` job names queued, in order. */
const seal = async ({ isResealing, preStatus, rejected, sendEmail, badImage = false }: Scenario) => {
  const postStatus: Status = rejected ? 'REJECTED' : 'COMPLETED';

  envelopeFindFirst.mockReset();
  envelopeFindFirst
    .mockResolvedValueOnce(envelope(preStatus, rejected, badImage))
    .mockResolvedValue(envelope(postStatus, rejected));

  await run({
    payload: { documentId: 11, isResealing, ...(sendEmail === undefined ? {} : { sendEmail }) },
    io: createIo(),
  });

  return triggerJob.mock.calls
    .map(([job]) => (job as { name: string }).name)
    .filter((name) => name.startsWith('send.'))
    .sort();
};

const REJECTION_EMAILS = ['send.document.cancelled.emails', 'send.signing.rejected.emails'];
const COMPLETED = ['send.document.completed.emails'];

describe('seal-document rejection and completion emails (C108)', () => {
  beforeEach(() => {
    triggerJob.mockReset();
    triggerJob.mockResolvedValue(undefined);
    prepareStoredSignatureImage.mockReset();
    prepareStoredSignatureImage.mockResolvedValue('prepared');
  });

  it('first seal of a PENDING envelope with a rejected recipient queues the rejection and cancellation emails once', async () => {
    expect(await seal({ isResealing: false, preStatus: 'PENDING', rejected: true })).toEqual(REJECTION_EMAILS);
  });

  it('recovery seal (isResealing, pre-seal PENDING) of a rejected envelope queues the same emails', async () => {
    expect(await seal({ isResealing: true, preStatus: 'PENDING', rejected: true })).toEqual(REJECTION_EMAILS);
  });

  it('reseal of an envelope already REJECTED queues no rejection email and no completion email', async () => {
    expect(await seal({ isResealing: true, preStatus: 'REJECTED', rejected: true })).toEqual([]);
  });

  it('first seal of a non-rejected envelope queues the completion email', async () => {
    expect(await seal({ isResealing: false, preStatus: 'PENDING', rejected: false })).toEqual(COMPLETED);
  });

  it('recovery seal of a non-rejected PENDING envelope queues the completion email', async () => {
    expect(await seal({ isResealing: true, preStatus: 'PENDING', rejected: false })).toEqual(COMPLETED);
  });

  it('reseal of a COMPLETED envelope queues no completion email', async () => {
    expect(await seal({ isResealing: true, preStatus: 'COMPLETED', rejected: false })).toEqual([]);
  });

  it('sendEmail false suppresses the completion email on a first seal and on a recovery seal', async () => {
    expect(await seal({ isResealing: false, preStatus: 'PENDING', rejected: false, sendEmail: false })).toEqual([]);
    triggerJob.mockClear();
    expect(await seal({ isResealing: true, preStatus: 'PENDING', rejected: false, sendEmail: false })).toEqual([]);
  });

  it('a seal that stops on an unreadable stored signature image queues none of these, rejected or not', async () => {
    prepareStoredSignatureImage.mockResolvedValue(null);

    expect(await seal({ isResealing: false, preStatus: 'PENDING', rejected: true, badImage: true })).toEqual([]);
    expect(await seal({ isResealing: true, preStatus: 'PENDING', rejected: true, badImage: true })).toEqual([]);
    expect(await seal({ isResealing: false, preStatus: 'PENDING', rejected: false, badImage: true })).toEqual([]);
  });
});
