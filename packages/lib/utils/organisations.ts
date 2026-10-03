import type { ORGANISATION_MEMBER_ROLE_MAP } from '@documenso/lib/constants/organisations-translations';
import type { Organisation, OrganisationGlobalSettings, Prisma } from '@prisma/client';
import { DocumentVisibility, type OrganisationGroup, type OrganisationMemberRole } from '@prisma/client';

import { DEFAULT_DOCUMENT_DATE_FORMAT } from '../constants/date-formats';
import { DEFAULT_ENVELOPE_EXPIRATION_PERIOD } from '../constants/envelope-expiration';
import { DEFAULT_ENVELOPE_REMINDER_SETTINGS } from '../constants/envelope-reminder';
import {
  LOWEST_ORGANISATION_ROLE,
  ORGANISATION_MEMBER_ROLE_HIERARCHY,
  ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP,
} from '../constants/organisations';
import { AppError, AppErrorCode } from '../errors/app-error';
import { DEFAULT_DOCUMENT_EMAIL_SETTINGS } from '../types/document-email';

export const isPersonalLayout = (organisations: Pick<Organisation, 'type'>[]) => {
  return organisations.length === 1 && organisations[0].type === 'PERSONAL';
};

/**
 * Determines whether a team member can execute a given action.
 *
 * @param action The action the user is trying to execute.
 * @param role The current role of the user.
 * @returns Whether the user can execute the action.
 */
export const canExecuteOrganisationAction = (
  action: keyof typeof ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP,
  role: keyof typeof ORGANISATION_MEMBER_ROLE_MAP,
) => {
  return ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP[action].some((i) => i === role);
};

/**
 * Compares the provided `currentUserRole` with the provided `roleToCheck` to determine
 * whether the `currentUserRole` has permission to modify the `roleToCheck`.
 *
 * @param currentUserRole Role of the current user
 * @param roleToCheck Role of another user to see if the current user can modify
 * @returns True if the current user can modify the other user, false otherwise
 */
export const isOrganisationRoleWithinUserHierarchy = (
  currentUserRole: keyof typeof ORGANISATION_MEMBER_ROLE_MAP,
  roleToCheck: keyof typeof ORGANISATION_MEMBER_ROLE_MAP,
) => {
  return ORGANISATION_MEMBER_ROLE_HIERARCHY[currentUserRole].some((i) => i === roleToCheck);
};

/**
 * Rank a role by how far it reaches, so two roles can be compared directly.
 *
 * The hierarchy map lists, for each role, the roles it is allowed to act on, so
 * the length of that list is the rank. Written once here rather than spelled
 * out at every comparison.
 */
const organisationRoleRank = (role: OrganisationMemberRole): number => ORGANISATION_MEMBER_ROLE_HIERARCHY[role].length;

export type OrganisationRoleAssignment = {
  /** Role held by the person making the change. */
  actorRole: OrganisationMemberRole;
  /** Role or roles the change would confer. */
  rolesToAssign: OrganisationMemberRole[];
  /** Role the thing being changed carries today, where it carries one. */
  currentTargetRole?: OrganisationMemberRole;
  /** Whether the person making the change is the one the new role lands on. */
  isSelfAssignment?: boolean;
};

/**
 * The one rule for who may hand out which organisation role.
 *
 * Two things have to hold, and both are checked in this function so that no
 * caller has to remember them:
 *
 * 1. Nobody confers a role above their own. A manager who could mint an
 *    administrator would be an administrator by another route, because the
 *    administrator they made can do everything the manager cannot.
 * 2. Nobody raises their own role. Rule 1 forbids that already while the roles
 *    form a single ladder, and it is written out anyway, because the shape of
 *    the ladder is a property of a constant somebody will edit one day.
 *
 * Changing a role that outranks yours is refused first, for the same reason as
 * rule 1: the change would otherwise let you demote the people above you.
 *
 * @param options - the acting role, what would be conferred, and on whom
 * @throws {AppError} UNAUTHORIZED when the assignment is not permitted
 */
export const assertRoleAssignmentWithinHierarchy = ({
  actorRole,
  rolesToAssign,
  currentTargetRole,
  isSelfAssignment = false,
}: OrganisationRoleAssignment): void => {
  if (currentTargetRole && !isOrganisationRoleWithinUserHierarchy(actorRole, currentTargetRole)) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Cannot change an organisation role higher than your own',
    });
  }

  for (const roleToAssign of rolesToAssign) {
    // Asked before the general question, because both would refuse this and
    // only one of them says why.
    if (isSelfAssignment && organisationRoleRank(roleToAssign) > organisationRoleRank(actorRole)) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Cannot raise your own organisation role',
      });
    }

    if (!isOrganisationRoleWithinUserHierarchy(actorRole, roleToAssign)) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Cannot assign an organisation role higher than your own',
      });
    }
  }
};

/** A group that confers a role, named well enough for an administrator to find it. */
export type RoleConferringGroup<TRole extends string> = {
  id: string;
  name: string | null;
  role: TRole;
};

export type RoleChangeEffect<TRole extends string> = {
  /** The role the change is meant to leave the person holding. */
  requestedRole: TRole;
  /** Every group the person keeps, meaning all of them bar the one this change rewrites. */
  retainedGroups: RoleConferringGroup<TRole>[];
  /** Ranks a role by how far it reaches, so two roles can be compared. */
  rankRole: (role: TRole) => number;
};

