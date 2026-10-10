import { describe, expect, it, vi } from 'vitest';

import { ownerProtectedSignedPdf, userProtectedPdf } from '../../server-only/pdf/__fixtures__/protected-pdfs';
import { putPdfFileServerSide } from './put-file.server';

/**
 * Sealing stores its output through `putPdfFileServerSide`, so an
 * owner-protected document that was accepted at upload has to be accepted here
 * too, or it can be signed by everyone and then never sealed.
 *
 * The database write is the only I/O, and is replaced by an in-memory record.
 */
vi.mock('../../server-only/document-data/create-document-data', () => ({
  createDocumentData: async (options: { type: string; data: string }) =>
    await Promise.resolve({ id: 'stored', ...options }),
}));

const asFile = (bytes: Buffer) => ({
  name: 'contract.pdf',
  type: 'application/pdf',
  arrayBuffer: async () => await Promise.resolve(new Uint8Array(bytes).buffer),
});

const owner = { userId: 1, teamId: 1 };

describe('putPdfFileServerSide', () => {
  it('stores a signed PDF that opens without a password but carries owner restrictions', async () => {
    const { documentData, filePageCount } = await putPdfFileServerSide(asFile(await ownerProtectedSignedPdf()), {
      owner,
    });

    expect(documentData.id).toBe('stored');
    expect(filePageCount).toBe(1);
  });

  it('refuses a PDF that needs a password to open', async () => {
    await expect(putPdfFileServerSide(asFile(await userProtectedPdf()), { owner })).rejects.toMatchObject({
      code: 'PASSWORD_PROTECTED_DOCUMENT',
    });
  });
});
