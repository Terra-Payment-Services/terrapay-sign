import { describe, expect, it } from 'vitest';

import { getDocumentDataUrl, getEnvelopeItemPdfUrl } from './envelope-download';

const envelopeItem = { id: 'item_1', envelopeId: 'envelope_1' };

describe('file URLs', () => {
  it('carry no query string for the session routes', () => {
    const urls = [
      getDocumentDataUrl({
        envelopeId: 'envelope_1',
        envelopeItemId: 'item_1',
        documentDataId: 'data_1',
        token: undefined,
        version: 'current',
      }),
      getEnvelopeItemPdfUrl({ type: 'view', envelopeItem, token: undefined }),
      getEnvelopeItemPdfUrl({ type: 'download', envelopeItem, token: undefined, version: 'signed' }),
    ];

    for (const url of urls) {
      expect(new URL(url).search).toBe('');
    }
  });

  it('ignore a presign token passed by an untyped caller', () => {
    const url = getDocumentDataUrl({
      envelopeId: 'envelope_1',
      envelopeItemId: 'item_1',
      documentDataId: 'data_1',
      token: undefined,
      version: 'current',
      ...{ presignToken: 'secret-presign-token' },
    });

    expect(url).not.toContain('secret-presign-token');
  });
});
