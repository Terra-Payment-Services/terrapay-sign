import { TeamMemberRole } from '@documenso/prisma/generated/types';
import { describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error';
import { assertTeamRoleChangeTakesEffect } from './teams';

const { ADMIN, MANAGER, MEMBER } = TeamMemberRole;

const group = (organisationGroupId: string, name: string | null, teamRole: TeamMemberRole) => ({
  organisationGroupId,
  name,
  teamRole,
});

describe('assertTeamRoleChangeTakesEffect', () => {
  // Same defect as the organisation one. `getMemberRoles` reads the highest team
  // role across every group, and the write rewrites one internal team group, so
  // a member who reaches ADMIN through a custom group kept it while the route
  // reported the demotion as done.
  it('refuses a demotion the member holds through a custom team group', () => {
    expect(() =>
      assertTeamRoleChangeTakesEffect({
        requestedRole: MEMBER,
        retainedGroups: [group('group_signers', 'Signers', ADMIN)],
      }),
    ).toThrow(/would have no effect/);
  });

  it('names the team group that would still confer the role', () => {
    expect(() =>
      assertTeamRoleChangeTakesEffect({
        requestedRole: MEMBER,
        retainedGroups: [group('group_signers', 'Signers', ADMIN)],
      }),
    ).toThrow(/Signers \(ADMIN\)/);
  });

  it('allows a demotion when nothing else outranks the new role', () => {
    expect(() =>
      assertTeamRoleChangeTakesEffect({
        requestedRole: MANAGER,
        retainedGroups: [group('group_all', 'Everyone', MEMBER)],
      }),
    ).not.toThrow();
  });

  it('allows a change when the member is in no other team group', () => {
    expect(() => assertTeamRoleChangeTakesEffect({ requestedRole: MEMBER, retainedGroups: [] })).not.toThrow();
  });

  it('refuses a promotion that a custom ADMIN group would override', () => {
    expect(() =>
      assertTeamRoleChangeTakesEffect({
        requestedRole: MANAGER,
        retainedGroups: [group('group_signers', 'Signers', ADMIN)],
      }),
    ).toThrow(/would have no effect/);
  });

  it('raises an INVALID_REQUEST application error', () => {
    const error = (() => {
      try {
        assertTeamRoleChangeTakesEffect({
          requestedRole: MEMBER,
          retainedGroups: [group('group_signers', 'Signers', ADMIN)],
        });

        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(AppError);
    expect(AppError.parseError(error).code).toBe('INVALID_REQUEST');
  });
});
