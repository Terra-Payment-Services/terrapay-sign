import { Role } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';
import type { EntraDirectoryMember } from './entra-graph';
import { clearEntraTokenCache, fetchEntraGroupMembers, fetchEntraTenantUsers } from './entra-graph';
import type {
  ReconcilableUser,
  ReconcileDirectoryAccessConfig,
  ReconcileDirectoryAccessOptions,
} from './reconcile-directory-access';
import { readDirectoryObjectId, reconcileDirectoryAccess } from './reconcile-directory-access';

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createConfig = (overrides: Partial<ReconcileDirectoryAccessConfig> = {}): ReconcileDirectoryAccessConfig => ({
  dryRun: false,
  minimumMemberCount: 3,
  maximumDisableRatio: 0.75,
  exemptEmails: [],
  ...overrides,
});

const createMember = (overrides: Partial<EntraDirectoryMember> = {}): EntraDirectoryMember => ({
  id: 'entra-id',
  mail: 'person@example.com',
  userPrincipalName: 'person@example.com',
  accountEnabled: true,
  ...overrides,
});

const createUser = (overrides: Partial<ReconcilableUser> = {}): ReconcilableUser => ({
  id: 1,
  email: 'person@example.com',
  name: 'Person',
  roles: [Role.USER],
  disabled: false,
  directoryObjectIds: [],
  ...overrides,
});

/**
 * Four members who are nobody in particular, used to pad the membership above
 * the configured floor so the tests that are not about the floor do not trip it.
 */
const padding = (count: number): EntraDirectoryMember[] =>
  Array.from({ length: count }, (_, index) =>
    createMember({
      id: `padding-${index}`,
      mail: `padding-${index}@example.com`,
      userPrincipalName: `padding-${index}@example.com`,
    }),
  );

/**
 * Documenso accounts matching the padded membership, so that a test about one
 * departing user is not also a test of the disable-ratio guard.
 */
const paddingUsers = (count: number): ReconcilableUser[] =>
  Array.from({ length: count }, (_, index) =>
    createUser({ id: 100 + index, email: `padding-${index}@example.com`, name: `Padding ${index}` }),
  );

const run = async (
  overrides: Partial<ReconcileDirectoryAccessOptions> & {
    members?: EntraDirectoryMember[];
    users?: ReconcilableUser[];
  } = {},
) => {
  const logger = createLogger();
  const disableUserAccount = vi.fn().mockResolvedValue(undefined);

  const { members = [], users = [], ...rest } = overrides;

  const result = await reconcileDirectoryAccess({
    config: createConfig(),
    logger,
    getDirectoryMembers: async () => members,
    getReconcilableUsers: async () => users,
    disableUserAccount,
    ...rest,
  });

  return { result, logger, disableUserAccount };
};

