import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import {
  assertCompanySealApplicable,
  getCompanySealImage,
} from '@documenso/lib/server-only/company-seal/company-seal-field';
import { prisma } from '@documenso/prisma';
import { DocumentStatus } from '@prisma/client';

import { procedure } from '../trpc';
import {
  ZGetCompanySealForFieldRequestSchema,
  ZGetCompanySealForFieldResponseSchema,
} from './get-company-seal-for-field.types';

/**
 * The seal image for the signing page's confirmation step. Needs the
 * recipient's token and a Sign session that passes every check applying the
 * seal would, so a forwarded link alone shows nothing.
 */
export const getCompanySealForFieldRoute = procedure
  .input(ZGetCompanySealForFieldRequestSchema)
  .output(ZGetCompanySealForFieldResponseSchema)
  .query(async ({ ctx, input }) => {
    const { token, fieldId } = input;

    ctx.logger.info({
      input: {
        fieldId,
      },
    });

    const recipient = await prisma.recipient.findFirst({ where: { token } });

    const field = recipient
      ? await prisma.field.findFirst({
          where: { id: fieldId, envelopeId: recipient.envelopeId },
          include: { envelope: true },
        })
      : null;

    if (!recipient || !field) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Field not found' });
    }

    if (field.envelope.status !== DocumentStatus.PENDING) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'The document must be pending' });
    }

    const seal = await assertCompanySealApplicable({ envelope: field.envelope, field, recipient, user: ctx.user });
    const { dataUrl } = await getCompanySealImage(seal);

    ctx.resHeaders?.set('Cache-Control', 'private, no-store');

    return { name: seal.name, legalEntityName: seal.legalEntityName, imageDataUrl: dataUrl };
  });
