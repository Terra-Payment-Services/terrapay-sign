import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getMemberOrganisationRole } from '@documenso/lib/server-only/team/get-member-roles';
import { canExecuteOrganisationAction } from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import { ZGetOrganisationRequestSchema, ZGetOrganisationResponseSchema } from './get-organisation.types';

export const getOrganisationRoute = authenticatedProcedure
  //   .meta(getOrganisationMeta)
  .input(ZGetOrganisationRequestSchema)
  .output(ZGetOrganisationResponseSchema)
  .query(async ({ input, ctx }) => {
    const { organisationReference } = input;

    ctx.logger.info({
      input: {
        organisationReference,
      },
    });

    const organisation = await getOrganisation({
      userId: ctx.user.id,
      organisationReference,
    });

    const role = await getMemberOrganisationRole({
      organisationId: organisation.id,
      reference: { type: 'User', id: ctx.user.id },
    });

    // Only those who can manage the organisation see its settings, subscription and billing customer (#164).
    if (!canExecuteOrganisationAction('MANAGE_ORGANISATION', role)) {
      return { ...organisation, organisationGlobalSettings: null, subscription: null, customerId: null };
    }

    return organisation;
  });

type GetOrganisationOptions = {
  userId: number;

  /**
   * The ID or URL of the organisation.
   */
  organisationReference: string;
};

export const getOrganisation = async ({ userId, organisationReference }: GetOrganisationOptions) => {
  const organisation = await prisma.organisation.findFirst({
    where: {
      OR: [{ id: organisationReference }, { url: organisationReference }],
      members: {
        some: {
          userId,
        },
      },
    },
    include: {
      organisationGlobalSettings: true,
      subscription: true,
      organisationClaim: true,
      members: {
        select: {
          id: true,
        },
      },
      teams: {
        where: {
          teamGroups: {
            some: {
              organisationGroup: {
                organisationGroupMembers: {
                  some: {
                    organisationMember: {
                      userId,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!organisation) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Organisation not found',
    });
  }

  return {
    ...organisation,
    teams: organisation.teams,
  };
};
