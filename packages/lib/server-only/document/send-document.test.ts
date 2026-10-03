import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Remote signing through a trust service provider has been removed, so only an
 * SES envelope can be signed and sealed. Sending an AES or QES envelope would
 * put it in front of recipients who could never complete it, so the send step
 * refuses it before anything is written or queued.
 */

const envelopeFindFirst = vi.fn();
const writes = vi.fn();
const triggerJob = vi.fn();
const loggerError = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: async (...args: unknown[]) => await envelopeFindFirst(...args),
      findFirstOrThrow: async (...args: unknown[]) => await writes('envelope.findFirstOrThrow', ...args),
      update: async (...args: unknown[]) => await writes('envelope.update', ...args),
    },
    documentMeta: {
      update: async (...args: unknown[]) => await writes('documentMeta.update', ...args),
    },
    $transaction: async (...args: unknown[]) => await writes('$transaction', ...args),
  },
}));

vi.mock('../user/assert-user-not-disabled', () => ({
  assertUserNotDisabledById: async () => {},
}));

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: async () => ({ envelopeWhereInput: { id: 'envelope_abc123' } }),
}));

vi.mock('../../jobs/client', () => ({
  jobs: {
    triggerJob: async (...args: unknown[]) => await triggerJob(...args),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args), info: () => {}, warn: () => {} },
}));

const { sendDocument } = await import('./send-document');

const envelope = (signatureLevel: string) => ({
  id: 'envelope_abc123',
  secondaryId: 'document_7',
  status: 'DRAFT',
  signatureLevel,
  internalVersion: 2,
  formValues: null,
  authOptions: null,
  documentMeta: { id: 'meta_1', signingOrder: 'PARALLEL' },
  recipients: [{ id: 1, email: 'a@example.com', name: 'A', role: 'SIGNER', signingStatus: 'NOT_SIGNED' }],
  fields: [],
  envelopeItems: [{ id: 'item_1', documentData: { id: 'data_1', type: 'BYTES_64', data: '', initialData: '' } }],
  team: { organisation: { organisationClaim: { recipientCount: 0 } } },
});

describe('sendDocument', () => {
  beforeEach(() => {
    envelopeFindFirst.mockReset();
    writes.mockReset();
    triggerJob.mockReset();
    loggerError.mockReset();
  });

  it('refuses an envelope that is not SES before writing or queueing anything', async () => {
    envelopeFindFirst.mockResolvedValue(envelope('AES'));

    await expect(
      sendDocument({
        id: { type: 'envelopeId', id: 'envelope_abc123' },
        userId: 1,
        teamId: 1,
        requestMetadata: { requestMetadata: {}, source: 'app', auth: null },
      }),
    ).rejects.toMatchObject({ code: 'CSC_INSTANCE_MODE_MISMATCH' });

    expect(writes).not.toHaveBeenCalled();
    expect(triggerJob).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: 'envelope_abc123' }));
  });

  it.each([
    'recipient.2@placeholder.invalid',
    'recipient.2@documenso.com',
  ])('refuses an envelope with a placeholder recipient (%s) before writing or queueing anything', async (email) => {
    const withPlaceholder = envelope('SES');
    withPlaceholder.recipients.push({ id: 2, email, name: 'Recipient 2', role: 'CC', signingStatus: 'NOT_SIGNED' });
    envelopeFindFirst.mockResolvedValue(withPlaceholder);

    await expect(
      sendDocument({
        id: { type: 'envelopeId', id: 'envelope_abc123' },
        userId: 1,
        teamId: 1,
        requestMetadata: { requestMetadata: {}, source: 'app', auth: null },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(writes).not.toHaveBeenCalled();
    expect(triggerJob).not.toHaveBeenCalled();
  });
});
