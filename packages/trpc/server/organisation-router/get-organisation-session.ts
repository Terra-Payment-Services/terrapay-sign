import { canExecuteOrganisationAction, getHighestOrganisationRoleInGroup } from '@documenso/lib/utils/organisations';
import { buildTeamWhereQuery, extractDerivedTeamSettings, getHighestTeamRoleInGroup } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import type { TGetOrganisationSessionResponse } from './get-organisation-session.types';
import { ZGetOrganisationSessionResponseSchema } from './get-organisation-session.types';

/**
 * Get all the organisations and teams a user belongs to.
 */
export const getOrganisationSessionRoute = authenticatedProcedure
  .output(ZGetOrganisationSessionResponseSchema)
  .query(async ({ ctx }) => {
    return await getOrganisationSession({ userId: ctx.user.id });
  });

export const getOrganisationSession = async ({
  userId,
}: {
  userId: number;
}): Promise<TGetOrganisationSessionResponse> => {
  const organisations = await prisma.organisation.findMany({
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
    include: {
      organisationClaim: true,
      organisationGlobalSettings: true,
      subscription: true,
      groups: {
        where: {
          organisationGroupMembers: {
            some: {
              organisationMember: {
                userId,
              },
            },
          },
        },
      },
      teams: {
        where: buildTeamWhereQuery({ teamId: undefined, userId }),
        include: {
          teamGlobalSettings: true,
          teamEmail: { select: { email: true } },
          teamGroups: {
            where: {
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
            include: {
              organisationGroup: true,
            },
          },
        },
      },
    },
  });

  const sessions = organisations.map((organisation) => {
    const { organisationGlobalSettings } = organisation;
    const currentOrganisationRole = getHighestOrganisationRoleInGroup(organisation.groups);

    return {
      ...organisation,
      // Only those who can manage the organisation see its subscription and billing customer (#164).
      ...(canExecuteOrganisationAction('MANAGE_ORGANISATION', currentOrganisationRole)
        ? {}
        : { subscription: null, customerId: null }),
      teams: organisation.teams.map((team) => {
        const derivedSettings = extractDerivedTeamSettings(organisationGlobalSettings, team.teamGlobalSettings);

        return {
          ...team,
          currentTeamRole: getHighestTeamRoleInGroup(team.teamGroups),
          preferences: {
            aiFeaturesEnabled: derivedSettings.aiFeaturesEnabled,
          },
        };
      }),
      currentOrganisationRole,
    };
  });

  // The root loader serialises this result without the tRPC output schema, so parse it here: the raw organisation and
  // team settings must not reach a member's page payload (#164).
  return ZGetOrganisationSessionResponseSchema.parse(sessions);
};
