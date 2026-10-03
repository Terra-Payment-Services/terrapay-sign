import type { OrganisationMemberRole } from '@prisma/client';

import { assertRoleAssignmentWithinHierarchy } from '../../utils/organisations';
import { getMemberOrganisationRole } from '../team/get-member-roles';

export type AssertOrganisationRoleAssignableOptions = {
  organisationId: string;
  /** The user making the change. */
  userId: number;
  /** The role, or roles, the change would confer. */
  roleToAssign: OrganisationMemberRole | OrganisationMemberRole[];
  /**
   * The user the new role would land on.
   *
   * Left out where the change sets a role for whoever turns up later, such as
   * the single sign-on default or the role carried by a group.
   */
  targetUserId?: number;
  /** The role the target carries today, where it carries one. */
  currentTargetRole?: OrganisationMemberRole;
};

/**
 * Refuse a role change the acting user is not entitled to make.
 *
 * Every path that can hand somebody an organisation role goes through this:
 * the member role update, invitations, organisation groups and the single
 * sign-on default role. Keeping it here rather than in each tRPC procedure is
 * the point. The escalation this closes was not in a procedure that forgot the
 * check, it was in a procedure nobody thought of as a role-granting path at
 * all.
 *
 * The actor's own role is read here rather than accepted as an argument, so a
 * caller cannot talk its way past the rule by passing a role it worked out for
 * itself.
 *
 * @param options - the organisation, the acting user, and what would be granted
 * @throws {AppError} NOT_FOUND when the acting user holds no role in the
 *   organisation, UNAUTHORIZED when the assignment is not permitted
 */
export const assertOrganisationRoleAssignable = async ({
  organisationId,
  userId,
  roleToAssign,
  targetUserId,
  currentTargetRole,
}: AssertOrganisationRoleAssignableOptions): Promise<void> => {
  const actorRole = await getMemberOrganisationRole({
    organisationId,
    reference: {
      type: 'User',
      id: userId,
    },
  });

  assertRoleAssignmentWithinHierarchy({
    actorRole,
    rolesToAssign: Array.isArray(roleToAssign) ? roleToAssign : [roleToAssign],
    currentTargetRole,
    isSelfAssignment: targetUserId !== undefined && targetUserId === userId,
  });
};
