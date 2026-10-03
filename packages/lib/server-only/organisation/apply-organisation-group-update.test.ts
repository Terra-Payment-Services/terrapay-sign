import { OrganisationMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';

const mocks = vi.hoisted(() => ({
  groupUpdateMany: vi.fn(),
  memberDeleteMany: vi.fn(),
  memberCreateMany: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    $transaction: async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        organisationGroup: { updateMany: mocks.groupUpdateMany },
        organisationGroupMember: { deleteMany: mocks.memberDeleteMany, createMany: mocks.memberCreateMany },
      }),
  },
}));

import { applyOrganisationGroupUpdate } from './apply-organisation-group-update';

const { ADMIN, MANAGER } = OrganisationMemberRole;

const apply = (overrides: Partial<Parameters<typeof applyOrganisationGroupUpdate>[0]> = {}) =>
  applyOrganisationGroupUpdate({
    groupId: 'group_deal_desk',
    authorisedRole: MANAGER,
    organisationRole: undefined,
    name: undefined,
    memberIdsToAdd: ['member_the_manager'],
    memberIdsToRemove: [],
    ...overrides,
  });

describe('applyOrganisationGroupUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.groupUpdateMany.mockResolvedValue({ count: 1 });
    mocks.memberDeleteMany.mockResolvedValue({ count: 0 });
    mocks.memberCreateMany.mockResolvedValue({ count: 0 });
  });

  // The race Codex reported. A manager submits "add me to the MANAGER group"
  // with no role field, which passes the hierarchy check because MANAGER is
  // within their reach. An administrator promotes that group to ADMIN before the
  // write lands. Zero rows match the role the request was authorised against, so
  // nothing is written.
  it('refuses the write when the group was promoted after the authorisation read', async () => {
    mocks.groupUpdateMany.mockResolvedValue({ count: 0 });

    await expect(apply()).rejects.toThrow(/changed while the update was being prepared/);
  });

  it('adds nobody to the group it refused to write', async () => {
    mocks.groupUpdateMany.mockResolvedValue({ count: 0 });

    await expect(apply()).rejects.toThrow(AppError);

    expect(mocks.memberCreateMany).not.toHaveBeenCalled();
    expect(mocks.memberDeleteMany).not.toHaveBeenCalled();
  });

  it('carries the authorised role into the write as a predicate', async () => {
    await apply();

    expect(mocks.groupUpdateMany.mock.calls[0][0].where).toEqual({
      id: 'group_deal_desk',
      organisationRole: MANAGER,
    });
  });

  // Without this the update would set nothing when the request named no role,
  // and a Prisma no-op write would never evaluate the predicate above.
  it('writes the role back unchanged when the request named none, so the predicate is always run', async () => {
    await apply();

    expect(mocks.groupUpdateMany.mock.calls[0][0].data).toMatchObject({ organisationRole: MANAGER });
  });

  it('writes the new role when the request named one', async () => {
    await apply({ organisationRole: ADMIN, authorisedRole: ADMIN });

    expect(mocks.groupUpdateMany.mock.calls[0][0].data).toMatchObject({ organisationRole: ADMIN });
  });

  it('applies the membership changes when the group is still what it was', async () => {
    await apply({ memberIdsToAdd: ['member_a'], memberIdsToRemove: ['member_b'] });

    expect(mocks.memberDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.memberDeleteMany.mock.calls[0][0].where).toMatchObject({
      groupId: 'group_deal_desk',
      organisationMemberId: { in: ['member_b'] },
    });

    expect(mocks.memberCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.memberCreateMany.mock.calls[0][0].data).toMatchObject([
      { groupId: 'group_deal_desk', organisationMemberId: 'member_a' },
    ]);
  });

  it('leaves the membership alone when the request asked for no membership change', async () => {
    await apply({ memberIdsToAdd: [], memberIdsToRemove: [] });

    expect(mocks.memberDeleteMany).not.toHaveBeenCalled();
    expect(mocks.memberCreateMany).not.toHaveBeenCalled();
  });
});
