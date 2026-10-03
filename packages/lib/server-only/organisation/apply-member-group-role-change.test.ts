import { OrganisationMemberRole, TeamMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';

const mocks = vi.hoisted(() => ({
  teamLock: vi.fn(),
  groupLock: vi.fn(),
  memberLock: vi.fn(),
  actorPin: vi.fn(),
  actorTeamGroups: vi.fn(),
  groupMemberFindMany: vi.fn(),
  groupMemberDelete: vi.fn(),
  groupMemberCreate: vi.fn(),
  order: [] as string[],
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    $transaction: async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        $queryRaw: (fragments: string[], ...values: unknown[]) => {
          const sql = fragments.join('?');

          if (sql.includes('FROM "Team"')) {
            mocks.order.push('team-lock');

            return mocks.teamLock(fragments, ...values);
          }

          if (sql.includes('FROM "OrganisationGroupMember"')) {
            mocks.order.push('actor-pin');

            return mocks.actorPin(fragments, ...values);
          }

          if (sql.includes('FROM "OrganisationMember"')) {
            mocks.order.push('member-lock');

            return mocks.memberLock(fragments, ...values);
          }

          mocks.order.push('group-lock');

          return mocks.groupLock(fragments, ...values);
        },
        teamGroup: {
          findMany: (...args: unknown[]) => {
            mocks.order.push('actor-read');

            return mocks.actorTeamGroups(...args);
          },
        },
        organisationGroupMember: {
          findMany: (...args: unknown[]) => {
            mocks.order.push('read');

            return mocks.groupMemberFindMany(...args);
          },
          delete: mocks.groupMemberDelete,
          create: mocks.groupMemberCreate,
        },
      }),
  },
}));

import type {
  ApplyOrganisationMemberGroupRoleChangeOptions,
  ApplyTeamMemberGroupRoleChangeOptions,
} from './apply-member-group-role-change';
import { applyMemberGroupRoleChange } from './apply-member-group-role-change';

const apply = (overrides: Partial<ApplyOrganisationMemberGroupRoleChangeOptions> = {}) =>
  applyMemberGroupRoleChange({
    organisationMemberId: 'member_the_admin',
    observedGroupIds: ['group_internal_admin'],
    requestedRole: OrganisationMemberRole.MEMBER,
    groupIdToRemove: 'group_internal_admin',
    groupIdToAdd: 'group_internal_member',
    ...overrides,
  });

const applyToTeam = (overrides: Partial<ApplyTeamMemberGroupRoleChangeOptions> = {}) =>
  applyMemberGroupRoleChange({
    organisationMemberId: 'member_the_admin',
    teamId: 7,
    observedGroupIds: ['group_internal_team_admin'],
    requestedRole: TeamMemberRole.MEMBER,
    groupIdToRemove: 'group_internal_team_admin',
    groupIdToAdd: 'group_internal_team_member',
    ...overrides,
  });

const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim();

