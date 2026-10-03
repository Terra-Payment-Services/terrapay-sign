import { DocumentVisibility, EnvelopeType, TeamMemberRole, TemplateType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  envelopeFindFirst: vi.fn(),
  teamFindFirst: vi.fn(),
  teamGroupFindMany: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: { findFirst: mocks.envelopeFindFirst },
    team: { findFirst: mocks.teamFindFirst },
    teamGroup: { findMany: mocks.teamGroupFindMany },
  },
}));

import { checkEnvelopeFileAccess } from './check-envelope-file-access';

const OWNER_ID = 41;
const REQUESTER_ID = 42;

type EnvelopeOverrides = Partial<{
  userId: number;
  teamId: number;
  type: EnvelopeType;
  templateType: TemplateType;
  visibility: DocumentVisibility;
  ownerEmail: string;
  organisationId: string;
}>;

const stubEnvelope = (overrides: EnvelopeOverrides = {}) => {
  const {
    userId = OWNER_ID,
    teamId = 7,
    type = EnvelopeType.DOCUMENT,
    templateType = TemplateType.PRIVATE,
    visibility = DocumentVisibility.ADMIN,
    ownerEmail = 'owner@terrapay.com',
    organisationId = 'org_terrapay',
  } = overrides;

  mocks.envelopeFindFirst.mockResolvedValue({
    userId,
    teamId,
    type,
    templateType,
    visibility,
    user: { email: ownerEmail },
    team: { organisationId },
  });
};

/** The requester is a member of the envelope's team, holding the given roles. */
const stubMembership = (roles: TeamMemberRole[], teamEmail: string | null = null) => {
  mocks.teamFindFirst.mockResolvedValue({
    teamEmail: teamEmail === null ? null : { email: teamEmail },
    teamGroups: roles.map((teamRole) => ({ teamRole })),
  });
};

/** The requester belongs to no team that matches the envelope's team. */
const stubNoMembership = () => {
  mocks.teamFindFirst.mockResolvedValue(null);
};

const check = () => checkEnvelopeFileAccess({ userId: REQUESTER_ID, envelopeId: 'envelope_hr_contract' });

