import { OrganisationMemberRole, OrganisationType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  organisationFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  addUserToOrganisation: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    organisation: { findMany: mocks.organisationFindMany },
    organisationMember: { findFirst: mocks.memberFindFirst },
  },
}));

vi.mock('./accept-organisation-invitation', () => ({ addUserToOrganisation: mocks.addUserToOrganisation }));

vi.mock('../../utils/logger', () => ({ logger: { warn: mocks.warn } }));

import { addUserToSoleOrganisation } from './add-user-to-sole-organisation';

const groups = [{ id: 'org_group_member', type: 'INTERNAL_ORGANISATION', organisationRole: 'MEMBER' }];

const terrapay = { id: 'org_terrapay', groups };

describe('addUserToSoleOrganisation', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.memberFindFirst.mockResolvedValue(null);
    mocks.addUserToOrganisation.mockResolvedValue(undefined);
  });

  // Admins would otherwise be mailed for every new staff member; real invites still mail them.
  it('adds the user as a member of the only organisation, through its groups, without mailing admins', async () => {
    mocks.organisationFindMany.mockResolvedValue([terrapay]);

    await expect(addUserToSoleOrganisation({ userId: 9 })).resolves.toBe('added');

    expect(mocks.addUserToOrganisation).toHaveBeenCalledWith({
      userId: 9,
      organisationId: 'org_terrapay',
      organisationGroups: groups,
      organisationMemberRole: OrganisationMemberRole.MEMBER,
      bypassEmail: true,
    });
  });

  it('counts only real organisations, not personal ones', async () => {
    mocks.organisationFindMany.mockResolvedValue([terrapay]);

    await addUserToSoleOrganisation({ userId: 9 });

    expect(mocks.organisationFindMany.mock.calls[0][0].where).toEqual({ type: OrganisationType.ORGANISATION });
  });

  it('adds nobody and warns when there is no organisation', async () => {
    mocks.organisationFindMany.mockResolvedValue([]);

    await expect(addUserToSoleOrganisation({ userId: 9 })).resolves.toBe('skipped');

    expect(mocks.addUserToOrganisation).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, organisationCount: 0 }));
  });

  it('adds nobody and warns rather than guess when there are two organisations', async () => {
    mocks.organisationFindMany.mockResolvedValue([terrapay, { id: 'org_other', groups }]);

    await expect(addUserToSoleOrganisation({ userId: 9 })).resolves.toBe('skipped');

    expect(mocks.addUserToOrganisation).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, organisationCount: 2 }));
  });

  it('leaves an existing member alone', async () => {
    mocks.organisationFindMany.mockResolvedValue([terrapay]);
    mocks.memberFindFirst.mockResolvedValue({ id: 'member_1' });

    await expect(addUserToSoleOrganisation({ userId: 9 })).resolves.toBe('already-member');

    expect(mocks.addUserToOrganisation).not.toHaveBeenCalled();
  });

  it('treats losing a race on the membership constraint as already a member', async () => {
    mocks.organisationFindMany.mockResolvedValue([terrapay]);
    mocks.addUserToOrganisation.mockRejectedValue(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));

    await expect(addUserToSoleOrganisation({ userId: 9 })).resolves.toBe('already-member');
  });

  it('passes any other failure on', async () => {
    mocks.organisationFindMany.mockResolvedValue([terrapay]);
    mocks.addUserToOrganisation.mockRejectedValue(new Error('Organisation group not found'));

    await expect(addUserToSoleOrganisation({ userId: 9 })).rejects.toThrow(/group not found/);
  });
});
