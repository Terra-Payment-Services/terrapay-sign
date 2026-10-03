import { OrganisationType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';

const db = vi.hoisted(() => ({ organisations: [] as { type: string }[] }));

// A stand-in table that honours the type filter the way Postgres would.
vi.mock('@documenso/prisma', () => ({
  prisma: {
    organisation: {
      count: async ({ where }: { where?: { type?: string } } = {}) =>
        db.organisations.filter((row) => !where?.type || row.type === where.type).length,
    },
  },
}));

import { assertOrganisationCreationAllowed, isOrganisationCreationAllowed } from './organisation-creation-allowed';

describe('organisation creation', () => {
  beforeEach(() => {
    db.organisations = [];
  });

  it('is allowed on a fresh install with no organisation', async () => {
    await expect(isOrganisationCreationAllowed()).resolves.toBe(true);
    await expect(assertOrganisationCreationAllowed()).resolves.toBeUndefined();
  });

  it('is still allowed when only personal organisations exist', async () => {
    db.organisations = [{ type: OrganisationType.PERSONAL }, { type: OrganisationType.PERSONAL }];

    await expect(isOrganisationCreationAllowed()).resolves.toBe(true);
  });

  it('is refused once an organisation exists', async () => {
    db.organisations = [{ type: OrganisationType.ORGANISATION }];

    await expect(isOrganisationCreationAllowed()).resolves.toBe(false);

    const error = await assertOrganisationCreationAllowed().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(AppErrorCode.FORBIDDEN);
  });
});
