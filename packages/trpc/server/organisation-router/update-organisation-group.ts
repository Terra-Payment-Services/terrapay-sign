import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { applyOrganisationGroupUpdate } from '@documenso/lib/server-only/organisation/apply-organisation-group-update';
import { assertOrganisationRoleAssignable } from '@documenso/lib/server-only/organisation/assert-organisation-role-assignable';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';
import { OrganisationGroupType } from '@documenso/prisma/generated/types';
import { unique } from 'remeda';

import { authenticatedProcedure } from '../trpc';
import {
  ZUpdateOrganisationGroupRequestSchema,
  ZUpdateOrganisationGroupResponseSchema,
} from './update-organisation-group.types';

export const updateOrganisationGroupRoute = authenticatedProcedure
  // .meta(updateOrganisationGroupMeta)
  .input(ZUpdateOrganisationGroupRequestSchema)
  .output(ZUpdateOrganisationGroupResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { id, ...data } = input;
    const { user } = ctx;

    ctx.logger.info({
      input: {
        id,
      },
    });

    const organisationGroup = await prisma.organisationGroup.findFirst({
      where: {
        id,
        organisation: buildOrganisationWhereQuery({
          organisationId: undefined,
          userId: user.id,
          roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
        }),
      },
      include: {
        organisationGroupMembers: true,
        organisation: {
          include: {
            members: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    });

    if (!organisationGroup) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Organisation group not found',
      });
    }

    if (organisationGroup.type === OrganisationGroupType.INTERNAL_ORGANISATION) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You are not allowed to update internal organisation groups',
      });
    }

    // Both the role the group carries today and the role it would carry after
    // the edit have to be within reach. Leaving the role alone still moves
    // people into and out of the group, which is why the current role is
    // checked even when `organisationRole` is absent.
    await assertOrganisationRoleAssignable({
      organisationId: organisationGroup.organisationId,
      userId: user.id,
      roleToAssign: data.organisationRole ?? organisationGroup.organisationRole,
      currentTargetRole: organisationGroup.organisationRole,
    });

    const groupMemberIds = unique(data.memberIds || []);

    // Validate that members belong to the same organisation as the group.
    groupMemberIds.forEach((memberId) => {
      const member = organisationGroup.organisation.members.find(({ id }) => id === memberId);

      if (!member) {
        throw new AppError(AppErrorCode.NOT_FOUND);
      }
    });

    const membersToDelete = organisationGroup.organisationGroupMembers.filter(
      (member) => !groupMemberIds.includes(member.organisationMemberId),
    );

    const membersToCreate = groupMemberIds.filter(
      (id) => !organisationGroup.organisationGroupMembers.some((member) => member.organisationMemberId === id),
    );

    // The role the group carried when the check above ran is carried into the
    // write as a predicate. An administrator can promote this group between the
    // read and the write, and a request that named no role of its own would
    // otherwise add people to a group that had become something else.
    await applyOrganisationGroupUpdate({
      groupId: organisationGroup.id,
      authorisedRole: organisationGroup.organisationRole,
      organisationRole: data.organisationRole,
      name: data.name,
      // Membership is only touched when the request said what it should be.
      memberIdsToRemove: data.memberIds ? membersToDelete.map((member) => member.organisationMemberId) : [],
      memberIdsToAdd: data.memberIds ? membersToCreate : [],
    });
  });