describe('checkEnvelopeFileAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.teamGroupFindMany.mockResolvedValue([]);
  });

  // The advisory. Documenso's own list and detail queries filter on visibility;
  // the file route did not, so the lowest-role member of Legal could pull the
  // raw bytes of a contract restricted to team administrators.
  it('refuses the bytes to a team member whose role is below the visibility threshold', async () => {
    stubEnvelope({ visibility: DocumentVisibility.ADMIN });
    stubMembership([TeamMemberRole.MEMBER]);

    await expect(check()).resolves.toBe(false);
  });

  it('refuses a manager an admin-only envelope', async () => {
    stubEnvelope({ visibility: DocumentVisibility.ADMIN });
    stubMembership([TeamMemberRole.MANAGER]);

    await expect(check()).resolves.toBe(false);
  });

  it('serves an admin the same envelope', async () => {
    stubEnvelope({ visibility: DocumentVisibility.ADMIN });
    stubMembership([TeamMemberRole.ADMIN]);

    await expect(check()).resolves.toBe(true);
  });

  it('serves a manager an envelope visible to managers and above', async () => {
    stubEnvelope({ visibility: DocumentVisibility.MANAGER_AND_ABOVE });
    stubMembership([TeamMemberRole.MANAGER]);

    await expect(check()).resolves.toBe(true);
  });

  it('refuses a member an envelope visible to managers and above', async () => {
    stubEnvelope({ visibility: DocumentVisibility.MANAGER_AND_ABOVE });
    stubMembership([TeamMemberRole.MEMBER]);

    await expect(check()).resolves.toBe(false);
  });

  it('serves a member an envelope visible to everyone', async () => {
    stubEnvelope({ visibility: DocumentVisibility.EVERYONE });
    stubMembership([TeamMemberRole.MEMBER]);

    await expect(check()).resolves.toBe(true);
  });

  // The effective role is the highest across every group, matching
  // getHighestTeamRoleInGroup. A member who also sits in a custom admin group
  // must not be held to the member threshold.
  it('takes the highest role the member holds across their team groups', async () => {
    stubEnvelope({ visibility: DocumentVisibility.ADMIN });
    stubMembership([TeamMemberRole.MEMBER, TeamMemberRole.ADMIN]);

    await expect(check()).resolves.toBe(true);
  });

  // getEnvelopeWhereInput lets the owner open their own document whatever the
  // visibility, so the file has to follow.
  it('serves the owner their own envelope above their role threshold', async () => {
    stubEnvelope({ userId: REQUESTER_ID, visibility: DocumentVisibility.ADMIN });
    stubMembership([TeamMemberRole.MEMBER]);

    await expect(check()).resolves.toBe(true);
  });

  // Ownership alone is not enough. getEnvelopeWhereInput resolves the team
  // first and throws when the caller is not in it, so a former member who still
  // owns the envelope gets nothing.
  it('refuses the owner once they have left the team', async () => {
    stubEnvelope({ userId: REQUESTER_ID, visibility: DocumentVisibility.ADMIN });
    stubNoMembership();

    await expect(check()).resolves.toBe(false);
  });

  it('serves any member an envelope sent from the team inbox', async () => {
    stubEnvelope({ visibility: DocumentVisibility.ADMIN, ownerEmail: 'legal@terrapay.com' });
    stubMembership([TeamMemberRole.MEMBER], 'legal@terrapay.com');

    await expect(check()).resolves.toBe(true);
  });

  it('refuses a member when the team inbox is a different address to the owner', async () => {
    stubEnvelope({ visibility: DocumentVisibility.ADMIN, ownerEmail: 'owner@terrapay.com' });
    stubMembership([TeamMemberRole.MEMBER], 'legal@terrapay.com');

    await expect(check()).resolves.toBe(false);
  });

  it('refuses a stranger to the team', async () => {
    stubEnvelope({ visibility: DocumentVisibility.EVERYONE });
    stubNoMembership();

    await expect(check()).resolves.toBe(false);
  });

  it('refuses an envelope that does not exist', async () => {
    mocks.envelopeFindFirst.mockResolvedValue(null);
    stubMembership([TeamMemberRole.ADMIN]);

    await expect(check()).resolves.toBe(false);
  });

  describe('organisation templates', () => {
    const stubOrganisationTemplate = (visibility: DocumentVisibility) =>
      stubEnvelope({
        type: EnvelopeType.TEMPLATE,
        templateType: TemplateType.ORGANISATION,
        visibility,
      });

    // An organisation template is readable from any team in the organisation,
    // which is why membership of the template's own team is not required. The
    // role still has to reach the visibility, as getOrganisationTemplateById
    // enforces.
    it('serves a template to an admin of another team in the same organisation', async () => {
      stubOrganisationTemplate(DocumentVisibility.ADMIN);
      stubNoMembership();
      mocks.teamGroupFindMany.mockResolvedValue([{ teamRole: TeamMemberRole.ADMIN }]);

      await expect(check()).resolves.toBe(true);
    });

    it('refuses an admin-only template to someone who is only a member elsewhere', async () => {
      stubOrganisationTemplate(DocumentVisibility.ADMIN);
      stubNoMembership();
      mocks.teamGroupFindMany.mockResolvedValue([{ teamRole: TeamMemberRole.MEMBER }]);

      await expect(check()).resolves.toBe(false);
    });

    it('refuses a template to someone in no team of the organisation', async () => {
      stubOrganisationTemplate(DocumentVisibility.EVERYONE);
      stubNoMembership();
      mocks.teamGroupFindMany.mockResolvedValue([]);

      await expect(check()).resolves.toBe(false);
    });

    // A private template is not an organisation-wide artefact, so the
    // cross-team branch must not open it.
    it('refuses a private template to an admin of another team', async () => {
      stubEnvelope({
        type: EnvelopeType.TEMPLATE,
        templateType: TemplateType.PRIVATE,
        visibility: DocumentVisibility.EVERYONE,
      });
      stubNoMembership();
      mocks.teamGroupFindMany.mockResolvedValue([{ teamRole: TeamMemberRole.ADMIN }]);

      await expect(check()).resolves.toBe(false);
    });

    it('does not query organisation roles for an ordinary document', async () => {
      stubEnvelope({ visibility: DocumentVisibility.EVERYONE });
      stubMembership([TeamMemberRole.MEMBER]);

      await check();

      expect(mocks.teamGroupFindMany).not.toHaveBeenCalled();
    });
  });
});
