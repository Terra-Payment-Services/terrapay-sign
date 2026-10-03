import { prisma } from '@documenso/prisma';
import type { OrganisationMemberRole, TeamMemberRole } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { generateDatabaseId } from '../../universal/id';
import { assertOrganisationRoleChangeTakesEffect } from '../../utils/organisations';
import {
  assertTeamRoleChangeTakesEffect,
  getHighestTeamRoleInGroup,
  isTeamRoleWithinUserHierarchy,
} from '../../utils/teams';

type MemberGroupRoleChange = {
  /** The organisation member whose internal group membership is being rewritten. */
  organisationMemberId: string;
  /** Every group the member belonged to when their effective role was judged. */
  observedGroupIds: string[];
  /** The internal group membership this change removes, where the member has one. */
  groupIdToRemove?: string;
  /** The internal group this change puts the member in. */
  groupIdToAdd: string;
};

export type ApplyOrganisationMemberGroupRoleChangeOptions = MemberGroupRoleChange & {
  /** Organisation routes leave the team out and read every group the member is in. */
  teamId?: undefined;
  /** The organisation role the change is meant to leave the member holding. */
  requestedRole: OrganisationMemberRole;
};

export type ApplyTeamMemberGroupRoleChangeOptions = MemberGroupRoleChange & {
  /** Narrows the re-read to the groups this team draws a role from. */
  teamId: number;
  /** The team role the change is meant to leave the member holding. */
  requestedRole: TeamMemberRole;
  /** The caller, and the team role their authority to make this change was checked against. */
  actor?: {
    userId: number;
    authorisedRole: TeamMemberRole;
  };
};

export type ApplyMemberGroupRoleChangeOptions =
  | ApplyOrganisationMemberGroupRoleChangeOptions
  | ApplyTeamMemberGroupRoleChangeOptions;

type RetainedOrganisationGroup = {
  id: string;
  name: string | null;
  organisationRole: OrganisationMemberRole;
};

type RetainedTeamGroup = {
  organisationGroupId: string;
  name: string | null;
  teamRole: TeamMemberRole;
};

