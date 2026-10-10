import { afterEach, describe, expect, it, vi } from 'vitest';

import { putPdfFile } from './put-file';

/**
 * The browser side of `/api/files/upload-pdf`. Its refusals carry an AppError
 * code the upload toasts are keyed on, so the code has to survive the trip.
 * `fetch` is the I/O boundary and is replaced with fixed responses.
 */
const file = {
  name: 'contract.pdf',
  type: 'application/pdf',
  arrayBuffer: async () => await Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer),
};

const respondWith = (response: Response) => {
  vi.stubGlobal('fetch', async () => await Promise.resolve(response));
};

describe('putPdfFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes on the refusal the server named, so the matching toast shows', async () => {
    respondWith(
      Response.json(
        { code: 'PASSWORD_PROTECTED_DOCUMENT', message: 'The document needs a password to open.' },
        { status: 400 },
      ),
    );

    await expect(putPdfFile(file)).rejects.toMatchObject({ code: 'PASSWORD_PROTECTED_DOCUMENT' });
  });

  it('reports a generic upload failure when the server names none', async () => {
    respondWith(Response.json({ error: 'Upload failed' }, { status: 500 }));

    await expect(putPdfFile(file)).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });
});
