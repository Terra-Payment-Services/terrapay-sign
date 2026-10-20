import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobRunIO } from '../../client/_internal/job';

/**
 * C39. The exported prisma client reads from replicas when NEXT_PRIVATE_DATABASE_REPLICA_URLS is set, so a null from
 * `envelope.findFirst` can be replica lag rather than absence. The seal job reads the envelope twice: at the start of
 * the 'seal-document' task and again after the commit, before the webhook, email and archive steps.
 *
 * Failure modes this file pins:
 *  1. First read misses on the replica, the envelope is on the primary: the job must not end as an aborted seal that
 *     the job system records as completed, which loses the seal for good (the sweep skips soft-deleted envelopes).
 *  2. Second read misses on the replica, the envelope is on the primary: the job must not skip the webhook, emails
 *     and archive steps while reporting success.
 *  3. Either miss is also on the primary: the envelope is truly gone and the job must still end quietly, without
 *     throwing, so that a purged envelope does not retry for ever.
 *  4. The fix must not trade one silent loss for another: "handled" means the job threw (so it retries) or went on to
 *     announce the envelope after confirming it on the primary.
 *
 * The test drives only the early return for a COMPLETED envelope, so no PDF work is involved. The primary is exposed
 * as `prisma.$primary()`, the read-replicas extension's own accessor.
 */

const replicaFindFirst = vi.fn();
const primaryFindFirst = vi.fn();
const triggerTeamWebhook = vi.fn();
const triggerJob = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: { findFirst: async (...args: unknown[]) => await replicaFindFirst(...args) },
    $primary: () => ({ envelope: { findFirst: async (...args: unknown[]) => await primaryFindFirst(...args) } }),
  },
}));

vi.mock('@documenso/signing', () => ({ signPdf: vi.fn() }));
vi.mock('@libpdf/core', () => ({ PDF: {} }));
vi.mock('@cantoo/pdf-lib', () => ({ PDFDocument: {} }));
vi.mock('@documenso/lib/server-only/pdf/add-rejection-stamp-to-pdf', () => ({ addRejectionStampToPdf: vi.fn() }));
vi.mock('@documenso/lib/server-only/pdf/existing-signatures', () => ({ inspectExistingSignatures: vi.fn() }));
vi.mock('@documenso/lib/server-only/pdf/generate-audit-log-pdf', () => ({ generateAuditLogPdf: vi.fn() }));
vi.mock('@documenso/lib/server-only/pdf/generate-certificate-pdf', () => ({ generateCertificatePdf: vi.fn() }));
vi.mock('@documenso/lib/server-only/pdf/get-page-size', () => ({ getLastPageDimensions: vi.fn() }));
vi.mock('../../../server-only/htmltopdf/get-audit-logs-pdf', () => ({ getAuditLogsPdf: vi.fn() }));
vi.mock('../../../server-only/htmltopdf/get-certificate-pdf', () => ({ getCertificatePdf: vi.fn() }));
vi.mock('../../../server-only/pdf/insert-field-in-pdf-v1', () => ({ insertFieldInPDFV1: vi.fn() }));
vi.mock('../../../server-only/pdf/insert-field-in-pdf-v2', () => ({ insertFieldInPDFV2: vi.fn() }));
vi.mock('../../../server-only/pdf/legacy-insert-field-in-pdf', () => ({ legacy_insertFieldInPDF: vi.fn() }));
vi.mock('../../../server-only/team/get-team-settings', () => ({ getTeamSettings: vi.fn() }));
vi.mock('../../../server-only/webhooks/trigger/trigger-webhook', () => ({
  triggerTeamWebhook: async (...args: unknown[]) => await triggerTeamWebhook(...args),
}));
vi.mock('../../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: (envelope: unknown) => envelope,
  ZWebhookDocumentSchema: { parse: (value: unknown) => value },
}));
vi.mock('../../../universal/upload/delete-file', () => ({ deleteFile: vi.fn() }));
vi.mock('../../../universal/upload/get-file.server', () => ({ getFileServerSide: vi.fn() }));
vi.mock('../../../universal/upload/put-file.server', () => ({ putPdfFileServerSide: vi.fn() }));
vi.mock('../../client', () => ({
  jobs: { triggerJob: async (...args: unknown[]) => await triggerJob(...args) },
}));

const { run } = await import('./seal-document.handler');

const completedEnvelope = () => ({
  id: 'envelope_1',
  teamId: 7,
  status: 'COMPLETED',
  envelopeItems: [{ id: 'item_1' }],
  recipients: [],
  documentMeta: {},
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

/** Replica answers are given per call: the first read, then the second. */
const replicaAnswers = (...answers: unknown[]) => {
  answers.forEach((answer) => replicaFindFirst.mockResolvedValueOnce(answer));
  replicaFindFirst.mockResolvedValue(null);
};

const attempt = async () =>
  await run({ payload: { documentId: 11 }, io: createIo() }).then(
    () => ({ threw: false }),
    () => ({ threw: true }),
  );

/** Handled means the job threw so the job system retries, or it confirmed the envelope on the primary and went on. */
const expectNotQuiet = (outcome: { threw: boolean }) => {
  expect(outcome.threw || triggerTeamWebhook.mock.calls.length > 0, 'the job neither threw nor announced').toBe(true);
};

describe('seal-document replica lag (C39)', () => {
  beforeEach(() => {
    replicaFindFirst.mockReset();
    primaryFindFirst.mockReset();
    triggerTeamWebhook.mockReset();
    triggerTeamWebhook.mockResolvedValue(undefined);
    triggerJob.mockReset();
    triggerJob.mockResolvedValue(undefined);
  });

  it('does not complete quietly when the first read misses on the replica and the envelope is on the primary', async () => {
    replicaAnswers(null, completedEnvelope());
    primaryFindFirst.mockResolvedValue(completedEnvelope());

    expectNotQuiet(await attempt());
  });

  it('does not complete quietly when the second read misses on the replica and the envelope is on the primary', async () => {
    replicaAnswers(completedEnvelope(), null);
    primaryFindFirst.mockResolvedValue(completedEnvelope());

    expectNotQuiet(await attempt());
  });

  it('returns quietly when the first read misses on the replica and on the primary', async () => {
    replicaAnswers(null);
    primaryFindFirst.mockResolvedValue(null);

    const outcome = await attempt();

    expect(outcome.threw).toBe(false);
    expect(triggerTeamWebhook).not.toHaveBeenCalled();
  });

  it('returns quietly when the second read misses on the replica and on the primary', async () => {
    replicaAnswers(completedEnvelope(), null);
    primaryFindFirst.mockResolvedValue(null);

    const outcome = await attempt();

    expect(outcome.threw).toBe(false);
    expect(triggerTeamWebhook).not.toHaveBeenCalled();
  });
});
