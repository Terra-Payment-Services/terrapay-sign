import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { applyMemberGroupRoleChange } from '@documenso/lib/server-only/organisation/apply-member-group-role-change';
import { assertOrganisationRoleAssignable } from '@documenso/lib/server-only/organisation/assert-organisation-role-assignable';
import {
  assertOrganisationRoleChangeTakesEffect,
  buildOrganisationWhereQuery,
  getHighestOrganisationRoleInGroup,
  isOrganisationRoleWithinUserHierarchy,
} from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';
import { OrganisationGroupType } from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  ZUpdateOrganisationMemberRequestSchema,
  ZUpdateOrganisationMemberResponseSchema,
} from './update-organisation-members.types';

export const updateOrganisationMemberRoute = authenticatedProcedure
  //   .meta(updateOrganisationMemberMeta)
  .input(ZUpdateOrganisationMemberRequestSchema)
  .output(ZUpdateOrganisationMemberResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { organisationId, organisationMemberId, data } = input;
    const userId = ctx.user.id;

    ctx.logger.info({
      input: {
        organisationId,
        organisationMemberId,
      },
    });

    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({
        organisationId,
        userId,
        roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
      }),
      include: {
        groups: {
          where: {
            type: OrganisationGroupType.INTERNAL_ORGANISATION,
          },
        },
        members: {
          include: {
            organisationGroupMembers: {
              include: {
                group: true,
              },
            },
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!organisation) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Organisation not found' });
    }

    const currentUser = organisation.members.find((member) => member.userId === userId);

    const organisationMemberToUpdate = organisation.members.find((member) => member.id === organisationMemberId);

    if (!organisationMemberToUpdate || !currentUser) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Organisation member does not exist' });
    }

    if (organisationMemberToUpdate.userId === organisation.ownerUserId) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Cannot update the owner' });
    }

    const currentUserOrganisationRoles = currentUser.organisationGroupMembers.filter(
      ({ group }) => group.type === OrganisationGroupType.INTERNAL_ORGANISATION,
    );

    if (currentUserOrganisationRoles.length !== 1) {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'Current user has multiple internal organisation roles',
      });
    }

    const currentUserOrganisationRole = currentUserOrganisationRoles[0].group.organisationRole;
    const currentMemberToUpdateOrganisationRole = getHighestOrganisationRoleInGroup(
      organisationMemberToUpdate.organisationGroupMembers.flatMap((member) => member.group),
    );

    const isMemberToUpdateHigherRole = !isOrganisationRoleWithinUserHierarchy(
      currentUserOrganisationRole,
      currentMemberToUpdateOrganisationRole,
    );

    if (isMemberToUpdateHigherRole) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Cannot update a member with a higher role',
      });
    }

    const isNewMemberRoleHigherThanCurrentRole = !isOrganisationRoleWithinUserHierarchy(
      currentUserOrganisationRole,
      data.role,
    );

    if (isNewMemberRoleHigherThanCurrentRole) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Cannot give a member a role higher than the user initating the update',
      });
    }

    // The two checks above read the caller's role out of their internal group,
    // which is the stricter of the two readings and is kept. This one goes
    // through the shared rule, which reads the highest role across every group
    // the caller belongs to, and which also refuses a caller raising their own
    // role. Both have to pass.
    await assertOrganisationRoleAssignable({
      organisationId,
      userId,
      roleToAssign: data.role,
      targetUserId: organisationMemberToUpdate.userId,
      currentTargetRole: currentMemberToUpdateOrganisationRole,
    });

    const memberToUpdateGroups = organisationMemberToUpdate.organisationGroupMembers.map(({ group }) => group);

    // Read the internal group out of the member's own memberships. Matching the
    // organisation's internal groups against their highest role picked a group
    // they were not in whenever that role came from a custom one, and the delete
    // below then failed on a membership row that never existed.
    const currentMemberGroup = memberToUpdateGroups.find(
      (group) => group.type === OrganisationGroupType.INTERNAL_ORGANISATION,
    );

    const newMemberGroup = organisation.groups.find((group) => group.organisationRole === data.role);

    if (!currentMemberGroup) {
      console.error('[CRITICAL]: Missing internal group');

      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'Current member group not found',
      });
    }

    // Only the internal group is rewritten below, so a role conferred by any
    // other group survives the write. Saying the demotion worked when the person
    // keeps administrator rights through a custom group is the worst outcome
    // available here, since an organisation administrator can countersign and
    // read every document. Refuse and name the groups instead.
    assertOrganisationRoleChangeTakesEffect({
      requestedRole: data.role,
      retainedGroups: memberToUpdateGroups.filter((group) => group.id !== currentMemberGroup.id),
    });

    if (!newMemberGroup) {
      console.error('[CRITICAL]: Missing internal group');

      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'New member group not found',
      });
    }

    // Switch member to new internal group role. The check above was answered
    // from groups read before any of this, so the write carries both that group
    // list and the role it was answered for. It refuses if the member has joined
    // another group since, or if one of these was promoted.
    await applyMemberGroupRoleChange({
      organisationMemberId: organisationMemberToUpdate.id,
      observedGroupIds: memberToUpdateGroups.map((group) => group.id),
      requestedRole: data.role,
      groupIdToRemove: currentMemberGroup.id,
      groupIdToAdd: newMemberGroup.id,
    });
  });