describe('reconcileDirectoryAccess', () => {
  it('disables a user who is absent from the access group', async () => {
    const { result, disableUserAccount } = await run({
      members: [createMember({ mail: 'stays@example.com', userPrincipalName: 'stays@example.com' }), ...padding(4)],
      users: [createUser({ id: 10, email: 'stays@example.com' }), createUser({ id: 11, email: 'left@example.com' })],
    });

    expect(disableUserAccount).toHaveBeenCalledTimes(1);
    expect(disableUserAccount).toHaveBeenCalledWith({ id: 11 });
    expect(result.outcome).toBe('completed');
    expect(result.disabledUserIds).toEqual([11]);
  });

  it('leaves a user who is present in the access group untouched', async () => {
    const { result, disableUserAccount } = await run({
      members: [createMember({ mail: 'stays@example.com', userPrincipalName: 'stays@example.com' }), ...padding(4)],
      users: [createUser({ id: 10, email: 'stays@example.com' })],
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(result.outcome).toBe('completed');
    expect(result.disabledUserIds).toEqual([]);
  });

  it('matches on mail and userPrincipalName, case insensitively', async () => {
    const { disableUserAccount } = await run({
      members: [
        createMember({ id: 'a', mail: 'Alias@Example.com', userPrincipalName: 'alice@example.onmicrosoft.com' }),
        createMember({ id: 'b', mail: null, userPrincipalName: 'Bob@Example.com' }),
        ...padding(3),
      ],
      users: [
        createUser({ id: 10, email: 'ALIAS@example.com' }),
        createUser({ id: 11, email: 'alice@EXAMPLE.onmicrosoft.com' }),
        createUser({ id: 12, email: 'bob@example.com' }),
      ],
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('disables a user who is still a group member but disabled in Entra', async () => {
    const { result, disableUserAccount } = await run({
      members: [
        createMember({
          mail: 'suspended@example.com',
          userPrincipalName: 'suspended@example.com',
          accountEnabled: false,
        }),
        ...padding(4),
      ],
      users: [createUser({ id: 10, email: 'suspended@example.com' }), ...paddingUsers(4)],
    });

    expect(disableUserAccount).toHaveBeenCalledWith({ id: 10 });
    expect(result.disabledUserIds).toEqual([10]);
  });

  it('never disables an admin, even when absent from the access group', async () => {
    const { result, disableUserAccount } = await run({
      members: padding(5),
      users: [
        createUser({ id: 10, email: 'admin@example.com', roles: [Role.ADMIN] }),
        createUser({ id: 11, email: 'admin-and-user@example.com', roles: [Role.USER, Role.ADMIN] }),
      ],
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(result.skippedAdminCount).toBe(2);
    expect(result.consideredUserCount).toBe(0);
  });

  it('changes nothing in dry run, but reports what it would do', async () => {
    const { result, disableUserAccount, logger } = await run({
      config: createConfig({ dryRun: true }),
      members: padding(5),
      users: [createUser({ id: 11, email: 'left@example.com' }), ...paddingUsers(5)],
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(result.outcome).toBe('completed');
    expect(result.candidateUserIds).toEqual([11]);
    expect(result.disabledUserIds).toEqual([]);
    expect(logger.info.mock.calls.flat().join(' ')).toContain('would disable account 11');
  });

  it('aborts without disabling anyone when the membership is below the floor', async () => {
    const { result, disableUserAccount, logger } = await run({
      config: createConfig({ minimumMemberCount: 10 }),
      members: padding(4),
      users: [createUser({ id: 11, email: 'left@example.com' })],
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(result.outcome).toBe('aborted');
    expect(result.abortReason).toBe('membership-below-floor');
    expect(logger.error.mock.calls.flat().join(' ')).toContain('4 members, below the configured floor of 10');
  });

  it('aborts without disabling anyone when the disable ratio is exceeded', async () => {
    const { result, disableUserAccount, logger } = await run({
      config: createConfig({ maximumDisableRatio: 0.25 }),
      members: [createMember({ mail: 'stays@example.com', userPrincipalName: 'stays@example.com' }), ...padding(4)],
      users: [
        createUser({ id: 10, email: 'stays@example.com' }),
        createUser({ id: 11, email: 'left-one@example.com' }),
        createUser({ id: 12, email: 'left-two@example.com' }),
        createUser({ id: 13, email: 'left-three@example.com' }),
      ],
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(result.outcome).toBe('aborted');
    expect(result.abortReason).toBe('disable-ratio-exceeded');
    expect(result.candidateUserIds).toEqual([11, 12, 13]);
    expect(logger.error.mock.calls.flat().join(' ')).toContain('would disable 3 of 4 considered accounts');
  });

  it('aborts without disabling anyone when the directory read fails', async () => {
    const logger = createLogger();
    const disableUserAccount = vi.fn().mockResolvedValue(undefined);

    await expect(
      reconcileDirectoryAccess({
        config: createConfig(),
        logger,
        getDirectoryMembers: () =>
          Promise.reject(new Error('Microsoft Graph transitiveMembers request failed with status 503')),
        getReconcilableUsers: async () => [createUser({ id: 11, email: 'left@example.com' })],
        disableUserAccount,
      }),
    ).rejects.toThrow('status 503');

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(logger.error.mock.calls.flat().join(' ')).toContain('the Microsoft Graph membership read failed');
  });

  it('treats an empty directory as an abort rather than as nobody having access', async () => {
    const { result, disableUserAccount } = await run({
      members: [],
      users: [createUser({ id: 11, email: 'left@example.com' })],
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(result.outcome).toBe('aborted');
  });

  it('keeps a renamed user whose Sign account still carries the old address, matched by Entra object id', async () => {
    const { result } = await run({
      members: [
        createMember({ id: 'oid-renamed', mail: 'new.name@example.com', userPrincipalName: 'new.name@example.com' }),
        ...padding(4),
      ],
      users: [
        createUser({ id: 10, email: 'old.name@example.com', directoryObjectIds: ['oid-renamed'] }),
        ...paddingUsers(4),
      ],
    });

    expect(result.candidateUserIds).toEqual([]);
    expect(result.disabledUserIds).toEqual([]);
  });

  it('disables a renamed user once Entra disables the object the account is linked to', async () => {
    const { result } = await run({
      members: [
        createMember({
          id: 'oid-leaver',
          mail: 'new.name@example.com',
          userPrincipalName: 'new.name@example.com',
          accountEnabled: false,
        }),
        ...padding(4),
      ],
      users: [
        createUser({ id: 10, email: 'old.name@example.com', directoryObjectIds: ['oid-leaver'] }),
        ...paddingUsers(4),
      ],
    });

    expect(result.disabledUserIds).toEqual([10]);
  });

  it('falls back to email for an account with no linked Entra object id', async () => {
    const { result } = await run({
      members: [createMember({ id: 'oid-stays', mail: 'stays@example.com' }), ...padding(4)],
      users: [
        createUser({ id: 10, email: 'stays@example.com', directoryObjectIds: [] }),
        createUser({ id: 11, email: 'left@example.com', directoryObjectIds: [] }),
        ...paddingUsers(4),
      ],
    });

    expect(result.disabledUserIds).toEqual([11]);
  });

  it('disables a leaver whose address has been reassigned to somebody else, on the object id', async () => {
    const { result } = await run({
      members: [
        createMember({ id: 'oid-alice', mail: 'alice.old@example.com', accountEnabled: false }),
        createMember({ id: 'oid-bob', mail: 'shared@example.com', userPrincipalName: 'shared@example.com' }),
        ...padding(4),
      ],
      users: [
        createUser({ id: 10, email: 'shared@example.com', directoryObjectIds: ['oid-alice'] }),
        ...paddingUsers(4),
      ],
    });

    expect(result.disabledUserIds).toEqual([10]);
  });

  // The safe failure: a person deleted and recreated in Entra has a new object
  // id that their Sign account has not seen, so the account is disabled until
  // somebody re-enables it, however well the address matches.
  it('disables an account whose person was recreated in Entra and has not signed in as the new identity', async () => {
    const { result } = await run({
      members: [createMember({ id: 'oid-recreated', mail: 'recreated@example.com' }), ...padding(4)],
      users: [
        createUser({ id: 10, email: 'recreated@example.com', directoryObjectIds: ['oid-before-recreation'] }),
        ...paddingUsers(4),
      ],
    });

    expect(result.disabledUserIds).toEqual([10]);
  });

  it('never disables an exempt address, whatever its case, and leaves it out of the disable ratio', async () => {
    const { result } = await run({
      config: createConfig({ exemptEmails: [' Scanner@Example.com '], maximumDisableRatio: 0.2 }),
      members: padding(5),
      users: [
        createUser({ id: 10, email: 'scanner@EXAMPLE.com' }),
        createUser({ id: 11, email: 'left@example.com' }),
        ...paddingUsers(4),
      ],
    });

    expect(result.outcome).toBe('completed');
    expect(result.exemptUserCount).toBe(1);
    expect(result.consideredUserCount).toBe(5);
    expect(result.disabledUserIds).toEqual([11]);
  });
});

describe('readDirectoryObjectId', () => {
  const idToken = (payload: Record<string, unknown>) =>
    ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');

  it('reads the object id from a stored Entra ID token issued by the reconciled tenant', () => {
    expect(readDirectoryObjectId(idToken({ oid: 'oid-1', tid: 'tenant-id' }), 'tenant-id')).toBe('oid-1');
  });

  it.each([
    ['no token is stored', null],
    ['the token is not a JWT', 'not-a-jwt'],
    ['the payload is not JSON', 'e30.%%%.signature'],
    ['the token carries no oid', idToken({ tid: 'tenant-id' })],
    ['the token came from another tenant', idToken({ oid: 'oid-1', tid: 'other-tenant' })],
    ['the token carries no tid', idToken({ oid: 'oid-1' })],
  ])('reads nothing when %s', (_reason, token) => {
    expect(readDirectoryObjectId(token, 'tenant-id')).toBeNull();
  });
});

type StubResponse = { status: number; body: unknown };

const jsonResponse = ({ status, body }: StubResponse) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Stub `fetch` that answers the token endpoint and then serves the supplied
 * Graph pages in order.
 */
const createGraphFetch = (pages: StubResponse[]) => {
  const requestedUrls: string[] = [];
  const remaining = [...pages];

  const fetchFn = vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();

    requestedUrls.push(url);

    if (url.includes('/oauth2/v2.0/token')) {
      return Promise.resolve(
        jsonResponse({ status: 200, body: { access_token: 'stub-access-token', expires_in: 3600 } }),
      );
    }

    const page = remaining.shift();

    if (!page) {
      throw new Error(`Unexpected Graph request: ${url}`);
    }

    return Promise.resolve(jsonResponse(page));
  });

  return { fetchFn: fetchFn as unknown as typeof fetch, requestedUrls };
};

const credentials = {
  tenantId: 'tenant-id',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

describe('fetchEntraGroupMembers', () => {
  beforeEach(() => {
    clearEntraTokenCache();
  });

  it('follows @odata.nextLink so a member on the second page is not treated as absent', async () => {
    const { fetchFn, requestedUrls } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [
            {
              id: 'page-one-user',
              '@odata.type': '#microsoft.graph.user',
              mail: 'first@example.com',
              userPrincipalName: 'first@example.com',
              accountEnabled: true,
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/group-id/transitiveMembers?$skiptoken=abc',
        },
      },
      {
        status: 200,
        body: {
          value: [
            {
              id: 'page-two-user',
              '@odata.type': '#microsoft.graph.user',
              mail: 'second@example.com',
              userPrincipalName: 'second@example.com',
              accountEnabled: true,
            },
          ],
        },
      },
    ]);

    const members = await fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn });

    expect(members.map((member) => member.mail)).toEqual(['first@example.com', 'second@example.com']);
    expect(requestedUrls.filter((url) => url.includes('transitiveMembers'))).toHaveLength(2);

    const logger = createLogger();
    const disableUserAccount = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileDirectoryAccess({
      config: createConfig({ minimumMemberCount: 2 }),
      logger,
      getDirectoryMembers: async () => members,
      getReconcilableUsers: async () => [
        createUser({ id: 10, email: 'first@example.com' }),
        createUser({ id: 11, email: 'second@example.com' }),
      ],
      disableUserAccount,
    });

    expect(disableUserAccount).not.toHaveBeenCalled();
    expect(result.outcome).toBe('completed');
  });

  it('excludes nested group objects from the membership', async () => {
    const { fetchFn } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [
            {
              id: 'nested-group',
              '@odata.type': '#microsoft.graph.group',
              mail: 'team@example.com',
              userPrincipalName: null,
            },
            {
              id: 'real-user',
              '@odata.type': '#microsoft.graph.user',
              mail: 'person@example.com',
              userPrincipalName: 'person@example.com',
              accountEnabled: true,
            },
          ],
        },
      },
    ]);

    const members = await fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn });

    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe('real-user');
  });

  it('throws rather than returning a partial membership when a page fails', async () => {
    const { fetchFn } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [{ id: 'page-one-user', mail: 'first@example.com', userPrincipalName: 'first@example.com' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/group-id/transitiveMembers?$skiptoken=abc',
        },
      },
      {
        status: 503,
        body: { error: { code: 'serviceNotAvailable', message: 'try later' } },
      },
    ]);

    await expect(fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn })).rejects.toThrow(AppError);
  });

  it('never puts the client secret or the bearer token in an error message', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse({ status: 401, body: { error: { code: 'invalid_client' } } })),
    ) as unknown as typeof fetch;

    await expect(fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn })).rejects.toSatisfy(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        return !message.includes('client-secret') && !message.includes('stub-access-token');
      },
    );
  });

  it('reuses the cached token until it is close to expiry', async () => {
    const { fetchFn, requestedUrls } = createGraphFetch([
      { status: 200, body: { value: [] } },
      { status: 200, body: { value: [] } },
    ]);

    const now = () => 1_000_000;

    await fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn, now });
    await fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn, now });

    expect(requestedUrls.filter((url) => url.includes('/oauth2/v2.0/token'))).toHaveLength(1);
  });

  it('fetches a new token once the cached one is within the refresh window', async () => {
    const { fetchFn, requestedUrls } = createGraphFetch([
      { status: 200, body: { value: [] } },
      { status: 200, body: { value: [] } },
    ]);

    await fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn, now: () => 1_000_000 });

    // The stub token lasts an hour and the client refreshes five minutes early,
    // so a clock 56 minutes on must ask for a fresh one.
    await fetchEntraGroupMembers({
      groupId: 'group-id',
      credentials,
      fetchFn,
      now: () => 1_000_000 + 56 * 60 * 1000,
    });

    expect(requestedUrls.filter((url) => url.includes('/oauth2/v2.0/token'))).toHaveLength(2);
  });
});

