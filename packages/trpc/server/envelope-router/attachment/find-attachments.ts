import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { isRecipientTokenAccessAuthorized } from '@documenso/lib/server-only/document/assert-recipient-access-authorized';
import { findAttachmentsByEnvelopeId } from '@documenso/lib/server-only/envelope-attachment/find-attachments-by-envelope-id';
import { findAttachmentsByToken } from '@documenso/lib/server-only/envelope-attachment/find-attachments-by-token';

import { maybeAuthenticatedProcedure } from '../../trpc';
import {
  findAttachmentsMeta,
  ZFindAttachmentsRequestSchema,
  ZFindAttachmentsResponseSchema,
} from './find-attachments.types';

export const findAttachmentsRoute = maybeAuthenticatedProcedure
  .meta(findAttachmentsMeta)
  .input(ZFindAttachmentsRequestSchema)
  .output(ZFindAttachmentsResponseSchema)
  .query(async ({ input, ctx }) => {
    const { envelopeId, token } = input;

    ctx.logger.info({
      input: { envelopeId },
    });

    if (token) {
      // The attachments are part of the document, so they wait for the emailed access code too.
      if (!(await isRecipientTokenAccessAuthorized({ headers: ctx.req.headers, token, userId: ctx.user?.id }))) {
        throw new AppError(AppErrorCode.UNAUTHORIZED, {
          message: 'The access code must be entered before viewing this document',
        });
      }

      const data = await findAttachmentsByToken({ envelopeId, token });

      return {
        data,
      };
    }

    const { teamId } = ctx;
    const userId = ctx.user?.id;

    if (!userId || !teamId) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You must be authenticated to access this resource',
      });
    }

    const data = await findAttachmentsByEnvelopeId({ envelopeId, teamId, userId });

    return {
      data,
    };
  });
