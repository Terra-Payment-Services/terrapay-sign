import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { prisma } from '@documenso/prisma';
import { FieldType } from '@prisma/client';

import { authenticatedProcedure } from '../../trpc';
import {
  ZGetEnvelopeFieldSignaturesRequestSchema,
  ZGetEnvelopeFieldSignaturesResponseSchema,
} from './get-envelope-field-signatures.types';

export const getEnvelopeFieldSignaturesRoute = authenticatedProcedure
  .input(ZGetEnvelopeFieldSignaturesRequestSchema)
  .output(ZGetEnvelopeFieldSignaturesResponseSchema)
  .query(async ({ input, ctx }) => {
    const { teamId, user } = ctx;
    const { envelopeId } = input;

    ctx.logger.info({
      input: {
        envelopeId,
      },
    });

    // Validate the user has access to the envelope.
    const { envelopeWhereInput } = await getEnvelopeWhereInput({
      id: {
        type: 'envelopeId',
        id: envelopeId,
      },
      type: null,
      userId: user.id,
      teamId,
    });

    const envelope = await prisma.envelope.findFirst({
      where: envelopeWhereInput,
      include: {
        fields: {
          where: {
            inserted: true,
            type: { in: [FieldType.SIGNATURE, FieldType.COMPANY_SEAL] },
          },
          include: {
            signature: true,
          },
        },
      },
    });

    if (!envelope) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Envelope not found',
      });
    }

    // The response carries signature and seal images.
    ctx.resHeaders?.set('Cache-Control', 'private, no-store');

    // Seal snapshots go only to members of the envelope's own team, the audience of
    // organisation.companySeal.findForEnvelope. The where input above also admits the
    // envelope's owner and the team email's sender from another team.
    const fields = envelope.fields.filter(
      (field) => field.type !== FieldType.COMPANY_SEAL || envelope.teamId === teamId,
    );

    const signatures = fields.map((field) => ({
      fieldId: field.id,
      signatureImageAsBase64: field.signature?.signatureImageAsBase64 ?? null,
      typedSignature: field.signature?.typedSignature ?? null,
    }));

    return signatures;
  });
