import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/teams';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { applyMemberGroupRoleChange } from '@documenso/lib/server-only/organisation/apply-member-group-role-change';
import { getMemberRoles } from '@documenso/lib/server-only/team/get-member-roles';
import {
  assertTeamRoleChangeTakesEffect,
  buildTeamWhereQuery,
  isTeamRoleWithinUserHierarchy,
} from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';
import { OrganisationGroupType, TeamMemberRole } from '@documenso/prisma/generated/types';
import { match } from 'ts-pattern';

import { authenticatedProcedure } from '../trpc';
import { ZUpdateTeamMemberRequestSchema, ZUpdateTeamMemberResponseSchema } from './update-team-member.types';

export const updateTeamMemberRoute = authenticatedProcedure
  //   .meta(updateTeamMemberMeta)
  .input(ZUpdateTeamMemberRequestSchema)
  .output(ZUpdateTeamMemberResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { teamId, memberId, data } = input;
    const userId = ctx.user.id;

    ctx.logger.info({
      input: {
        teamId,
        memberId,
      },
    });

    const team = await prisma.team.findFirst({
      where: {
        AND: [
          buildTeamWhereQuery({
            teamId,
            userId,
            roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_TEAM'],
          }),
          {
            organisation: {
              members: {
                some: {
                  id: memberId,
                },
              },
            },
          },
        ],
      },
      include: {
        // Every group the team has, not only its internal ones. A custom group
        // confers a team role just as an internal one does, and the check below
        // cannot see a role it never read.
        teamGroups: {
          include: {
            organisationGroup: {
              include: {
                organisationGroupMembers: {
                  include: {
                    organisationMember: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!team) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Team not found' });
    }

    const internalTeamGroupToRemoveMemberFrom = team.teamGroups.find(
      (group) =>
        group.organisationGroup.type === OrganisationGroupType.INTERNAL_TEAM &&
        group.teamId === teamId &&
        group.organisationGroup.organisationGroupMembers.some((member) => member.organisationMemberId === memberId),
    );

    const teamMemberGroup = team.teamGroups.find(
      (group) =>
        group.organisationGroup.type === OrganisationGroupType.INTERNAL_TEAM &&
        group.teamId === teamId &&
        group.teamRole === TeamMemberRole.MEMBER,
    );

    const teamManagerGroup = team.teamGroups.find(
      (group) =>
        group.organisationGroup.type === OrganisationGroupType.INTERNAL_TEAM &&
        group.teamId === teamId &&
        group.teamRole === TeamMemberRole.MANAGER,
    );

    const teamAdminGroup = team.teamGroups.find(
      (group) =>
        group.organisationGroup.type === OrganisationGroupType.INTERNAL_TEAM &&
        group.teamId === teamId &&
        group.teamRole === TeamMemberRole.ADMIN,
    );

    if (!teamMemberGroup || !teamManagerGroup || !teamAdminGroup) {
      console.error({
        message: 'Team groups not found.',
        teamMemberGroup: Boolean(teamMemberGroup),
        teamManagerGroup: Boolean(teamManagerGroup),
        teamAdminGroup: Boolean(teamAdminGroup),
      });

      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Team groups not found.',
      });
    }

    const { teamRole: currentUserTeamRole } = await getMemberRoles({
      teamId,
      reference: {
        type: 'User',
        id: userId,
      },
    });

    const { teamRole: currentMemberToUpdateTeamRole } = await getMemberRoles({
      teamId,
      reference: {
        type: 'Member',
        id: memberId,
      },
    });

    // Check role permissions.
    if (!isTeamRoleWithinUserHierarchy(currentUserTeamRole, currentMemberToUpdateTeamRole)) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Cannot update a member with a higher role',
      });
    }

    if (!isTeamRoleWithinUserHierarchy(currentUserTeamRole, data.role)) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Cannot update a member to a role higher than your own',
      });
    }

    const memberTeamGroups = team.teamGroups.filter((group) =>
      group.organisationGroup.organisationGroupMembers.some((member) => member.organisationMemberId === memberId),
    );

    const memberTeamGroupIds = memberTeamGroups.map((group) => group.organisationGroupId);

    // Only the internal team group is rewritten below, so a team role conferred
    // by a custom group survives the write. Reporting a demotion that did not
    // happen is the failure to avoid here, because a team administrator manages
    // the team's documents and members. Refuse and name the groups instead.
    assertTeamRoleChangeTakesEffect({
      requestedRole: data.role,
      retainedGroups: memberTeamGroups
        .filter((group) => group.organisationGroupId !== internalTeamGroupToRemoveMemberFrom?.organisationGroupId)
        .map((group) => ({
          organisationGroupId: group.organisationGroupId,
          name: group.organisationGroup.name,
          teamRole: group.teamRole,
        })),
    });

    // Switch member to new internal team group role. The check above was
    // answered from groups read before any of this, so the write carries both
    // that group list and the role it was answered for. It refuses if the member
    // has joined another group since, or if one of these was promoted. It also
    // refuses if a group the member belongs to was linked to the team underneath
    // it. Only the team's own groups count, since a group the team draws no role
    // from cannot change what they hold here. The caller's own role goes with
    // it, since both permission checks above rest on a read taken before any of
    // this.
    await applyMemberGroupRoleChange({
      organisationMemberId: memberId,
      teamId,
      observedGroupIds: memberTeamGroupIds,
      requestedRole: data.role,
      actor: {
        userId,
        authorisedRole: currentUserTeamRole,
      },
      groupIdToRemove: internalTeamGroupToRemoveMemberFrom?.organisationGroupId,
      groupIdToAdd: match(data.role)
        .with(TeamMemberRole.MEMBER, () => teamMemberGroup.organisationGroupId)
        .with(TeamMemberRole.MANAGER, () => teamManagerGroup.organisationGroupId)
        .with(TeamMemberRole.ADMIN, () => teamAdminGroup.organisationGroupId)
        .exhaustive(),
    });
  });