describe('applyMemberGroupRoleChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.order.length = 0;
    mocks.teamLock.mockResolvedValue([{ id: 7 }]);
    mocks.groupLock.mockResolvedValue([]);
    mocks.memberLock.mockResolvedValue([{ id: 'member_the_admin' }]);
    mocks.actorPin.mockResolvedValue([]);
    mocks.actorTeamGroups.mockResolvedValue([{ teamRole: TeamMemberRole.ADMIN }]);
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_admin' }]);
    mocks.groupMemberDelete.mockResolvedValue({});
    mocks.groupMemberCreate.mockResolvedValue({});
  });

  // The race left open when the effectiveness check shipped. An administrator
  // demotes someone to MEMBER, which is allowed because none of the groups read
  // a moment ago confer more than that. Someone else adds them to a custom ADMIN
  // group before the write lands. The demotion has to refuse rather than report
  // a withdrawal of signing authority that did not happen.
  it('refuses the write when the member joined a conferring group after the check', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([
      { groupId: 'group_internal_admin' },
      { groupId: 'group_custom_admin' },
    ]);

    await expect(apply()).rejects.toThrow(/joined another group while the role change was being prepared/);
  });

  it('moves nobody between groups in the write it refused', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([
      { groupId: 'group_internal_admin' },
      { groupId: 'group_custom_admin' },
    ]);

    await expect(apply()).rejects.toThrow(AppError);

    expect(mocks.groupMemberDelete).not.toHaveBeenCalled();
    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  // The other door into the same lie, and the one the membership guard cannot
  // see. Nobody touches who is in what group. A group the member already sits in
  // is promoted to ADMIN between the effectiveness check and the write, so the
  // membership set the write re-reads matches what was observed, and the demoted
  // member walks out an administrator.
  it('refuses the write when a group the member keeps was promoted after the check', async () => {
    mocks.groupLock.mockResolvedValue([
      { id: 'group_custom_g', name: 'Deal desk', organisationRole: OrganisationMemberRole.ADMIN },
    ]);

    await expect(apply({ observedGroupIds: ['group_internal_admin', 'group_custom_g'] })).rejects.toThrow(
      /Setting the role to MEMBER would have no effect, because the member holds a higher role through Deal desk \(ADMIN\)/,
    );
  });

  it('moves nobody between groups when it refused over a promoted group', async () => {
    mocks.groupLock.mockResolvedValue([
      { id: 'group_custom_g', name: 'Deal desk', organisationRole: OrganisationMemberRole.ADMIN },
    ]);

    await expect(apply({ observedGroupIds: ['group_internal_admin', 'group_custom_g'] })).rejects.toThrow(AppError);

    expect(mocks.groupMemberDelete).not.toHaveBeenCalled();
    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  it('refuses a team role change when a group the member keeps was promoted after the check', async () => {
    mocks.groupLock.mockResolvedValue([
      { organisationGroupId: 'group_custom_g', name: 'Deal desk', teamRole: TeamMemberRole.ADMIN },
    ]);

    await expect(applyToTeam({ observedGroupIds: ['group_internal_team_admin', 'group_custom_g'] })).rejects.toThrow(
      /would have no effect, because the member holds a higher role through Deal desk \(ADMIN\)/,
    );

    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  // The re-read is worth something only behind the lock. Put it first and an
  // insert committing a moment later stays invisible, so the demotion lands.
  it('locks the member row before re-reading their groups', async () => {
    await apply();

    expect(mocks.order).toEqual(['member-lock', 'read']);
  });

  // `applyOrganisationGroupUpdate` holds the group row while it reaches for the
  // member. Taking them the other way round here gives two transactions a cycle
  // to sit in.
  it('locks the groups before the member', async () => {
    await apply({ observedGroupIds: ['group_internal_admin', 'group_custom_g'] });

    expect(mocks.order).toEqual(['group-lock', 'member-lock', 'read']);
  });

  it('takes a share lock on the groups it re-reads, in id order', async () => {
    await apply({ observedGroupIds: ['group_internal_admin', 'group_custom_h', 'group_custom_g'] });

    const [, ...values] = mocks.groupLock.mock.calls[0];

    expect(sqlOf(mocks.groupLock.mock.calls[0])).toMatch(
      /SELECT "id", "name", "organisationRole" FROM "OrganisationGroup" WHERE "id" = ANY\(\?\) ORDER BY "id" FOR SHARE/,
    );
    expect(values).toEqual([['group_custom_g', 'group_custom_h']]);
  });

  // A group they are on their way out of cannot raise the role they come out
  // holding, and locking it would hold up an administrator editing it for no
  // reason.
  it('leaves the group the member is being taken out of unlocked', async () => {
    await apply({ observedGroupIds: ['group_internal_admin', 'group_custom_g'] });

    const [, ...values] = mocks.groupLock.mock.calls[0];

    expect(values).toEqual([['group_custom_g']]);
  });

  it('skips the group lock when the member keeps no other group', async () => {
    await apply();

    expect(mocks.groupLock).not.toHaveBeenCalled();
  });

  // Inside a team the role comes off the TeamGroup row, so that is the row a
  // promotion writes and the row worth holding. The group is joined for its name
  // and left unlocked.
  it('holds the team group rather than the organisation group for a team role change', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam({ observedGroupIds: ['group_internal_team_admin', 'group_custom_g'] });

    const [, ...values] = mocks.groupLock.mock.calls[0];

    expect(sqlOf(mocks.groupLock.mock.calls[0])).toMatch(
      /FROM "TeamGroup" INNER JOIN "OrganisationGroup" .* ORDER BY "TeamGroup"\."organisationGroupId" FOR SHARE OF "TeamGroup"/,
    );
    expect(values).toEqual([7, ['group_custom_g']]);
  });

  it('takes the lock on the member being changed', async () => {
    await apply();

    const [fragments, ...values] = mocks.memberLock.mock.calls[0];

    expect(fragments.join('?')).toMatch(/SELECT "id" FROM "OrganisationMember" WHERE "id" = \?\s*FOR UPDATE/);
    expect(values).toEqual(['member_the_admin']);
  });

  it('gives up when the member disappeared before the lock', async () => {
    mocks.memberLock.mockResolvedValue([]);

    await expect(apply()).rejects.toThrow(/Organisation member does not exist/);

    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  it('applies the move when the member is in the groups they were in', async () => {
    await apply();

    expect(mocks.groupMemberDelete.mock.calls[0][0].where).toEqual({
      organisationMemberId_groupId: {
        organisationMemberId: 'member_the_admin',
        groupId: 'group_internal_admin',
      },
    });

    expect(mocks.groupMemberCreate.mock.calls[0][0].data).toMatchObject({
      organisationMemberId: 'member_the_admin',
      groupId: 'group_internal_member',
    });
  });

  it('applies the move when a group the member keeps confers no more than the role being set', async () => {
    mocks.groupLock.mockResolvedValue([
      { id: 'group_custom_g', name: 'Deal desk', organisationRole: OrganisationMemberRole.MEMBER },
    ]);
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_admin' }, { groupId: 'group_custom_g' }]);

    await apply({ observedGroupIds: ['group_internal_admin', 'group_custom_g'] });

    expect(mocks.groupMemberCreate).toHaveBeenCalledTimes(1);
  });

  // A group they left can lower the role they end up with, never raise it, so it
  // cannot turn the demotion into a lie. Refusing on it would fail role changes
  // that are fine.
  it('applies the move when the member left a group since the check', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([]);

    await apply({ observedGroupIds: ['group_internal_admin', 'group_custom_member'] });

    expect(mocks.groupMemberCreate).toHaveBeenCalledTimes(1);
  });

  it('reads every group the member is in when no team is named', async () => {
    await apply();

    expect(mocks.groupMemberFindMany.mock.calls[0][0].where).toEqual({
      organisationMemberId: 'member_the_admin',
    });
  });

  // A team role comes from the groups linked to that team. Widening the re-read
  // to the whole organisation would refuse a team demotion over a group that has
  // nothing to do with the team.
  it('reads only the groups the team draws a role from when a team is named', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam();

    expect(mocks.groupMemberFindMany.mock.calls[0][0].where).toEqual({
      organisationMemberId: 'member_the_admin',
      group: { teamGroups: { some: { teamId: 7 } } },
    });
  });

  // The third door, and the one no row lock reaches on its own. Nobody touches
  // who is in what group, and no group is promoted. A group the member already
  // belongs to is linked to the team at ADMIN, which writes a TeamGroup row that
  // did not exist when the role change was judged. The member then holds a team
  // role the demotion never read, and the re-read only sees it because the Team
  // row is held while it runs.
  it('refuses a team role change when a group the member is in was linked to the team after the check', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([
      { groupId: 'group_internal_team_admin' },
      { groupId: 'group_custom_deal_desk' },
    ]);

    await expect(applyToTeam()).rejects.toThrow(/joined another group while the role change was being prepared/);

    expect(mocks.groupMemberDelete).not.toHaveBeenCalled();
    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  // A TeamGroup row that does not exist yet cannot be locked, so the lock goes on
  // the row the insert has to touch anyway. Inserting a TeamGroup takes a KEY
  // SHARE lock on its team through the foreign key, and FOR UPDATE is the only
  // mode that conflicts with KEY SHARE.
  it('takes an exclusive lock on the team before anything else', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam({ observedGroupIds: ['group_internal_team_admin', 'group_custom_g'] });

    const [fragments, ...values] = mocks.teamLock.mock.calls[0];

    expect(fragments.join('?')).toMatch(/SELECT "id" FROM "Team" WHERE "id" = \?\s*FOR UPDATE/);
    expect(values).toEqual([7]);
    expect(mocks.order[0]).toBe('team-lock');
  });

  // `deleteTeam` takes the team row and then its team groups by cascade, so a
  // team lock taken after the group lock gives the two a cycle to sit in.
  it('locks the team before the groups and the member', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam({ observedGroupIds: ['group_internal_team_admin', 'group_custom_g'] });

    expect(mocks.order).toEqual(['team-lock', 'group-lock', 'member-lock', 'read']);
  });

  it('gives up when the team disappeared before the lock', async () => {
    mocks.teamLock.mockResolvedValue([]);

    await expect(applyToTeam()).rejects.toThrow(/Team does not exist/);

    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  // An organisation role comes from no team, and locking one would hold up a
  // team for a change that cannot touch it.
  it('locks no team for an organisation role change', async () => {
    await apply();

    expect(mocks.teamLock).not.toHaveBeenCalled();
  });

  // The caller's authority was read before the transaction opened. Every team
  // role change on this team queues on the Team row, so re-reading the caller's
  // role behind that lock cannot go stale.
  it('refuses a team role change when the caller was demoted since their authority was checked', async () => {
    mocks.actorTeamGroups.mockResolvedValue([{ teamRole: TeamMemberRole.MANAGER }]);

    await expect(applyToTeam({ actor: { userId: 12, authorisedRole: TeamMemberRole.ADMIN } })).rejects.toThrow(
      /Your own role in this team changed while the role change was being prepared/,
    );

    expect(mocks.groupMemberDelete).not.toHaveBeenCalled();
    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  it('refuses a team role change when the caller was taken out of the team entirely', async () => {
    mocks.actorTeamGroups.mockResolvedValue([]);

    await expect(applyToTeam({ actor: { userId: 12, authorisedRole: TeamMemberRole.MEMBER } })).rejects.toThrow(
      /Your own role in this team changed/,
    );
  });

  it('applies the move when the caller still holds the role they were authorised at', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    mocks.actorTeamGroups.mockResolvedValue([{ teamRole: TeamMemberRole.MEMBER }, { teamRole: TeamMemberRole.ADMIN }]);

    await applyToTeam({ actor: { userId: 12, authorisedRole: TeamMemberRole.ADMIN } });

    expect(mocks.groupMemberCreate).toHaveBeenCalledTimes(1);
  });

  it('reads the caller’s role from the groups this team draws a role from', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam({ actor: { userId: 12, authorisedRole: TeamMemberRole.ADMIN } });

    expect(mocks.actorTeamGroups.mock.calls[0][0].where).toEqual({
      teamId: 7,
      organisationGroup: {
        organisationGroupMembers: {
          some: { organisationMember: { userId: 12 } },
        },
      },
    });
  });

  it('reads the caller’s role behind the team lock', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam({ actor: { userId: 12, authorisedRole: TeamMemberRole.ADMIN } });

    expect(mocks.order).toEqual(['team-lock', 'actor-pin', 'member-lock', 'actor-read', 'read']);
  });

  it('leaves the caller’s role alone when the route names no caller', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam();

    expect(mocks.actorTeamGroups).not.toHaveBeenCalled();
  });

  // The way out that the team lock does not cover. `applyOrganisationGroupUpdate`
  // takes the caller out of a custom group, which lowers what they hold in this
  // team without writing a single row the team lock orders. Their own membership
  // rows are the rows that removal has to delete, so holding those makes the
  // re-read above true until the commit.
  it('refuses when the caller was taken out of the group their authority rested on', async () => {
    mocks.actorTeamGroups.mockResolvedValue([{ teamRole: TeamMemberRole.MEMBER }]);

    await expect(applyToTeam({ actor: { userId: 12, authorisedRole: TeamMemberRole.ADMIN } })).rejects.toThrow(
      /Your own role in this team changed/,
    );

    expect(mocks.order).toEqual(['team-lock', 'actor-pin', 'member-lock', 'actor-read']);
    expect(mocks.groupMemberDelete).not.toHaveBeenCalled();
    expect(mocks.groupMemberCreate).not.toHaveBeenCalled();
  });

  it('holds the caller’s memberships in this team, in id order', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam({ actor: { userId: 12, authorisedRole: TeamMemberRole.ADMIN } });

    const [, ...values] = mocks.actorPin.mock.calls[0];

    expect(sqlOf(mocks.actorPin.mock.calls[0])).toMatch(
      /FROM "OrganisationGroupMember" INNER JOIN "OrganisationMember" .* INNER JOIN "TeamGroup" .* ORDER BY "OrganisationGroupMember"\."id" FOR SHARE OF "OrganisationGroupMember"/,
    );
    expect(values).toEqual([12, 7]);
  });

  // Taken after the member lock, a group update that removes the caller and adds
  // the member being demoted deadlocks with this every time: it holds the
  // caller's row and reaches for the member row through its insert's foreign
  // key, while we hold the member row and reach for the caller's row.
  it('pins the caller after the group lock and before the member lock', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam({
      observedGroupIds: ['group_internal_team_admin', 'group_custom_g'],
      actor: { userId: 12, authorisedRole: TeamMemberRole.ADMIN },
    });

    expect(mocks.order).toEqual(['team-lock', 'group-lock', 'actor-pin', 'member-lock', 'actor-read', 'read']);
  });

  // Two administrators demoting each other hold each other's rows and then reach
  // for them. In a team they queue on the Team row before either takes anything.
  // In an organisation there is no such row, and the pair deadlocks every time.
  it('pins nothing for an organisation role change', async () => {
    await apply();

    expect(mocks.actorPin).not.toHaveBeenCalled();
  });

  it('pins nothing when the route names no caller', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([{ groupId: 'group_internal_team_admin' }]);

    await applyToTeam();

    expect(mocks.actorPin).not.toHaveBeenCalled();
  });

  it('adds the member to the new group when they were in no internal group to leave', async () => {
    mocks.groupMemberFindMany.mockResolvedValue([]);

    await apply({ groupIdToRemove: undefined, observedGroupIds: [] });

    expect(mocks.groupMemberDelete).not.toHaveBeenCalled();
    expect(mocks.groupMemberCreate).toHaveBeenCalledTimes(1);
  });
});