describe('an incomplete directory read', () => {
  // The invariant: never disable an account on partial data. Microsoft returns
  // directory objects carrying only a type and an id when the application
  // cannot read their properties, so a "successful" 200 can describe people it
  // does not name. Those match no Documenso account, look exactly like someone
  // who has left, and the member count still clears the floor because the
  // objects were counted.
  it('refuses a member with no @odata.type rather than assuming it is a user', async () => {
    const { fetchFn } = createGraphFetch([
      { status: 200, body: { value: [{ id: 'unclassifiable', mail: 'someone@example.com' }] } },
    ]);

    await expect(fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn })).rejects.toThrow(
      /no @odata.type/,
    );
  });

  it('refuses a user Graph would not name', async () => {
    const { fetchFn } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [
            {
              id: 'withheld',
              '@odata.type': '#microsoft.graph.user',
              mail: null,
              userPrincipalName: null,
              accountEnabled: true,
            },
          ],
        },
      },
    ]);

    await expect(fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn })).rejects.toThrow(
      /neither mail nor userPrincipalName/,
    );
  });
});

describe('fetchEntraTenantUsers', () => {
  beforeEach(() => {
    clearEntraTokenCache();
  });

  const tenantUser = (overrides: Record<string, unknown> = {}) => ({
    id: 'user-id',
    mail: 'person@example.com',
    userPrincipalName: 'person@example.com',
    accountEnabled: true,
    userType: 'Member',
    ...overrides,
  });

  /**
   * Reconcile the given Documenso accounts against what the tenant read
   * returned, with a floor low enough for a handful of users and a ratio that
   * lets every candidate through, so the test sees the raw decision.
   */
  const reconcileAgainstTenant = async (fetchFn: typeof fetch, users: ReconcilableUser[]) => {
    const disableUserAccount = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileDirectoryAccess({
      config: createConfig({ minimumMemberCount: 1, maximumDisableRatio: 1 }),
      logger: createLogger(),
      getDirectoryMembers: async () => await fetchEntraTenantUsers({ credentials, fetchFn }),
      getReconcilableUsers: async () => users,
      disableUserAccount,
    });

    return { result, disableUserAccount };
  };

  it('reads every user in the tenant, following @odata.nextLink, without needing @odata.type', async () => {
    const { fetchFn, requestedUrls } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [tenantUser({ id: 'one', mail: 'first@example.com', userPrincipalName: 'first@example.com' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc',
        },
      },
      {
        status: 200,
        body: {
          value: [tenantUser({ id: 'two', mail: 'second@example.com', userPrincipalName: 'second@example.com' })],
        },
      },
    ]);

    const { result, disableUserAccount } = await reconcileAgainstTenant(fetchFn, [
      createUser({ id: 10, email: 'first@example.com' }),
      createUser({ id: 11, email: 'second@example.com' }),
      createUser({ id: 12, email: 'left@example.com' }),
    ]);

    const graphUrls = requestedUrls.filter((url) => url.startsWith('https://graph.microsoft.com/v1.0/users'));

    expect(graphUrls).toHaveLength(2);
    expect(graphUrls[0]).toContain('$select=id,mail,userPrincipalName,accountEnabled,userType');
    expect(result.outcome).toBe('completed');
    expect(disableUserAccount).toHaveBeenCalledTimes(1);
    expect(disableUserAccount).toHaveBeenCalledWith({ id: 12 });
  });

  it('treats a user whose Entra account is disabled as having left', async () => {
    const { fetchFn } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [
            tenantUser({ id: 'stays', mail: 'stays@example.com', userPrincipalName: 'stays@example.com' }),
            tenantUser({
              id: 'leaver',
              mail: 'leaver@example.com',
              userPrincipalName: 'leaver@example.com',
              accountEnabled: false,
            }),
          ],
        },
      },
    ]);

    const { disableUserAccount } = await reconcileAgainstTenant(fetchFn, [
      createUser({ id: 10, email: 'stays@example.com' }),
      createUser({ id: 11, email: 'leaver@example.com' }),
    ]);

    expect(disableUserAccount).toHaveBeenCalledTimes(1);
    expect(disableUserAccount).toHaveBeenCalledWith({ id: 11 });
  });

  it('treats an account linked to a guest user as absent, but not one whose userType is missing', async () => {
    const { fetchFn } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [
            tenantUser({ id: 'member', mail: 'member@example.com', userPrincipalName: 'member@example.com' }),
            tenantUser({
              id: 'guest',
              mail: 'guest@partner.example',
              userPrincipalName: 'guest_partner.example#EXT#@example.onmicrosoft.com',
              userType: 'Guest',
            }),
            tenantUser({
              id: 'untyped',
              mail: 'untyped@example.com',
              userPrincipalName: 'untyped@example.com',
              userType: null,
            }),
          ],
        },
      },
    ]);

    const { disableUserAccount } = await reconcileAgainstTenant(fetchFn, [
      createUser({ id: 10, email: 'member@example.com' }),
      createUser({ id: 11, email: 'guest@partner.example' }),
      createUser({ id: 12, email: 'untyped@example.com' }),
    ]);

    expect(disableUserAccount).toHaveBeenCalledTimes(1);
    expect(disableUserAccount).toHaveBeenCalledWith({ id: 11 });
  });

  it('disables nobody when a later page of users fails', async () => {
    const { fetchFn } = createGraphFetch([
      {
        status: 200,
        body: {
          value: [tenantUser({ id: 'one', mail: 'first@example.com', userPrincipalName: 'first@example.com' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc',
        },
      },
      {
        status: 503,
        body: { error: { code: 'serviceNotAvailable', message: 'try later' } },
      },
    ]);

    await expect(
      reconcileAgainstTenant(fetchFn, [
        createUser({ id: 10, email: 'first@example.com' }),
        createUser({ id: 11, email: 'second@example.com' }),
      ]),
    ).rejects.toThrow(AppError);
  });

  it('disables nobody when the tenant read is refused outright', async () => {
    const fetchFn = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/oauth2/v2.0/token')) {
        return Promise.resolve(
          jsonResponse({ status: 200, body: { access_token: 'stub-access-token', expires_in: 3600 } }),
        );
      }

      return Promise.resolve(jsonResponse({ status: 403, body: { error: { code: 'Authorization_RequestDenied' } } }));
    }) as unknown as typeof fetch;

    const disableUserAccount = vi.fn();

    await expect(
      reconcileDirectoryAccess({
        config: createConfig(),
        logger: createLogger(),
        getDirectoryMembers: async () => await fetchEntraTenantUsers({ credentials, fetchFn }),
        getReconcilableUsers: async () => [createUser()],
        disableUserAccount,
      }),
    ).rejects.toThrow(/status 403/);

    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('aborts on the floor when the tenant read comes back empty', async () => {
    const { fetchFn } = createGraphFetch([{ status: 200, body: { value: [] } }]);

    const disableUserAccount = vi.fn();

    const result = await reconcileDirectoryAccess({
      config: createConfig(),
      logger: createLogger(),
      getDirectoryMembers: async () => await fetchEntraTenantUsers({ credentials, fetchFn }),
      getReconcilableUsers: async () => [createUser()],
      disableUserAccount,
    });

    expect(result.outcome).toBe('aborted');
    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  // Criterion 24: a missing or null accountEnabled means not enabled. The run
  // goes on, and the user keeps no account.
  for (const [label, accountEnabled] of [
    ['missing', undefined],
    ['null', null],
  ] as const) {
    it(`treats a user whose accountEnabled is ${label} as not enabled, without aborting`, async () => {
      const { fetchFn } = createGraphFetch([
        {
          status: 200,
          body: {
            value: [
              tenantUser({ id: 'kept', mail: 'kept@example.com', userPrincipalName: 'kept@example.com' }),
              tenantUser({
                id: 'unknown',
                mail: 'unknown@example.com',
                userPrincipalName: 'unknown@example.com',
                accountEnabled,
              }),
            ],
          },
        },
      ]);

      const { result } = await reconcileAgainstTenant(fetchFn, [
        createUser({ id: 10, email: 'kept@example.com' }),
        createUser({ id: 11, email: 'unknown@example.com' }),
      ]);

      expect(result.outcome).toBe('completed');
      expect(result.disabledUserIds).toEqual([11]);
    });
  }

  it('refuses a user Graph would not name', async () => {
    const { fetchFn } = createGraphFetch([
      { status: 200, body: { value: [tenantUser({ mail: null, userPrincipalName: null })] } },
    ]);

    await expect(fetchEntraTenantUsers({ credentials, fetchFn })).rejects.toThrow(/neither mail nor userPrincipalName/);
  });
});

/**
 * Criterion 33: in production the token and Graph requests go to Microsoft,
 * whatever the base-URL settings say. The client is driven through its public
 * functions with `fetch` replaced at the network boundary, and the module is
 * loaded afresh after the environment is set, so the result does not depend
 * on whether it reads the settings at import or at call time.
 */
describe('production endpoints', () => {
  const MICROSOFT_ORIGINS = ['https://login.microsoftonline.com', 'https://graph.microsoft.com'];

  const loadInProduction = async (baseUrls: Record<string, string>) => {
    vi.stubEnv('NODE_ENV', 'production');

    for (const [name, value] of Object.entries(baseUrls)) {
      vi.stubEnv(name, value);
    }

    vi.resetModules();

    const graph = await import('./entra-graph');
    graph.clearEntraTokenCache();

    return graph;
  };

  const page = (nextLink?: string) => ({
    status: 200,
    body: {
      value: [
        {
          id: 'user-id',
          '@odata.type': '#microsoft.graph.user',
          mail: 'person@example.com',
          userPrincipalName: 'person@example.com',
          accountEnabled: true,
          userType: 'Member',
        },
      ],
      ...(nextLink ? { '@odata.nextLink': nextLink } : {}),
    },
  });

  const SETTINGS: [string, Record<string, string>][] = [
    [
      'both base URLs pointing elsewhere',
      {
        NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL: 'https://graph.attacker.example',
        NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL: 'https://login.attacker.example',
      },
    ],
    ['only the Graph base URL pointing elsewhere', { NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL: 'http://127.0.0.1:9' }],
    ['only the login base URL pointing elsewhere', { NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL: 'http://127.0.0.1:9' }],
    ['both base URLs empty', { NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL: '', NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL: '' }],
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  for (const [label, baseUrls] of SETTINGS) {
    it(`reads the tenant from Microsoft with ${label}`, async () => {
      const graph = await loadInProduction(baseUrls);
      const { fetchFn, requestedUrls } = createGraphFetch([
        page('https://graph.microsoft.com/v1.0/users?$skiptoken=next'),
        page(),
      ]);

      await graph.fetchEntraTenantUsers({ credentials, fetchFn }).catch(() => undefined);

      expect(requestedUrls.length).toBeGreaterThan(0);
      expect(requestedUrls.map((url) => new URL(url).origin).filter((o) => !MICROSOFT_ORIGINS.includes(o))).toEqual([]);
      expect(requestedUrls.some((url) => url.startsWith('https://login.microsoftonline.com/'))).toBe(true);
      expect(requestedUrls.some((url) => url.startsWith('https://graph.microsoft.com/v1.0/users'))).toBe(true);
    });

    it(`reads the access group from Microsoft with ${label}`, async () => {
      const graph = await loadInProduction(baseUrls);
      const { fetchFn, requestedUrls } = createGraphFetch([
        page('https://graph.microsoft.com/v1.0/groups/group-id/transitiveMembers?$skiptoken=next'),
        page(),
      ]);

      await graph.fetchEntraGroupMembers({ groupId: 'group-id', credentials, fetchFn }).catch(() => undefined);

      expect(requestedUrls.length).toBeGreaterThan(0);
      expect(requestedUrls.map((url) => new URL(url).origin).filter((o) => !MICROSOFT_ORIGINS.includes(o))).toEqual([]);
      expect(requestedUrls.some((url) => url.startsWith('https://login.microsoftonline.com/'))).toBe(true);
      expect(requestedUrls.some((url) => url.startsWith('https://graph.microsoft.com/v1.0/groups/group-id/'))).toBe(
        true,
      );
    });
  }
});
