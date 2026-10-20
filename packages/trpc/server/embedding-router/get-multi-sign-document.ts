import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { viewedDocument } from '@documenso/lib/server-only/document/viewed-document';
import { getCompletedFieldsForToken } from '@documenso/lib/server-only/field/get-completed-fields-for-token';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { getIsRecipientsTurnToSign } from '@documenso/lib/server-only/recipient/get-is-recipient-turn';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { extractDocumentAuthMethods } from '@documenso/lib/utils/document-auth';

import { procedure } from '../trpc';
import {
  ZGetMultiSignDocumentRequestSchema,
  ZGetMultiSignDocumentResponseSchema,
} from './get-multi-sign-document.types';

export const getMultiSignDocumentRoute = procedure
  .input(ZGetMultiSignDocumentRequestSchema)
  .output(ZGetMultiSignDocumentResponseSchema)
  .query(async ({ input, ctx: { metadata } }) => {
    try {
      const { token } = input;

      const [document, fields, recipient] = await Promise.all([
        getDocumentAndSenderByToken({
          token,
          requireAccessAuth: false,
        }).catch(() => null),
        getFieldsForToken({ token }),
        getRecipientByToken({ token }).catch(() => null),
        getCompletedFieldsForToken({ token }).catch(() => []),
      ]);

      if (!document || !recipient) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Document or recipient not found',
        });
      }

      // Multi-sign signs through the V1 field routes, which refuse V2 envelopes (#142).
      if (document.internalVersion !== 1) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'V2 envelopes cannot be multi signed: sign them through envelope.field.sign',
        });
      }

      // Multi-sign cannot satisfy access auth, so do not hand out the contents of documents that require it.
      const { recipientAccessAuthRequired } = extractDocumentAuthMethods({
        documentAuth: document.authOptions,
        recipientAuth: recipient.authOptions,
      });

      if (recipientAccessAuthRequired) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Documents that require additional authentication cannot be multi signed at the moment',
        });
      }

      // Nothing is shown or recorded as viewed before the recipient's turn (#145).
      if (!(await getIsRecipientsTurnToSign({ token }))) {
        throw new AppError(AppErrorCode.RECIPIENT_OUT_OF_TURN, {
          message: 'It is not your turn to sign this document yet',
          statusCode: 400,
        });
      }

      await viewedDocument({
        token,
        requestMetadata: metadata.requestMetadata,
      });

      // Transform fields to match our schema
      const transformedFields = fields.map((field) => ({
        ...field,
        recipient: {
          ...recipient,
          documentId: document.id,
          templateId: null,
        },
        documentId: document.id,
        templateId: null,
      }));

      return {
        ...document,
        folder: null,
        fields: transformedFields,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'Failed to get document details',
      });
    }
  });
