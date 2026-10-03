import { type TeamGroup, TeamMemberRole } from '@documenso/prisma/generated/types';
import type { DocumentVisibility, OrganisationGlobalSettings, Prisma, TeamGlobalSettings } from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../constants/app';
import {
  LOWEST_TEAM_ROLE,
  TEAM_DOCUMENT_VISIBILITY_MAP,
  TEAM_MEMBER_ROLE_HIERARCHY,
  TEAM_MEMBER_ROLE_PERMISSIONS_MAP,
} from '../constants/teams';
import type { TEAM_MEMBER_ROLE_MAP } from '../constants/teams-translations';
import { assertRoleChangeTakesEffect } from './organisations';

/**
 * Workaround for E2E tests to not import `msg`.
 */
export enum DocumentSignatureType {
  DRAW = 'draw',
  TYPE = 'type',
  UPLOAD = 'upload',
}

export const formatTeamUrl = (teamUrl: string, baseUrl?: string) => {
  const formattedBaseUrl = (baseUrl ?? NEXT_PUBLIC_WEBAPP_URL()).replace(/https?:\/\//, '');

  return `${formattedBaseUrl}/t/${teamUrl}`;
};

export const formatDocumentsPath = (teamUrl: string) => {
  return `/t/${teamUrl}/documents`;
};

export const formatTemplatesPath = (teamUrl: string) => {
  return `/t/${teamUrl}/templates`;
};

/**
 * Determines whether a team member can execute a given action.
 *
 * @param action The action the user is trying to execute.
 * @param role The current role of the user.
 * @returns Whether the user can execute the action.
 */
export const canExecuteTeamAction = (
  action: keyof typeof TEAM_MEMBER_ROLE_PERMISSIONS_MAP,
  role: keyof typeof TEAM_MEMBER_ROLE_MAP,
) => {
  return TEAM_MEMBER_ROLE_PERMISSIONS_MAP[action].some((i) => i === role);
};

/**
 * Determines whether a team role can access the visibility of a document.
 *
 * @param action The action the user is trying to execute.
 * @param role The current role of the user.
 * @returns Whether the user can execute the action.
 */
export const canAccessTeamDocument = (role: TeamMemberRole, visibility: DocumentVisibility) => {
  return TEAM_DOCUMENT_VISIBILITY_MAP[role].some((i) => i === visibility);
};

/**
 * Compares the provided `currentUserRole` with the provided `roleToCheck` to determine
 * whether the `currentUserRole` has permission to modify the `roleToCheck`.
 *
 * @param currentUserRole Role of the current user
 * @param roleToCheck Role of another user to see if the current user can modify
 * @returns True if the current user can modify the other user, false otherwise
 */
export const isTeamRoleWithinUserHierarchy = (
  currentUserRole: keyof typeof TEAM_MEMBER_ROLE_MAP,
  roleToCheck: keyof typeof TEAM_MEMBER_ROLE_MAP,
) => {
  return TEAM_MEMBER_ROLE_HIERARCHY[currentUserRole].some((i) => i === roleToCheck);
};

export const getHighestTeamRoleInGroup = (groups: Pick<TeamGroup, 'teamRole'>[]): TeamMemberRole => {
  let highestTeamRole: TeamMemberRole = LOWEST_TEAM_ROLE;

  groups.forEach((group) => {
    const currentRolePriority = TEAM_MEMBER_ROLE_HIERARCHY[group.teamRole].length;
    const highestTeamRolePriority = TEAM_MEMBER_ROLE_HIERARCHY[highestTeamRole].length;

    if (currentRolePriority > highestTeamRolePriority) {
      highestTeamRole = group.teamRole;
    }
  });

  return highestTeamRole;
};

/** Ranks a team role by how far it reaches, so two roles can be compared directly. */
const teamRoleRank = (role: TeamMemberRole): number => TEAM_MEMBER_ROLE_HIERARCHY[role].length;

export type TeamRoleChangeEffect = {
  /** The role the change is meant to leave the member holding. */
  requestedRole: TeamMemberRole;
  /** The member's team groups other than the internal one being rewritten. */
  retainedGroups: { organisationGroupId: string; name: string | null; teamRole: TeamMemberRole }[];
};

/**
 * Refuse a team role change the member's other team groups would override.
 *
 * Same defect as the organisation one, same reasoning. A team role update
 * rewrites one internal team group membership while the effective role is read
 * across every group, so a member who reaches ADMIN through a custom group kept
 * it after being demoted, and the route said the demotion had worked.
 *
 * @param options - the requested role and the team groups the member keeps
 * @throws {AppError} INVALID_REQUEST when another group would override the new role
 */
export const assertTeamRoleChangeTakesEffect = ({ requestedRole, retainedGroups }: TeamRoleChangeEffect): void => {
  assertRoleChangeTakesEffect({
    requestedRole,
    retainedGroups: retainedGroups.map(({ organisationGroupId, name, teamRole }) => ({
      id: organisationGroupId,
      name,
      role: teamRole,
    })),
    rankRole: teamRoleRank,
  });
};

export const extractTeamSignatureSettings = (
  settings?: {
    typedSignatureEnabled: boolean | null;
    drawSignatureEnabled: boolean | null;
    uploadSignatureEnabled: boolean | null;
  } | null,
) => {
  if (!settings) {
    return [DocumentSignatureType.TYPE, DocumentSignatureType.UPLOAD, DocumentSignatureType.DRAW];
  }

  const signatureTypes: DocumentSignatureType[] = [];

  if (settings.typedSignatureEnabled) {
    signatureTypes.push(DocumentSignatureType.TYPE);
  }

  if (settings.drawSignatureEnabled) {
    signatureTypes.push(DocumentSignatureType.DRAW);
  }

  if (settings.uploadSignatureEnabled) {
    signatureTypes.push(DocumentSignatureType.UPLOAD);
  }

  return signatureTypes;
};

export type BuildTeamWhereQueryOptions = {
  teamId: number | undefined;
  userId: number;
  roles?: TeamMemberRole[];
};

export const buildTeamWhereQuery = ({
  teamId,
  userId,
  roles,
}: BuildTeamWhereQueryOptions): Prisma.TeamWhereUniqueInput => {
  // Note: Not using inline ternary since typesafety breaks for some reason.
  if (!roles) {
    return {
      id: teamId,
      teamGroups: {
        some: {
          organisationGroup: {
            organisationGroupMembers: {
              some: {
                organisationMember: {
                  userId,
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    id: teamId,
    teamGroups: {
      some: {
        organisationGroup: {
          organisationGroupMembers: {
            some: {
              organisationMember: {
                userId,
              },
            },
          },
        },
        teamRole: {
          in: roles,
        },
      },
    },
  };
};

/**
 * Majority of these are null which lets us inherit from the organisation settings.
 */
export const generateDefaultTeamSettings = (): Omit<TeamGlobalSettings, 'id' | 'team'> => {
  return {
    documentVisibility: null,
    documentLanguage: null,
    documentTimezone: null,
    documentDateFormat: null,
    delegateDocumentOwnership: null,

    includeSenderDetails: null,
    includeSigningCertificate: null,
    includeAuditLog: null,

    typedSignatureEnabled: null,
    uploadSignatureEnabled: null,
    drawSignatureEnabled: null,

    brandingEnabled: null,
    brandingLogo: null,
    brandingUrl: null,
    brandingCompanyDetails: null,
    brandingColors: null,
    brandingCss: null,

    emailDocumentSettings: null,
    emailId: null,
    emailReplyTo: null,
    // emailReplyToName: null,

    defaultRecipients: null,

    envelopeExpirationPeriod: null,

    reminderSettings: null,

    aiFeaturesEnabled: null,
  };
};

/**
 * Derive the final settings for a team.
 *
 * @param organisationSettings The organisation settings to inherit values from
 * @param teamSettings The team settings which can override the organisation settings
 */
export const extractDerivedTeamSettings = (
  organisationSettings: Omit<OrganisationGlobalSettings, 'id'>,
  teamSettings: Omit<TeamGlobalSettings, 'id'>,
): Omit<OrganisationGlobalSettings, 'id'> => {
  const derivedSettings: Omit<OrganisationGlobalSettings, 'id'> = {
    ...organisationSettings,
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  for (const key of Object.keys(derivedSettings) as (keyof typeof derivedSettings)[]) {
    const teamValue = teamSettings[key];

    if (teamValue !== null) {
      // @ts-expect-error Should work
      derivedSettings[key] = teamValue;
    }
  }

  return derivedSettings;
};

export const isMemberManagerOrAbove = (role: TeamMemberRole) => {
  return role === TeamMemberRole.ADMIN || role === TeamMemberRole.MANAGER;
};

export const isMemberAdmin = (role: TeamMemberRole) => {
  return role === TeamMemberRole.ADMIN;
};
