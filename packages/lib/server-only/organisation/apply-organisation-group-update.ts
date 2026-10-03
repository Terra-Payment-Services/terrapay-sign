import { prisma } from '@documenso/prisma';
import type { OrganisationMemberRole } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { generateDatabaseId } from '../../universal/id';

export type ApplyOrganisationGroupUpdateOptions = {
  groupId: string;
  /** The role the group carried when the caller's authority to edit it was checked. */
  authorisedRole: OrganisationMemberRole;
  /** The role the caller is setting, where the request sets one. */
  organisationRole?: OrganisationMemberRole;
  /** The name the caller is setting, where the request sets one. Null clears it. */
  name?: string | null;
  /** Members to add. Empty when the request left the membership alone. */
  memberIdsToAdd: string[];
  /** Members to remove. Empty when the request left the membership alone. */
  memberIdsToRemove: string[];
};

/**
 * Write a custom group edit, refusing it if the group's role moved underneath us.
 *
 * The route reads the group, works out whether the caller may edit a group of
 * that role, and then writes. Between the read and the write an administrator
 * can promote the group, and a request that named no role of its own would then
 * add people to a group that had become something else. A manager who submits
 * "add me to the MANAGER group" and waits for the promotion lands in an ADMIN
 * group, which on this platform is signing authority.
 *
 * So the write states the role it was authorised against. `updateMany` carries
 * that as a predicate, takes the row lock, and reports a count of zero if the
 * role no longer matches, at which point nothing else in the transaction has
 * run. It also sets the role column even when the caller did not ask to change
 * it, so that the predicate is always evaluated against a locked row rather
 * than being optimised away.
 *
 * @param options - the group, the role it was authorised at, and the edit to apply
 * @throws {AppError} INVALID_REQUEST when the group's role changed since it was read
 */
export const applyOrganisationGroupUpdate = async ({
  groupId,
  authorisedRole,
  organisationRole,
  name,
  memberIdsToAdd,
  memberIdsToRemove,
}: ApplyOrganisationGroupUpdateOptions): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.organisationGroup.updateMany({
      where: {
        id: groupId,
        organisationRole: authorisedRole,
      },
      data: {
        organisationRole: organisationRole ?? authorisedRole,
        name,
      },
    });

    if (count === 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'The role this group confers changed while the update was being prepared. Review it and try again.',
      });
    }

    if (memberIdsToRemove.length > 0) {
      await tx.organisationGroupMember.deleteMany({
        where: {
          groupId,
          organisationMemberId: { in: memberIdsToRemove },
        },
      });
    }

    if (memberIdsToAdd.length > 0) {
      await tx.organisationGroupMember.createMany({
        data: memberIdsToAdd.map((organisationMemberId) => ({
          id: generateDatabaseId('group_member'),
          groupId,
          organisationMemberId,
        })),
      });
    }
  });
};
