import type { DocumentDataVersion } from '@documenso/lib/types/document';
import type { EnvelopeItem } from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../constants/app';

/**
 * `pending` is only supported when there is no recipient token (team/owner-side downloads
 * via the session-authed file route). The recipient-token route does not accept `pending`.
 */
export type EnvelopeItemPdfUrlOptions =
  | {
      type: 'download';
      envelopeItem: Pick<EnvelopeItem, 'id' | 'envelopeId'>;
      token: string | undefined;
      version: 'original' | 'signed' | 'pending';
    }
  | {
      type: 'view';
      envelopeItem: Pick<EnvelopeItem, 'id' | 'envelopeId'>;
      token: string | undefined;
    };

export const getEnvelopeItemPdfUrl = (options: EnvelopeItemPdfUrlOptions) => {
  const { envelopeItem, token, type } = options;

  const { id, envelopeId } = envelopeItem;

  if (type === 'download') {
    const version = options.version;

    return token
      ? `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/token/${token}/envelopeItem/${id}/download/${version}`
      : `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/envelope/${envelopeId}/envelopeItem/${id}/download/${version}`;
  }

  return token
    ? `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/token/${token}/envelopeItem/${id}`
    : `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/envelope/${envelopeId}/envelopeItem/${id}`;
};

export type DocumentDataUrlOptions = {
  envelopeId: string;
  envelopeItemId: string;
  documentDataId: string;
  token: string | undefined;
  version: DocumentDataVersion;
};

/**
 * The difference between this and `getEnvelopeItemPdfUrl` is that this will
 * hard cache since we add the `documentDataId` to the URL.
 *
 * Since `documentDataId` should change when the document is changed/signed, this is a
 * good way to cache an envelope item by.
 */
export const getDocumentDataUrl = (options: DocumentDataUrlOptions) => {
  const { envelopeId, envelopeItemId, documentDataId, token, version } = options;

  const partialUrl = `envelope/${envelopeId}/envelopeItem/${envelopeItemId}/dataId/${documentDataId}/${version}/item.pdf`;

  // Recipient token endpoint.
  if (token) {
    return `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/token/${token}/${partialUrl}`;
  }

  // Endpoint authenticated by session, or by a presign token sent with
  // `getPresignRequestHeaders`.
  return `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/${partialUrl}`;
};

/**
 * Headers that carry a presign token to the file routes. The token is a bearer
 * credential, so it travels in `Authorization` and never in the URL, where it
 * would be written to access logs and browser history.
 */
export const getPresignRequestHeaders = (presignToken: string | undefined): Record<string, string> => {
  if (!presignToken) {
    return {};
  }

  return { Authorization: `Bearer ${presignToken}` };
};

/**
 * Gets a PDF url for the PDF viewer.
 *
 * Returns `null` if invalid.
 */
export const getDocumentDataUrlForPdfViewer = (options: DocumentDataUrlOptions): string | null => {
  const { envelopeId, envelopeItemId, documentDataId } = options;

  if (!envelopeId || !envelopeItemId || !documentDataId) {
    return null;
  }

  return getDocumentDataUrl(options);
};
