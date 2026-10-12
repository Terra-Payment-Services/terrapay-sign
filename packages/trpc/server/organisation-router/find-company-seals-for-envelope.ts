import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { listCompanySeals } from '@documenso/lib/server-only/company-seal/company-seal-field';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZFindCompanySealsForEnvelopeRequestSchema,
  ZFindCompanySealsForEnvelopeResponseSchema,
} from './find-company-seals-for-envelope.types';

/** The seals a sender may place on an envelope: those of the organisation that owns its team. */
export const findCompanySealsForEnvelopeRoute = authenticatedProcedure
  .input(ZFindCompanySealsForEnvelopeRequestSchema)
  .output(ZFindCompanySealsForEnvelopeResponseSchema)
  .query(async ({ ctx, input }) => {
    const { envelopeId } = input;

    ctx.logger.info({
      input: {
        envelopeId,
      },
    });

    const unverified = await prisma.envelope.findUnique({
      where: { id: envelopeId },
      select: { teamId: true },
    });

    if (!unverified) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Envelope not found' });
    }

    // Throws unless the caller is a member of the envelope's team and may see the envelope.
    const { envelopeWhereInput } = await getEnvelopeWhereInput({
      id: { type: 'envelopeId', id: envelopeId },
      type: null,
      userId: ctx.user.id,
      teamId: unverified.teamId,
    });

    const envelope = await prisma.envelope.findFirst({
      where: envelopeWhereInput,
      include: { team: true, recipients: true },
    });

    if (!envelope) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Envelope not found' });
    }

    const members = await prisma.organisationMember.findMany({
      // A disabled account keeps its membership row but cannot apply a seal, so it is warned about.
      where: { organisationId: envelope.team.organisationId, user: { disabled: false } },
      select: { user: { select: { email: true } } },
    });

    const memberEmails = new Set(members.map((member) => member.user.email.trim().toLowerCase()));

    ctx.resHeaders?.set('Cache-Control', 'private, no-store');

    return {
      data: await listCompanySeals(envelope.team.organisationId),
      nonMemberRecipientIds: envelope.recipients
        .filter((recipient) => !memberEmails.has(recipient.email.trim().toLowerCase()))
        .map((recipient) => recipient.id),
    };
  });
