import { DocumentStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { SignatureLevel } from '../../types/signature-level';

const mocks = vi.hoisted(() => ({
  fieldFindFirst: vi.fn(),
  envelopeFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    field: { findFirst: mocks.fieldFindFirst },
    envelope: { findUnique: mocks.envelopeFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: async () => ({ envelopeWhereInput: { id: 'envelope_1' } }),
}));

import { deleteDocumentField } from './delete-document-field';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  vi.clearAllMocks();
  unhandled.length = 0;

  mocks.fieldFindFirst.mockResolvedValue({ id: 5, envelopeId: 'envelope_1', recipientId: 9 });
  mocks.envelopeFindUnique.mockResolvedValue({
    id: 'envelope_1',
    status: DocumentStatus.PENDING,
    signatureLevel: SignatureLevel.QES,
    completedAt: null,
    recipients: [{ id: 9, fields: [], signingStatus: 'NOT_SIGNED', role: 'SIGNER' }],
  });
});

describe('deleteDocumentField on a locked envelope', () => {
  it('refuses before opening a transaction, and leaves no rejection unhandled', async () => {
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(
        deleteDocumentField({ userId: 1, teamId: 1, fieldId: 5, requestMetadata: {} as never }),
      ).rejects.toMatchObject({ code: AppErrorCode.ENVELOPE_TSP_LOCKED });

      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