/**
 * Move a member between internal groups, refusing it if their groups moved underneath us.
 *
 * The route reads the member's groups, works out whether the new role would take
 * effect against what those groups confer, and then writes. Two different things
 * can move in that gap. Someone can put the member into a custom ADMIN group. Or
 * a group the member already sits in gets promoted, which leaves the membership
 * set exactly as it was read while changing what it confers. Either way the
 * demotion lands, the route reports success, and the person walks out still
 * holding what was meant to be taken off them. On a signing platform an
 * organisation administrator can countersign and read every document, so the
 * administrator who ordered the demotion has been told something false about who
 * holds signing authority.
 *
 * Closing both means the write has to see whatever a concurrent writer already
 * did, while a writer arriving later has to wait. Two row locks at the top of
 * the transaction give that.
 *
 * The promotion is caught by FOR SHARE on the groups. A Prisma update of the
 * role column takes FOR NO KEY UPDATE, which FOR SHARE conflicts with, so a
 * promotion already in flight has to commit before the lock is granted and then
 * lands in the re-read below. One arriving later waits. Measured against
 * PostgreSQL 16, a concurrent promotion sat out the full 1.2s hold behind FOR
 * SHARE and went through in 0.7ms against FOR KEY SHARE, which does not conflict
 * with it.
 *
 * A new membership needs FOR UPDATE on the member instead. Inserting an
 * OrganisationGroupMember row takes a KEY SHARE lock on the OrganisationMember
 * row it points at through the foreign key, and KEY SHARE conflicts with FOR
 * UPDATE. That lock has to be raw, since Prisma's own update takes FOR NO KEY
 * UPDATE and a concurrent insert sailed past it in 21ms.
 *
 * Inside a team there is a third move, and no row lock reaches it. Linking a
 * group to the team writes a TeamGroup row that did not exist when we looked, so
 * there was nothing to hold. Link a group the member already belongs to, at
 * ADMIN, and they hold a team role the demotion never read. The re-read below
 * would catch it, since that group then answers the team filter and shows up as
 * gained, but only if the insert is already committed when the re-read runs, and
 * nothing arranged for that.
 *
 * The Team row is what both sides have in common. Inserting a TeamGroup takes a
 * KEY SHARE lock on the team it points at, through the foreign key, and FOR
 * UPDATE is the one mode that conflicts with KEY SHARE. So a team role change
 * takes the Team row FOR UPDATE first: an insert already in flight has to commit
 * before the lock is granted and then shows up in the re-read, and one arriving
 * later waits for the demotion to finish. Measured against PostgreSQL 16, a
 * concurrent link sat out the full 1.2s hold behind FOR UPDATE and went through
 * in about 2ms behind FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE and no lock
 * alike. Nothing had to be added to the inserting side. The foreign key makes
 * every writer of a TeamGroup row honour the lock, including the ones nobody has
 * written yet.
 *
 * Groups are locked before the member, in id order, and the team before both.
 * `applyOrganisationGroupUpdate` writes the group and then its membership, so it
 * holds the group row while it reaches for the member. Taking them in that same
 * order here leaves no cycle for two transactions to sit in; the other way round
 * deadlocked 40 times out of 40 in a probe. `deleteTeam` takes the Team row and
 * then the team's TeamGroup rows by cascade, so the team has to come first for
 * the same reason. Taking it after the group lock instead deadlocked 40 out of 40
 * against a concurrent team delete, and 0 out of 40 in this order.
 *
 * A group the member is on their way out of is neither locked nor re-read.
 * Whatever it confers goes with it.
 *
 * Holding the Team row also settles the caller's own authority, for a team role
 * change. The role they were checked at was read before the transaction opened,
 * so a caller demoted mid-request would otherwise spend authority they no longer
 * have. Every team role change on this team now queues on the same Team row, so a
 * re-read inside the transaction cannot go stale: the demotion that would lower
 * the caller either committed before our lock, and we see it, or waits until
 * after we commit. Pass `actor` and the change is refused when the caller's team
 * role has dropped below the one their authority was judged at.
 *
 * Not every way of lowering the caller goes through a team role change, though.
 * `applyOrganisationGroupUpdate` can take them out of a custom group. Unlinking a
 * group from the team does it too, and so does lowering what a link confers.
 * None of those touch the Team row, so each can commit in the window between
 * that re-read and our commit. The first is closed by holding the caller's own
 * `OrganisationGroupMember` rows FOR SHARE, since those are the rows a removal
 * has to delete: one already in flight commits before the lock is granted and
 * lands in the re-read, and one arriving later waits. Measured against
 * PostgreSQL 16, a concurrent removal of the caller's membership went through in
 * 0.3ms mid-demotion with no pin, and waited out the remaining 754.7ms of the
 * demotion's hold with it. `deleteTeamGroup` and `updateTeamGroup` write only
 * TeamGroup rows and stay open.
 *
 * Position was settled by deadlock control. Taking the pin after the member lock
 * gives a concurrent group update a cycle to sit in, where it removes the caller
 * and adds the member being demoted: it holds the caller's membership row and
 * reaches for the member row through its insert's foreign key, while we hold the
 * member row and reach for the caller's row. That deadlocked 100 times out of
 * 100. Before the member lock it deadlocked 0 out of 100, whether taken before
 * or after the group lock, so it sits in the later of the two and is held for
 * less time.
 *
 * The organisation branch gets no such pin. Somebody will want to make the two
 * match, so here is why they must not. Two administrators demoting each other at
 * once each hold the other's membership rows and then reach for them, which
 * deadlocked 100 out of 100 with the pin in the organisation branch and 0 out of
 * 100 without it. Inside a team both callers queue on the Team row before either
 * can take anything, and the same pair deadlocked 0 out of 100 there with the
 * pin. Uniformity here would turn a race that refuses one request into one that
 * fails both.
 *
 * @param options - the member, the groups seen when the role change was judged, the role being set, and the move to apply
 * @throws {AppError} INVALID_REQUEST when a group the member keeps was promoted since the role change was judged
 * @throws {AppError} INVALID_REQUEST when the member joined a group since their groups were read
 * @throws {AppError} UNAUTHORIZED when the caller's own team role dropped since their authority was checked
 * @throws {AppError} NOT_FOUND when the member no longer exists
 * @throws {AppError} NOT_FOUND when the team no longer exists
 */
