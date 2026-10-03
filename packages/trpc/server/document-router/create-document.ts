import { convertToPdf } from '@documenso/lib/server-only/document-conversion';
import { createEnvelope } from '@documenso/lib/server-only/envelope/create-envelope';
import { getEnvelopeItemLimit } from '@documenso/lib/server-only/organisation/get-envelope-item-limit';
import { insertFormValuesInPdf } from '@documenso/lib/server-only/pdf/insert-form-values-in-pdf';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { EnvelopeType } from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  createDocumentMeta,
  ZCreateDocumentRequestSchema,
  ZCreateDocumentResponseSchema,
} from './create-document.types';

export const createDocumentRoute = authenticatedProcedure
  .meta(createDocumentMeta)
  .input(ZCreateDocumentRequestSchema)
  .output(ZCreateDocumentResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    const { payload, file } = input;

    const {
      title,
      externalId,
      visibility,
      globalAccessAuth,
      globalActionAuth,
      recipients,
      meta,
      folderId,
      formValues,
      attachments,
    } = payload;

    let pdf = await convertToPdf(file, ctx.logger);

    if (formValues) {
      // eslint-disable-next-line require-atomic-updates
      pdf = await insertFormValuesInPdf({
        pdf,
        formValues,
      });
    }

    const { id: documentDataId } = await putNormalizedPdfFileServerSide(
      {
        name: file.name,
        type: 'application/pdf',
        arrayBuffer: async () => Promise.resolve(pdf),
      },
      { owner: { userId: ctx.user.id, teamId: ctx.teamId } },
    );

    ctx.logger.info({
      input: {
        folderId,
      },
    });

    await getEnvelopeItemLimit({ userId: user.id, teamId });

    const document = await createEnvelope({
      userId: user.id,
      teamId,
      internalVersion: 1,
      data: {
        type: EnvelopeType.DOCUMENT,
        title,
        externalId,
        visibility,
        globalAccessAuth,
        globalActionAuth,
        formValues,
        recipients: (recipients || []).map((recipient) => ({
          ...recipient,
          fields: (recipient.fields || []).map((field) => ({
            ...field,
            page: field.pageNumber,
            positionX: field.pageX,
            positionY: field.pageY,
            documentDataId,
          })),
        })),
        folderId,
        envelopeItems: [
          {
            // If you ever allow more than 1 in this endpoint, make sure to use `maximumEnvelopeItemCount` to limit it.
            documentDataId,
          },
        ],
      },
      attachments,
      meta: {
        ...meta,
        emailSettings: meta?.emailSettings ?? undefined,
      },
      requestMetadata: ctx.metadata,
    });

    return {
      envelopeId: document.id,
      id: mapSecondaryIdToDocumentId(document.secondaryId),
    };
  });
