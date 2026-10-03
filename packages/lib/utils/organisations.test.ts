import { OrganisationMemberRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error';
import { assertOrganisationRoleChangeTakesEffect, assertRoleAssignmentWithinHierarchy } from './organisations';

const { ADMIN, MANAGER, MEMBER } = OrganisationMemberRole;

describe('assertRoleAssignmentWithinHierarchy', () => {
  describe('nobody confers a role above their own', () => {
    it('refuses a manager making somebody an administrator', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({
          actorRole: MANAGER,
          rolesToAssign: [ADMIN],
          currentTargetRole: MEMBER,
        }),
      ).toThrow(AppError);
    });

    it('refuses a member conferring any role above their own', () => {
      expect(() => assertRoleAssignmentWithinHierarchy({ actorRole: MEMBER, rolesToAssign: [MANAGER] })).toThrow(
        /higher than your own/,
      );

      expect(() => assertRoleAssignmentWithinHierarchy({ actorRole: MEMBER, rolesToAssign: [ADMIN] })).toThrow(
        /higher than your own/,
      );
    });

    it('refuses the whole batch when one role in it is out of reach', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({ actorRole: MANAGER, rolesToAssign: [MEMBER, MEMBER, ADMIN] }),
      ).toThrow(/higher than your own/);
    });

    it('allows a manager to confer the roles at or below their own', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({ actorRole: MANAGER, rolesToAssign: [MANAGER, MEMBER] }),
      ).not.toThrow();
    });

    it('allows an administrator to confer anything', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({ actorRole: ADMIN, rolesToAssign: [ADMIN, MANAGER, MEMBER] }),
      ).not.toThrow();
    });
  });

  describe('nobody raises their own role', () => {
    it('refuses a manager promoting themselves, and says that is the reason', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({
          actorRole: MANAGER,
          rolesToAssign: [ADMIN],
          currentTargetRole: MANAGER,
          isSelfAssignment: true,
        }),
      ).toThrow(/raise your own organisation role/);
    });

    it('allows somebody to step down', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({
          actorRole: ADMIN,
          rolesToAssign: [MEMBER],
          currentTargetRole: ADMIN,
          isSelfAssignment: true,
        }),
      ).not.toThrow();
    });

    it('allows somebody to reassert the role they already hold', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({
          actorRole: MANAGER,
          rolesToAssign: [MANAGER],
          currentTargetRole: MANAGER,
          isSelfAssignment: true,
        }),
      ).not.toThrow();
    });
  });

  describe('nobody changes a role above their own', () => {
    it('refuses a manager touching an administrator, whatever the new role would be', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({
          actorRole: MANAGER,
          rolesToAssign: [MEMBER],
          currentTargetRole: ADMIN,
        }),
      ).toThrow(/Cannot change an organisation role higher than your own/);
    });

    it('allows a manager to change another manager', () => {
      expect(() =>
        assertRoleAssignmentWithinHierarchy({
          actorRole: MANAGER,
          rolesToAssign: [MEMBER],
          currentTargetRole: MANAGER,
        }),
      ).not.toThrow();
    });
  });

  it('raises an UNAUTHORIZED application error rather than a bare Error', () => {
    const error = (() => {
      try {
        assertRoleAssignmentWithinHierarchy({ actorRole: MANAGER, rolesToAssign: [ADMIN] });

        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(AppError);
    expect(AppError.parseError(error).code).toBe('UNAUTHORIZED');
  });
});

const group = (id: string, name: string | null, organisationRole: OrganisationMemberRole) => ({
  id,
  name,
  organisationRole,
});

describe('assertOrganisationRoleChangeTakesEffect', () => {
  // The exact sequence Codex reported. The target holds ADMIN through a custom
  // group and MEMBER through the internal one. An administrator demotes them to
  // MEMBER, the route rewrites the internal membership and returns success, and
  // `getMemberOrganisationRole` still answers ADMIN. On this platform an
  // organisation ADMIN can send and countersign contracts and read every
  // document, so the administrator has been told they withdrew signing
  // authority when they did not.
  it('refuses a demotion the target holds through a custom group', () => {
    expect(() =>
      assertOrganisationRoleChangeTakesEffect({
        requestedRole: MEMBER,
        retainedGroups: [group('group_contract_owners', 'Contract owners', ADMIN)],
      }),
    ).toThrow(/would have no effect/);
  });

  it('names the group that would still confer the role, so the refusal is actionable', () => {
    expect(() =>
      assertOrganisationRoleChangeTakesEffect({
        requestedRole: MEMBER,
        retainedGroups: [group('group_contract_owners', 'Contract owners', ADMIN)],
      }),
    ).toThrow(/Contract owners \(ADMIN\)/);
  });

  it('names every group standing in the way, not just the first', () => {
    const error = (() => {
      try {
        assertOrganisationRoleChangeTakesEffect({
          requestedRole: MEMBER,
          retainedGroups: [
            group('group_a', 'Contract owners', ADMIN),
            group('group_b', 'Deal desk', MANAGER),
            group('group_c', 'Everyone', MEMBER),
          ],
        });

        return null;
      } catch (err) {
        return err;
      }
    })();

    const { message } = AppError.parseError(error);

    expect(message).toContain('Contract owners (ADMIN)');
    expect(message).toContain('Deal desk (MANAGER)');
    // MEMBER does not outrank the requested role, so it is not in the way.
    expect(message).not.toContain('Everyone');
  });

  it('falls back to the group id when the group has no name', () => {
    expect(() =>
      assertOrganisationRoleChangeTakesEffect({
        requestedRole: MEMBER,
        retainedGroups: [group('group_unnamed', null, ADMIN)],
      }),
    ).toThrow(/group_unnamed \(ADMIN\)/);
  });

  it('allows a demotion when the target is in no other group', () => {
    expect(() => assertOrganisationRoleChangeTakesEffect({ requestedRole: MEMBER, retainedGroups: [] })).not.toThrow();
  });

  it('allows a demotion when the other groups confer no more than the new role', () => {
    expect(() =>
      assertOrganisationRoleChangeTakesEffect({
        requestedRole: MANAGER,
        retainedGroups: [group('group_a', 'Deal desk', MANAGER), group('group_b', 'Everyone', MEMBER)],
      }),
    ).not.toThrow();
  });

  // A promotion that would not take effect is the same lie in a smaller
  // register, and the rule catches it without being told about it separately.
  it('refuses a promotion to MANAGER that a custom ADMIN group would override', () => {
    expect(() =>
      assertOrganisationRoleChangeTakesEffect({
        requestedRole: MANAGER,
        retainedGroups: [group('group_a', 'Contract owners', ADMIN)],
      }),
    ).toThrow(/would have no effect/);
  });

  it('allows a promotion to ADMIN, which nothing can outrank', () => {
    expect(() =>
      assertOrganisationRoleChangeTakesEffect({
        requestedRole: ADMIN,
        retainedGroups: [group('group_a', 'Contract owners', ADMIN)],
      }),
    ).not.toThrow();
  });

  it('raises an INVALID_REQUEST application error, since this is not an authorisation failure', () => {
    const error = (() => {
      try {
        assertOrganisationRoleChangeTakesEffect({
          requestedRole: MEMBER,
          retainedGroups: [group('group_a', 'Contract owners', ADMIN)],
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