/**
 * Refuse a role change that the person would walk straight out of.
 *
 * A member's effective role is the highest one any of their groups confers, but
 * a role update rewrites a single internal group membership. Someone who holds
 * ADMIN through a custom group therefore stayed an administrator after being
 * demoted to MEMBER, and the route returned success, so the administrator who
 * did it had no way of knowing. On a signing platform that is the difference
 * between believing you have withdrawn someone's authority to countersign and
 * having withdrawn it.
 *
 * Refusing is the right answer rather than quietly stripping the other groups.
 * Those groups exist for reasons this route cannot see, and an administrator who
 * is told which ones stand in the way can decide what to do about them. The
 * message names them for that reason.
 *
 * The same rule catches a promotion that would not take effect either, which is
 * a smaller problem and the same lie.
 *
 * @param options - the role being requested, what the member keeps, and how to rank a role
 * @throws {AppError} INVALID_REQUEST when another group would override the new role
 */
export const assertRoleChangeTakesEffect = <TRole extends string>({
  requestedRole,
  retainedGroups,
  rankRole,
}: RoleChangeEffect<TRole>): void => {
  const overridingGroups = retainedGroups.filter((group) => rankRole(group.role) > rankRole(requestedRole));

  if (overridingGroups.length === 0) {
    return;
  }

  const description = overridingGroups.map((group) => `${group.name ?? group.id} (${group.role})`).join(', ');

  throw new AppError(AppErrorCode.INVALID_REQUEST, {
    message: `Setting the role to ${requestedRole} would have no effect, because the member holds a higher role through ${description}. Remove them from those groups first.`,
  });
};

export type OrganisationRoleChangeEffect = {
  /** The role the change is meant to leave the member holding. */
  requestedRole: OrganisationMemberRole;
  /** The member's groups other than the internal organisation group being rewritten. */
  retainedGroups: Pick<OrganisationGroup, 'id' | 'name' | 'organisationRole'>[];
};

/**
 * Refuse an organisation role change the member's other groups would override.
 *
 * @param options - the requested role and the groups the member keeps
 * @throws {AppError} INVALID_REQUEST when another group would override the new role
 */
export const assertOrganisationRoleChangeTakesEffect = ({
  requestedRole,
  retainedGroups,
}: OrganisationRoleChangeEffect): void => {
  assertRoleChangeTakesEffect({
    requestedRole,
    retainedGroups: retainedGroups.map(({ id, name, organisationRole }) => ({ id, name, role: organisationRole })),
    rankRole: organisationRoleRank,
  });
};

export const getHighestOrganisationRoleInGroup = (
  groups: Pick<OrganisationGroup, 'type' | 'organisationRole'>[],
): OrganisationMemberRole => {
  let highestOrganisationRole: OrganisationMemberRole = LOWEST_ORGANISATION_ROLE;

  groups.forEach((group) => {
    const currentRolePriority = ORGANISATION_MEMBER_ROLE_HIERARCHY[group.organisationRole].length;
    const highestOrganisationRolePriority = ORGANISATION_MEMBER_ROLE_HIERARCHY[highestOrganisationRole].length;

    if (currentRolePriority > highestOrganisationRolePriority) {
      highestOrganisationRole = group.organisationRole;
    }
  });

  return highestOrganisationRole;
};

type BuildOrganisationWhereQueryOptions = {
  organisationId: string | undefined;
  userId: number;
  roles?: OrganisationMemberRole[];
};

export const buildOrganisationWhereQuery = ({
  organisationId,
  userId,
  roles,
}: BuildOrganisationWhereQueryOptions): Prisma.OrganisationWhereInput => {
  // Note: Not using inline ternary since typesafety breaks for some reason.
  if (!roles) {
    return {
      id: organisationId,
      members: {
        some: {
          userId,
        },
      },
    };
  }

  return {
    id: organisationId,
    members: {
      some: {
        userId,
        organisationGroupMembers: {
          some: {
            group: {
              organisationRole: {
                in: roles,
              },
            },
          },
        },
      },
    },
  };
};

export const generateDefaultOrganisationSettings = (): Omit<OrganisationGlobalSettings, 'id' | 'organisation'> => {
  return {
    documentVisibility: DocumentVisibility.EVERYONE,
    documentLanguage: 'en',
    documentTimezone: null, // Null means local timezone.
    documentDateFormat: DEFAULT_DOCUMENT_DATE_FORMAT,
    delegateDocumentOwnership: false,

    includeSenderDetails: true,
    includeSigningCertificate: true,
    includeAuditLog: false,

    typedSignatureEnabled: true,
    uploadSignatureEnabled: true,
    drawSignatureEnabled: true,

    brandingEnabled: false,
    brandingLogo: '',
    brandingUrl: '',
    brandingCompanyDetails: '',
    brandingColors: null,
    brandingCss: '',

    emailId: null,
    emailReplyTo: null,
    // emailReplyToName: null,
    emailDocumentSettings: DEFAULT_DOCUMENT_EMAIL_SETTINGS,

    defaultRecipients: null,

    envelopeExpirationPeriod: DEFAULT_ENVELOPE_EXPIRATION_PERIOD,

    reminderSettings: DEFAULT_ENVELOPE_REMINDER_SETTINGS,

    aiFeaturesEnabled: false,
  };
};
