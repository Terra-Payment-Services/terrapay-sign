import { OrganisationGroupType, OrganisationMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ memberCreate: vi.fn(), triggerJob: vi.fn() }));

vi.mock('@documenso/prisma', () => ({ prisma: { organisationMember: { create: mocks.memberCreate } } }));

vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: mocks.triggerJob } }));

import { addUserToOrganisation } from './accept-organisation-invitation';

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const groups = [
  {
    id: 'group_member',
    type: OrganisationGroupType.INTERNAL_ORGANISATION,
    organisationRole: OrganisationMemberRole.MEMBER,
  },
] as Parameters<typeof addUserToOrganisation>[0]['organisationGroups'];

const options = {
  userId: 9,
  organisationId: 'org_1',
  organisationGroups: groups,
  organisationMemberRole: OrganisationMemberRole.MEMBER,
};

describe('addUserToOrganisation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tells the organisation a member joined, as an accepted invite does', async () => {
    await addUserToOrganisation(options);

    expect(mocks.triggerJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'send.organisation-member-joined.email' }),
    );
  });

  it('stays quiet when asked to', async () => {
    await addUserToOrganisation({ ...options, bypassEmail: true });

    expect(mocks.memberCreate).toHaveBeenCalledTimes(1);
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});