export const applyMemberGroupRoleChange = async (options: ApplyMemberGroupRoleChangeOptions): Promise<void> => {
  const { organisationMemberId, observedGroupIds, groupIdToRemove, groupIdToAdd } = options;

  // Sorted so that two of these running at once reach for the same group rows in
  // the same order.
  const retainedGroupIds = observedGroupIds.filter((groupId) => groupId !== groupIdToRemove).sort();

  await prisma.$transaction(async (tx) => {
    if (options.teamId !== undefined) {
      // Taken before anything else, and taken FOR UPDATE because that is the one
      // mode a TeamGroup insert's foreign key lock conflicts with. Holding it is
      // what makes the re-read below able to see a group linked to the team
      // underneath us.
      const lockedTeams = await tx.$queryRaw<{ id: number }[]>`
        SELECT "id" FROM "Team" WHERE "id" = ${options.teamId} FOR UPDATE
      `;

      if (lockedTeams.length === 0) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Team does not exist',
        });
      }
    }

    if (retainedGroupIds.length > 0) {
      if (options.teamId === undefined) {
        const retainedGroups = await tx.$queryRaw<RetainedOrganisationGroup[]>`
          SELECT "id", "name", "organisationRole" FROM "OrganisationGroup"
          WHERE "id" = ANY(${retainedGroupIds}) ORDER BY "id" FOR SHARE
        `;

        assertOrganisationRoleChangeTakesEffect({ requestedRole: options.requestedRole, retainedGroups });
      } else {
        // The role a group confers inside a team lives on the TeamGroup row, so
        // that is the row to hold. The group is joined for its name, which the
        // refusal message uses, and is left unlocked.
        const retainedGroups = await tx.$queryRaw<RetainedTeamGroup[]>`
          SELECT "TeamGroup"."organisationGroupId", "OrganisationGroup"."name", "TeamGroup"."teamRole"
          FROM "TeamGroup"
          INNER JOIN "OrganisationGroup" ON "OrganisationGroup"."id" = "TeamGroup"."organisationGroupId"
          WHERE "TeamGroup"."teamId" = ${options.teamId}
            AND "TeamGroup"."organisationGroupId" = ANY(${retainedGroupIds})
          ORDER BY "TeamGroup"."organisationGroupId" FOR SHARE OF "TeamGroup"
        `;

        assertTeamRoleChangeTakesEffect({ requestedRole: options.requestedRole, retainedGroups });
      }
    }

    if (options.teamId !== undefined && options.actor !== undefined) {
      // The caller's own membership rows, held so that the re-read below stays
      // true until we commit. Only the groups this team draws a role from, since
      // a group the team ignores cannot change what the caller holds here. It
      // goes before the member lock: after it, a group update removing the
      // caller and adding the member being demoted deadlocks with us every time.
      await tx.$queryRaw`
        SELECT "OrganisationGroupMember"."id"
        FROM "OrganisationGroupMember"
        INNER JOIN "OrganisationMember" ON "OrganisationMember"."id" = "OrganisationGroupMember"."organisationMemberId"
        INNER JOIN "TeamGroup" ON "TeamGroup"."organisationGroupId" = "OrganisationGroupMember"."groupId"
        WHERE "OrganisationMember"."userId" = ${options.actor.userId}
          AND "TeamGroup"."teamId" = ${options.teamId}
        ORDER BY "OrganisationGroupMember"."id" FOR SHARE OF "OrganisationGroupMember"
      `;
    }

    const lockedMembers = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "OrganisationMember" WHERE "id" = ${organisationMemberId} FOR UPDATE
    `;

    if (lockedMembers.length === 0) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Organisation member does not exist',
      });
    }

    if (options.teamId !== undefined && options.actor !== undefined) {
      const actorTeamGroups = await tx.teamGroup.findMany({
        where: {
          teamId: options.teamId,
          organisationGroup: {
            organisationGroupMembers: {
              some: { organisationMember: { userId: options.actor.userId } },
            },
          },
        },
        select: { teamRole: true },
      });

      // Out of the team altogether reads as no role at all, which
      // getHighestTeamRoleInGroup would otherwise round up to the lowest one.
      const stillAuthorised =
        actorTeamGroups.length > 0 &&
        isTeamRoleWithinUserHierarchy(getHighestTeamRoleInGroup(actorTeamGroups), options.actor.authorisedRole);

      if (!stillAuthorised) {
        throw new AppError(AppErrorCode.UNAUTHORIZED, {
          message: 'Your own role in this team changed while the role change was being prepared. Try again.',
        });
      }
    }

    const currentGroups = await tx.organisationGroupMember.findMany({
      where: {
        organisationMemberId,
        ...(options.teamId === undefined ? {} : { group: { teamGroups: { some: { teamId: options.teamId } } } }),
      },
      select: {
        groupId: true,
      },
    });

    const observed = new Set(observedGroupIds);
    const gainedGroupIds = currentGroups.map(({ groupId }) => groupId).filter((groupId) => !observed.has(groupId));

    if (gainedGroupIds.length > 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message:
          'The member joined another group while the role change was being prepared. Review what that group grants them and try again.',
      });
    }

    if (groupIdToRemove !== undefined) {
      await tx.organisationGroupMember.delete({
        where: {
          organisationMemberId_groupId: {
            organisationMemberId,
            groupId: groupIdToRemove,
          },
        },
      });
    }

    await tx.organisationGroupMember.create({
      data: {
        id: generateDatabaseId('group_member'),
        organisationMemberId,
        groupId: groupIdToAdd,
      },
    });
  });
};
