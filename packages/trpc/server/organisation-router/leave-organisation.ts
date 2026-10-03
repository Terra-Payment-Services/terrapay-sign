import { ORGANISATION_ACCOUNT_LINK_VERIFICATION_TOKEN_IDENTIFIER } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { jobs } from '@documenso/lib/jobs/client';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import { ZLeaveOrganisationRequestSchema, ZLeaveOrganisationResponseSchema } from './leave-organisation.types';

export const leaveOrganisationRoute = authenticatedProcedure
  .input(ZLeaveOrganisationRequestSchema)
  .output(ZLeaveOrganisationResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { organisationId } = input;
    const userId = ctx.user.id;

    ctx.logger.info({
      input: {
        organisationId,
      },
    });

    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({ organisationId, userId }),
      include: {
        teams: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!organisation) {
      throw new AppError(AppErrorCode.NOT_FOUND);
    }

    // The organisation owner cannot leave their own organisation. Ownership must
    // be transferred to another member first.
    if (organisation.ownerUserId === userId) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You cannot leave an organisation you own. Please transfer ownership first.',
      });
    }

    const teamIds = organisation.teams.map((team) => team.id);

    await prisma.$transaction(async (tx) => {
      // Leaving the org cascades the user out of every team via
      // OrganisationGroupMember, but their authored Envelope rows still
      // reference them. Reassign those to the org owner so they remain
      // reachable after the member loses access (mirrors delete-user.ts).
      if (teamIds.length > 0) {
        await tx.envelope.updateMany({
          where: {
            userId,
            teamId: {
              in: teamIds,
            },
          },
          data: {
            userId: organisation.ownerUserId,
          },
        });
      }

      await tx.organisationMember.delete({
        where: {
          userId_organisationId: {
            userId,
            organisationId,
          },
        },
      });

      // An outstanding single sign-on link token for this organisation would
      // otherwise survive the departure and redeem back into membership, at the
      // portal's default role rather than the one just given up. Redemption
      // checks the organisation's provisioning switch as well, so this is the
      // second lock on the same door.
      await tx.verificationToken.deleteMany({
        where: {
          userId,
          identifier: ORGANISATION_ACCOUNT_LINK_VERIFICATION_TOKEN_IDENTIFIER,
          metadata: {
            path: ['organisationId'],
            equals: organisationId,
          },
        },
      });
    });

    await jobs.triggerJob({
      name: 'send.organisation-member-left.email',
      payload: {
        organisationId: organisation.id,
        memberUserId: userId,
      },
    });
  });
