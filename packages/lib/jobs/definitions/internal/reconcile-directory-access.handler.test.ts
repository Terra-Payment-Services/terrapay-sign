import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which directory the job reconciles against. Without an access group it must
 * read the whole tenant rather than skip, because there is no group for Sign
 * users and skipping left every leaver with a working account.
 */

const env: Record<string, string | undefined> = {};

const fetchEntraGroupMembers = vi.fn();
const fetchEntraTenantUsers = vi.fn();
const reconcileDirectoryAccess = vi.fn();

vi.mock('../../../constants/app', () => ({
  NEXT_PRIVATE_ENTRA_TENANT_ID: () => env.tenantId,
  NEXT_PRIVATE_ENTRA_CLIENT_ID: () => env.clientId,
  NEXT_PRIVATE_ENTRA_CLIENT_SECRET: () => env.clientSecret,
  NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID: () => env.groupId,
  ENTRA_RECONCILE_DRY_RUN: () => true,
  ENTRA_RECONCILE_MINIMUM_MEMBERS: () => 10,
  ENTRA_RECONCILE_MAX_DISABLE_RATIO: () => 0.1,
}));

vi.mock('../../../server-only/directory/entra-graph', () => ({
  fetchEntraGroupMembers: async (...args: unknown[]) => await fetchEntraGroupMembers(...args),
  fetchEntraTenantUsers: async (...args: unknown[]) => await fetchEntraTenantUsers(...args),
}));

vi.mock('../../../server-only/directory/reconcile-directory-access', () => ({
  reconcileDirectoryAccess: async (options: { getDirectoryMembers: () => Promise<unknown> }) => {
    await options.getDirectoryMembers();

    return await reconcileDirectoryAccess(options);
  },
}));

vi.mock('../../../server-only/user/disable-user', () => ({ disableUser: vi.fn() }));

vi.mock('../../../server-only/user/service-accounts/deleted-account', () => ({
  deletedServiceAccountEmail: () => 'deleted-account@sign.example.com',
}));

vi.mock('../../../server-only/user/service-accounts/legacy-service-account', () => ({
  legacyServiceAccountEmail: () => 'serviceaccount@sign.example.com',
}));

const findMany = vi.fn();

vi.mock('@documenso/prisma', () => ({ prisma: { user: { findMany: async (args: unknown) => await findMany(args) } } }));

const { run } = await import('./reconcile-directory-access.handler');

const io = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
} as never;

const credentials = { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret' };

describe('reconcile-directory-access handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    env.tenantId = 'tenant';
    env.clientId = 'client';
    env.clientSecret = 'secret';
    env.groupId = undefined;

    fetchEntraGroupMembers.mockResolvedValue([]);
    fetchEntraTenantUsers.mockResolvedValue([]);
    reconcileDirectoryAccess.mockResolvedValue({ outcome: 'completed', failedUserIds: [] });
  });

  it('reconciles against the whole tenant when no access group is configured', async () => {
    await run({ payload: {}, io });

    expect(fetchEntraTenantUsers).toHaveBeenCalledWith({ credentials });
    expect(fetchEntraGroupMembers).not.toHaveBeenCalled();
  });

  it('reconciles against the group when one is configured', async () => {
    env.groupId = 'group-id';

    await run({ payload: {}, io });

    expect(fetchEntraGroupMembers).toHaveBeenCalledWith({ groupId: 'group-id', credentials });
    expect(fetchEntraTenantUsers).not.toHaveBeenCalled();
  });

  it('leaves the system accounts that hold orphaned documents out of the accounts it considers', async () => {
    findMany.mockResolvedValue([]);

    await run({ payload: {}, io });

    const [{ getReconcilableUsers }] = reconcileDirectoryAccess.mock.calls[0];
    await getReconcilableUsers();

    expect(findMany.mock.calls[0][0].where.email).toEqual({
      notIn: ['deleted-account@sign.example.com', 'serviceaccount@sign.example.com'],
    });
  });

  it('skips the run when a credential is missing', async () => {
    env.clientSecret = undefined;

    await run({ payload: {}, io });

    expect(reconcileDirectoryAccess).not.toHaveBeenCalled();
    expect(fetchEntraTenantUsers).not.toHaveBeenCalled();
  });
});
