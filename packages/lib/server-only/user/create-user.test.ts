import type { User } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPersonalOrganisation: vi.fn(),
  isOrganisationCreationAllowed: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: {} }));

vi.mock('../organisation/create-organisation', () => ({
  createPersonalOrganisation: mocks.createPersonalOrganisation,
}));

vi.mock('../organisation/organisation-creation-allowed', () => ({
  isOrganisationCreationAllowed: mocks.isOrganisationCreationAllowed,
}));

import { onCreateUserHook } from './create-user';

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const user = { id: 9 } as User;

describe('onCreateUserHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives a new user a personal organisation on a fresh install', async () => {
    mocks.isOrganisationCreationAllowed.mockResolvedValue(true);

    await onCreateUserHook(user);

    expect(mocks.createPersonalOrganisation).toHaveBeenCalledWith({ userId: 9 });
  });

  it('gives a new user no personal organisation once an organisation exists', async () => {
    mocks.isOrganisationCreationAllowed.mockResolvedValue(false);

    await onCreateUserHook(user);

    expect(mocks.createPersonalOrganisation).not.toHaveBeenCalled();
  });

  it('gives no personal organisation when the caller asks for none', async () => {
    mocks.isOrganisationCreationAllowed.mockResolvedValue(true);

    await onCreateUserHook(user, { skipPersonalOrganisation: true });

    expect(mocks.createPersonalOrganisation).not.toHaveBeenCalled();
  });
});
