import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';

export type GetEnvelopeItemLimitOptions = {
  userId: number;
  teamId: number;
};

/**
 * Returns how many items one envelope may hold in the given team, taken from the
 * organisation claim. Refuses a user who does not belong to the team.
 */
export const getEnvelopeItemLimit = async ({ userId, teamId }: GetEnvelopeItemLimitOptions) => {
  const team = await prisma.team.findFirst({
    where: buildTeamWhereQuery({ teamId, userId }),
    select: {
      organisation: {
        select: {
          organisationClaim: {
            select: {
              envelopeItemCount: true,
            },
          },
        },
      },
    },
  });

  if (!team) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Team not found',
    });
  }

  return team.organisation.organisationClaim.envelopeItemCount;
};

export type AssertEnvelopeItemCountWithinLimitOptions = {
  count: number;
  limit: number;
};

/**
 * Refuses an envelope holding more items than the organisation claim allows.
 */
export const assertEnvelopeItemCountWithinLimit = ({ count, limit }: AssertEnvelopeItemCountWithinLimitOptions) => {
  if (count > limit) {
    throw new AppError('ENVELOPE_ITEM_LIMIT_EXCEEDED', {
      message: `You cannot upload more than ${limit} envelope items per envelope`,
      statusCode: 400,
    });
  }
};
