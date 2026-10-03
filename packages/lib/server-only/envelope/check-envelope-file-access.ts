import { prisma } from '@documenso/prisma';
import type { TeamMemberRole } from '@prisma/client';
import { EnvelopeType, TemplateType } from '@prisma/client';

import { canAccessEnvelopeFile } from '../../utils/envelope-file-access';
import { buildTeamWhereQuery, getHighestTeamRoleInGroup } from '../../utils/teams';

export type CheckEnvelopeFileAccessOptions = {
  /** The authenticated user asking for the bytes. */
  userId: number;
  /** The envelope the requested item belongs to. */
  envelopeId: string;
};

/**
 * Check whether a user may read the stored bytes of an envelope's items.
 *
 * Gathers the envelope, the caller's role on its team and, for organisation
 * templates, the roles the caller holds elsewhere in the organisation, then
 * applies `canAccessEnvelopeFile`.
 *
 * Takes an envelope ID rather than envelope fields on purpose. A caller cannot
 * omit the visibility or pass one belonging to another envelope, so the rule
 * holds for any route added later.
 *
 * Recipients signing through a token never come through here. Those routes
 * match the token against the envelope's recipients and serve the item on that
 * basis, which is what lets someone sign a document they have no team standing
 * in.
 *
 * @param userId - the authenticated user
 * @param envelopeId - the envelope whose file was requested
 * @returns true when the bytes may be served
 */
export const checkEnvelopeFileAccess = async ({
  userId,
  envelopeId,
}: CheckEnvelopeFileAccessOptions): Promise<boolean> => {
  const envelope = await prisma.envelope.findFirst({
    where: {
      id: envelopeId,
    },
    select: {
      userId: true,
      teamId: true,
      type: true,
      templateType: true,
      visibility: true,
      user: {
        select: {
          email: true,
        },
      },
      team: {
        select: {
          organisationId: true,
        },
      },
    },
  });

  if (!envelope) {
    return false;
  }

  const team = await prisma.team.findFirst({
    where: buildTeamWhereQuery({ teamId: envelope.teamId, userId }),
    select: {
      teamEmail: {
        select: {
          email: true,
        },
      },
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
        select: {
          teamRole: true,
        },
      },
    },
  });

  const isOrganisationTemplate =
    envelope.type === EnvelopeType.TEMPLATE && envelope.templateType === TemplateType.ORGANISATION;

  let organisationTeamRoles: TeamMemberRole[] = [];

  if (isOrganisationTemplate) {
    const organisationTeamGroups = await prisma.teamGroup.findMany({
      where: {
        team: {
          organisationId: envelope.team.organisationId,
        },
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
      select: {
        teamRole: true,
      },
    });

    organisationTeamRoles = organisationTeamGroups.map((group) => group.teamRole);
  }

  return canAccessEnvelopeFile({
    envelope: {
      ownerUserId: envelope.userId,
      ownerEmail: envelope.user.email,
      type: envelope.type,
      templateType: envelope.templateType,
      visibility: envelope.visibility,
    },
    membership: {
      userId,
      teamRole: team ? getHighestTeamRoleInGroup(team.teamGroups) : null,
      teamEmail: team?.teamEmail?.email ?? null,
      organisationTeamRoles,
    },
  });
};
