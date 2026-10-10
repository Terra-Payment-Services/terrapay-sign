/**
 * Account matching for the directory sync, one test per failure mode.
 *
 * The failure modes are listed, numbered and decided in MATCHING-FAILURE-MODES.md
 * beside this file; each test carries its entry number. The tests were written
 * from that list and the specification of this change alone, against the module's
 * exported API, without reading its implementation.
 *
 * Only I/O is faked: the directory as Graph returned it, the Sign account store
 * and the log. Nothing inside the module is replaced, and every assertion is on
 * the result, the state of the account store or the captured log.
 */
import { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { EntraDirectoryMember } from './entra-graph';
import type { ReconcilableUser, ReconcileDirectoryAccessConfig } from './reconcile-directory-access';
import { readDirectoryObjectId, reconcileDirectoryAccess } from './reconcile-directory-access';

const TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const OTHER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A Microsoft v2.0 id_token. The signature is junk: the module does not verify it. */
const idToken = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) =>
  `${b64url({ typ: 'JWT', alg: 'RS256', kid: 'k1', ...header })}.${b64url({
    aud: 'sign-client',
    iss: `https://login.microsoftonline.com/${typeof claims.tid === 'string' ? claims.tid : TENANT_ID}/v2.0`,
    sub: 'pairwise-subject-not-the-object-id',
    ver: '2.0',
    exp: 1_700_000_000,
    ...claims,
  })}.c2lnbmF0dXJl`;

const rawToken = (payloadSegment: string) => `${b64url({ alg: 'RS256' })}.${payloadSegment}.c2lnbmF0dXJl`;

let nextObjectId = 0;

const objectId = () => {
  nextObjectId += 1;

  return `6f1c${nextObjectId.toString(16).padStart(4, '0')}-1111-4222-8333-${nextObjectId.toString(16).padStart(12, '0')}`;
};

const member = (email: string, overrides: Partial<EntraDirectoryMember> = {}): EntraDirectoryMember => ({
  id: objectId(),
  mail: email,
  userPrincipalName: email,
  accountEnabled: true,
  ...overrides,
});

/** The directory as Graph returned it: every user the sync read, in page order. */
const InMemoryGraphDirectory = (users: EntraDirectoryMember[], { failure }: { failure?: Error } = {}) => ({
  getDirectoryMembers: async () => {
    if (failure) {
      throw failure;
    }

    return users.map((user) => ({ ...user }));
  },
});

/** Sign accounts as the database holds them; disabling one flips its stored flag. */
const InMemorySignAccounts = (users: ReconcilableUser[], { unwritable = [] }: { unwritable?: number[] } = {}) => {
  const rows = new Map(users.map((user) => [user.id, { ...user }]));

  return {
    getReconcilableUsers: async () => [...rows.values()].map((user) => ({ ...user })),
    disableUserAccount: async ({ id }: { id: number }) => {
      const row = rows.get(id);

      if (!row || unwritable.includes(id)) {
        throw new Error(`could not write account ${id}`);
      }

      row.disabled = true;
    },
    isDisabled: (id: number) => rows.get(id)?.disabled,
    disabledIds: () => [...rows.values()].filter((user) => user.disabled).map((user) => user.id),
  };
};

const InMemoryLog = () => {
  const lines: string[] = [];

  const write = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };

  return { info: write, warn: write, error: write, text: () => lines.join('\n') };
};

let nextUserId = 100;

const signUser = (email: string, overrides: Partial<ReconcilableUser> = {}): ReconcilableUser => {
  nextUserId += 1;

  return {
    id: nextUserId,
    email,
    name: null,
    roles: [Role.USER],
    disabled: false,
    directoryObjectIds: [],
    ...overrides,
  };
};

const config = (overrides: Partial<ReconcileDirectoryAccessConfig> = {}): ReconcileDirectoryAccessConfig => ({
  dryRun: false,
  minimumMemberCount: 1,
  maximumDisableRatio: 1,
  exemptEmails: [],
  ...overrides,
});

const run = async (
  directoryUsers: EntraDirectoryMember[],
  signUsers: ReconcilableUser[],
  overrides: Partial<ReconcileDirectoryAccessConfig> = {},
  faults: { graphFailure?: Error; unwritable?: number[] } = {},
) => {
  const directory = InMemoryGraphDirectory(directoryUsers, { failure: faults.graphFailure });
  const accounts = InMemorySignAccounts(signUsers, { unwritable: faults.unwritable });
  const log = InMemoryLog();

  const result = await reconcileDirectoryAccess({
    config: config(overrides),
    logger: log,
    getDirectoryMembers: directory.getDirectoryMembers,
    getReconcilableUsers: accounts.getReconcilableUsers,
    disableUserAccount: accounts.disableUserAccount,
  });

  return { result, accounts, log };
};

/** The same run, for a run that may reject: the error is returned with the state it left behind. */
const runCatching = async (...args: Parameters<typeof run>) => {
  const [directoryUsers, signUsers, overrides = {}, faults = {}] = args;
  const accounts = InMemorySignAccounts(signUsers, { unwritable: faults.unwritable });
  const log = InMemoryLog();

  const settled = await reconcileDirectoryAccess({
    config: config(overrides),
    logger: log,
    getDirectoryMembers: InMemoryGraphDirectory(directoryUsers, { failure: faults.graphFailure }).getDirectoryMembers,
    getReconcilableUsers: accounts.getReconcilableUsers,
    disableUserAccount: accounts.disableUserAccount,
  }).then(
    (result) => ({ result, rejected: false }),
    (reason: unknown) => ({ result: undefined, rejected: true, reason }),
  );

  return { ...settled, accounts, log };
};

/** Users who keep their accounts, enough to stay above any minimum the test does not exercise. */
const staff = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const entry = member(`staff${nextUserId}-${i}@terrapay.com`);

    return { entry, user: signUser(entry.mail!, { directoryObjectIds: [entry.id] }) };
  });

describe('reading the object id from a stored Microsoft token', () => {
  it('1: returns the oid of a well-formed token from our tenant', () => {
    expect(readDirectoryObjectId(idToken({ oid: 'abc-oid', tid: TENANT_ID }), TENANT_ID)).toBe('abc-oid');
  });

  it('2: returns the oid, never the pairwise sub', () => {
    const oid = readDirectoryObjectId(idToken({ oid: 'the-oid', sub: 'the-sub', tid: TENANT_ID }), TENANT_ID);

    expect(oid).toBe('the-oid');
  });

  it('3: reads the oid from the payload, not from the header', () => {
    const token = idToken({ oid: 'payload-oid', tid: TENANT_ID }, { oid: 'header-oid', tid: TENANT_ID });

    expect(readDirectoryObjectId(token, TENANT_ID)).toBe('payload-oid');
  });

  it('3: decodes the payload as base64url, so a payload containing - and _ still yields its oid', () => {
    const payload = b64url({ oid: 'url-safe-oid', tid: TENANT_ID, filler: '>>>???', more: '~~~???>>>' });

    expect(payload).toMatch(/-/);
    expect(payload).toMatch(/_/);
    expect(readDirectoryObjectId(rawToken(payload), TENANT_ID)).toBe('url-safe-oid');
  });

  it('4: accepts an unpadded payload whose length is not a multiple of four', () => {
    const payload = b64url({ oid: 'unpadded', tid: TENANT_ID, x: 'a' });
    const padded = Buffer.from(JSON.stringify({ oid: 'unpadded', tid: TENANT_ID, x: 'a' })).toString('base64');

    expect(payload).not.toMatch(/=/);
    expect(padded).toMatch(/=$/);
    expect(readDirectoryObjectId(rawToken(payload), TENANT_ID)).toBe('unpadded');
  });

  it.each([
    ['two parts', `${b64url({ alg: 'RS256' })}.${b64url({ oid: 'x', tid: TENANT_ID })}`],
    ['four parts', `${idToken({ oid: 'x', tid: TENANT_ID })}.extra`],
    ['an empty payload', `${b64url({ alg: 'RS256' })}..c2ln`],
    ['a payload that is not base64', rawToken('%%%not base64!!!')],
    ['a payload that is not JSON', rawToken(Buffer.from('not json').toString('base64url'))],
    ['an empty string', ''],
    ['no token at all (null)', null],
    ['no token at all (undefined)', undefined],
  ])('5 / 16: a token with %s yields no identity and does not throw', (_label, token) => {
    expect(() => readDirectoryObjectId(token, TENANT_ID)).not.toThrow();
    expect(readDirectoryObjectId(token, TENANT_ID)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a number', 42],
    ['an array', [{ oid: 'x', tid: TENANT_ID }]],
    ['a string', 'oid'],
  ])('6: a payload that is JSON %s, not an object, yields no identity', (_label, payload) => {
    const token = rawToken(b64url(payload));

    expect(() => readDirectoryObjectId(token, TENANT_ID)).not.toThrow();
    expect(readDirectoryObjectId(token, TENANT_ID)).toBeNull();
  });

  it.each([
    ['a number', 12345],
    ['an object', { id: 'x' }],
    ['an array', ['6f1c0000-1111-4222-8333-000000000000']],
    ['true', true],
  ])('7: an oid that is %s is not coerced into an identity', (_label, oid) => {
    expect(readDirectoryObjectId(idToken({ oid, tid: TENANT_ID }), TENANT_ID)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('8: an oid that is %s is not an identity', (_label, oid) => {
    expect(readDirectoryObjectId(idToken({ oid, tid: TENANT_ID }), TENANT_ID)).toBeNull();
  });

  it('10: a token with no tid is not trusted', () => {
    const payload = b64url({ oid: 'no-tenant', iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0` });

    expect(readDirectoryObjectId(rawToken(payload), TENANT_ID)).toBeNull();
  });

  it('11: a token from another tenant is not trusted, whatever its oid', () => {
    expect(readDirectoryObjectId(idToken({ oid: 'foreign', tid: OTHER_TENANT_ID }), TENANT_ID)).toBeNull();
  });

  it('12: a lower-case tid is trusted when the configured tenant id is written in upper case', () => {
    expect(readDirectoryObjectId(idToken({ oid: 'ours', tid: TENANT_ID }), TENANT_ID.toUpperCase())).toBe('ours');
  });

  it('12: an upper-case tid is trusted when the configured tenant id is written in lower case', () => {
    expect(readDirectoryObjectId(idToken({ oid: 'ours', tid: TENANT_ID.toUpperCase() }), TENANT_ID)).toBe('ours');
  });

  it('13: a tid naming another tenant is not trusted even when iss names ours', () => {
    const token = idToken({
      oid: 'spoofed',
      tid: OTHER_TENANT_ID,
      iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    });

    expect(readDirectoryObjectId(token, TENANT_ID)).toBeNull();
  });

  it('14: the token alone establishes the tenant; nothing beyond the token is needed', () => {
    const payload = b64url({ oid: 'old-row', tid: TENANT_ID });

    expect(readDirectoryObjectId(rawToken(payload), TENANT_ID)).toBe('old-row');
  });

  it('16: a token with no oid yields no identity', () => {
    expect(readDirectoryObjectId(idToken({ tid: TENANT_ID }), TENANT_ID)).toBeNull();
  });

  it('17: an expired token still yields its oid, because expiry is not checked', () => {
    const token = idToken({ oid: 'long-expired', tid: TENANT_ID, exp: 1_000_000_000, nbf: 999_000_000 });

    expect(readDirectoryObjectId(token, TENANT_ID)).toBe('long-expired');
  });
});

describe('who keeps an account', () => {
  it('1 / criterion 1: a Microsoft user whose object id is no longer in the directory is disabled', async () => {
    const [kept] = staff(1);
    const leaver = signUser('leaver@terrapay.com', { directoryObjectIds: [objectId()] });

    const { accounts, result } = await run([kept.entry], [kept.user, leaver]);

    expect(accounts.isDisabled(leaver.id)).toBe(true);
    expect(accounts.isDisabled(kept.user.id)).toBe(false);
    expect(result.disabledUserIds).toEqual([leaver.id]);
    expect(result.failedUserIds).toEqual([]);
  });

  it('1 / criterion 2 / F1: a member renamed in Entra after signing in is kept by object id', async () => {
    const renamed = member('new.name@terrapay.com');
    const user = signUser('old.name@terrapay.com', { directoryObjectIds: [renamed.id] });

    const { accounts } = await run([renamed], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('9: a stored object id in upper case with braces matches the lower-case Graph id', async () => {
    const entry = member('guid@terrapay.com');
    const user = signUser('a@terrapay.com', { directoryObjectIds: [`{${entry.id.toUpperCase()}}`] });

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('9: a lower-case stored object id matches a Graph id written in upper case', async () => {
    const entry = member('upper@terrapay.com', { id: objectId().toUpperCase() });
    const user = signUser('b@terrapay.com', { directoryObjectIds: [entry.id.toLowerCase()] });

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('9: an oid read from a token in upper case with braces keeps the member whose Graph id is lower case', async () => {
    const entry = member('braced@terrapay.com');
    const oid = readDirectoryObjectId(idToken({ oid: `{${entry.id.toUpperCase()}}`, tid: TENANT_ID }), TENANT_ID);
    const user = signUser('someone-else@terrapay.com', { directoryObjectIds: oid ? [oid] : [] });

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('15: an account whose only token is from another tenant is matched by email, as if it had no identity', async () => {
    const holder = member('shared@terrapay.com');
    const oid = readDirectoryObjectId(idToken({ oid: objectId(), tid: OTHER_TENANT_ID }), TENANT_ID);
    const user = signUser('shared@terrapay.com', { directoryObjectIds: oid ? [oid] : [] });

    const { accounts } = await run([holder], [user]);

    expect(oid).toBeNull();
    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('16: an account whose token is malformed is matched by email, and the run still decides for everyone', async () => {
    const holder = member('mangled@terrapay.com');
    const oid = readDirectoryObjectId('not.a.token.at.all', TENANT_ID);
    const user = signUser('mangled@terrapay.com', { directoryObjectIds: oid ? [oid] : [] });
    const leaver = signUser('gone@terrapay.com', { directoryObjectIds: [objectId()] });

    const { accounts, result } = await run([holder], [user, leaver]);

    expect(result.outcome).toBe('completed');
    expect(accounts.isDisabled(user.id)).toBe(false);
    expect(accounts.isDisabled(leaver.id)).toBe(true);
  });

  it('19: a user whose first identity is gone and whose second is an enabled member is kept', async () => {
    const entry = member('second@terrapay.com');
    const user = signUser('second@terrapay.com', { directoryObjectIds: [objectId(), entry.id] });

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('21: a user with several identities is kept if any one is an enabled member', async () => {
    const enabled = member('one@terrapay.com');
    const disabledEntry = member('two@terrapay.com', { accountEnabled: false });
    const user = signUser('x@terrapay.com', { directoryObjectIds: [enabled.id, disabledEntry.id, objectId()] });

    const { accounts } = await run([enabled, disabledEntry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('21: a user none of whose identities is an enabled member is disabled', async () => {
    const [kept] = staff(1);
    const disabledEntry = member('dis@terrapay.com', { accountEnabled: false });
    const user = signUser('dis@terrapay.com', { directoryObjectIds: [disabledEntry.id, objectId()] });

    const { accounts } = await run([kept.entry, disabledEntry], [kept.user, user]);

    expect(accounts.isDisabled(user.id)).toBe(true);
  });

  it('22: the order of a user’s identities does not change the decision', async () => {
    const entry = member('order@terrapay.com');
    const gone = objectId();
    const forwards = signUser('f@terrapay.com', { directoryObjectIds: [gone, entry.id] });
    const backwards = signUser('b@terrapay.com', { directoryObjectIds: [entry.id, gone] });

    const { accounts } = await run([entry], [forwards, backwards]);

    expect(accounts.isDisabled(forwards.id)).toBe(false);
    expect(accounts.isDisabled(backwards.id)).toBe(false);
  });
});

describe('matching by address, for accounts with no Microsoft identity', () => {
  it('criterion 4: kept when an enabled member has the address, disabled otherwise', async () => {
    const entry = member('ana@terrapay.com');
    const kept = signUser('ana@terrapay.com');
    const stranger = signUser('nobody@terrapay.com');

    const { accounts } = await run([entry], [kept, stranger]);

    expect(accounts.isDisabled(kept.id)).toBe(false);
    expect(accounts.isDisabled(stranger.id)).toBe(true);
  });

  it('23: a member with no mailbox keeps the account through the sign-in name', async () => {
    const entry = member('upn.only@terrapay.com', { mail: null });
    const user = signUser('upn.only@terrapay.com');

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('24: a member whose sign-in name differs from the mail address keeps an account under either', async () => {
    const entry = member('jo.smith@terrapay.com', { userPrincipalName: 'jsmith@terrapay.onmicrosoft.com' });
    const byMail = signUser('jo.smith@terrapay.com');
    const byUpn = signUser('jsmith@terrapay.onmicrosoft.com');

    const { accounts } = await run([entry], [byMail, byUpn]);

    expect(accounts.isDisabled(byMail.id)).toBe(false);
    expect(accounts.isDisabled(byUpn.id)).toBe(false);
  });

  it('25: a member with no mail does not keep an account whose address is "null" or empty', async () => {
    const [kept] = staff(1);
    const entry = member('real@terrapay.com', { mail: null });
    const nullText = signUser('null');
    const empty = signUser('');

    const { accounts } = await run([kept.entry, entry], [kept.user, nullText, empty]);

    expect(accounts.isDisabled(nullText.id)).toBe(true);
    expect(accounts.isDisabled(empty.id)).toBe(true);
  });

  it('26 / criterion 5 / F7: addresses match regardless of case on either side', async () => {
    const entry = member('Mixed.Case@TerraPay.com', { userPrincipalName: 'MIXED.CASE@TERRAPAY.COM' });
    const user = signUser('mixed.CASE@terrapay.COM');

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('27 / criterion 5 / F7: surrounding whitespace on either side is ignored', async () => {
    const entry = member('  padded@terrapay.com\t', { userPrincipalName: ' padded@terrapay.com ' });
    const user = signUser('\tpadded@terrapay.com  ');

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('27: internal whitespace is not stripped, so "a b@x" does not match "ab@x"', async () => {
    const [kept] = staff(1);
    const entry = member('ab@terrapay.com');
    const user = signUser('a b@terrapay.com');

    const { accounts } = await run([kept.entry, entry], [kept.user, user]);

    expect(accounts.isDisabled(user.id)).toBe(true);
  });

  it('28: non-ASCII letters that differ only in case match the same way on both sides', async () => {
    const entry = member('ÉLODIE.İNCE@TERRAPAY.COM', { userPrincipalName: 'elodie@terrapay.com' });
    const user = signUser('élodie.İnce@terrapay.com');

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('29: plus-addressing and dots are not normalised away', async () => {
    const [kept] = staff(1);
    const entry = member('jo@terrapay.com');
    const plus = signUser('jo+old@terrapay.com');
    const dotted = signUser('j.o@terrapay.com');

    const { accounts } = await run([kept.entry, entry], [kept.user, plus, dotted]);

    expect(accounts.isDisabled(plus.id)).toBe(true);
    expect(accounts.isDisabled(dotted.id)).toBe(true);
  });

  it('31: an address held only by a disabled Entra user does not keep an account', async () => {
    const [kept] = staff(1);
    const entry = member('suspended@terrapay.com', { accountEnabled: false });
    const user = signUser('suspended@terrapay.com');

    const { accounts } = await run([kept.entry, entry], [kept.user, user]);

    expect(accounts.isDisabled(user.id)).toBe(true);
  });

  it('32 / criterion 3 / F2: a leaver whose address now belongs to an enabled member is disabled', async () => {
    const newcomer = member('reused@terrapay.com');
    const leaver = signUser('reused@terrapay.com', { directoryObjectIds: [objectId()] });

    const { accounts } = await run([newcomer], [leaver]);

    expect(accounts.isDisabled(leaver.id)).toBe(true);
  });

  it('33: an identity that is a disabled user is not rescued by an enabled member holding the address', async () => {
    const disabledSelf = member('old.me@terrapay.com', { accountEnabled: false });
    const holder = member('taken@terrapay.com');
    const user = signUser('taken@terrapay.com', { directoryObjectIds: [disabledSelf.id] });

    const { accounts } = await run([disabledSelf, holder], [user]);

    expect(accounts.isDisabled(user.id)).toBe(true);
  });

  it('34: when a disabled user and an enabled member share an address, page order does not decide', async () => {
    const enabled = member('twin@terrapay.com');
    const disabledTwin = member('twin@terrapay.com', { accountEnabled: false });
    const first = signUser('twin@terrapay.com');
    const second = signUser('twin@terrapay.com');

    const enabledFirst = await run([enabled, disabledTwin], [first]);
    const enabledLast = await run([disabledTwin, enabled], [second]);

    expect(enabledFirst.accounts.isDisabled(first.id)).toBe(false);
    expect(enabledLast.accounts.isDisabled(second.id)).toBe(false);
  });
});

describe('accounts the sync never disables', () => {
  it('criterion 6 / 46: an administrator holding ADMIN among other roles is never disabled', async () => {
    const [kept] = staff(1);
    const admin = signUser('admin@terrapay.com', { roles: [Role.USER, Role.ADMIN], directoryObjectIds: [objectId()] });
    const adminOnly = signUser('root@terrapay.com', { roles: [Role.ADMIN] });

    const { accounts } = await run([kept.entry], [kept.user, admin, adminOnly]);

    expect(accounts.isDisabled(admin.id)).toBe(false);
    expect(accounts.isDisabled(adminOnly.id)).toBe(false);
  });

  it('41 / criterion 8: an exempt address is never disabled, whatever its case on either side', async () => {
    const [kept] = staff(1);
    const exempt = signUser('Ops@TerraPay.com', { directoryObjectIds: [objectId()] });

    const { accounts } = await run([kept.entry], [kept.user, exempt], { exemptEmails: ['ops@terrapay.COM'] });

    expect(accounts.isDisabled(exempt.id)).toBe(false);
  });

  it('42: an empty exempt entry exempts nobody', async () => {
    const [kept] = staff(1);
    const leaver = signUser('leaver@terrapay.com');
    const blank = signUser('');

    const { accounts } = await run([kept.entry], [kept.user, leaver, blank], {
      exemptEmails: ['', 'ops@terrapay.com', ''],
    });

    expect(accounts.isDisabled(leaver.id)).toBe(true);
    expect(accounts.isDisabled(blank.id)).toBe(true);
  });

  it('43: the exemption follows the Sign address, not a directory address', async () => {
    const [kept] = staff(1);
    const renamedAway = member('ops@terrapay.com', { accountEnabled: false });
    const exemptSign = signUser('shared-box@terrapay.com');
    const notExempt = signUser('former@terrapay.com', { directoryObjectIds: [renamedAway.id] });

    const { accounts } = await run([kept.entry, renamedAway], [kept.user, exemptSign, notExempt], {
      exemptEmails: ['shared-box@terrapay.com', 'ops@terrapay.com'],
    });

    expect(accounts.isDisabled(exemptSign.id)).toBe(false);
    expect(accounts.isDisabled(notExempt.id)).toBe(true);
  });
});

describe('the disable limit', () => {
  it('criterion 13: more than the ratio of considered accounts stops the run and disables nobody', async () => {
    const kept = staff(26);
    const leavers = Array.from({ length: 4 }, (_, i) => signUser(`gone${i}@terrapay.com`));

    const { accounts, result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), ...leavers],
      { maximumDisableRatio: 0.1 },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.abortReason).toBe('disable-ratio-exceeded');
    expect(accounts.disabledIds()).toEqual([]);
  });

  it.each([
    [0.1, 10, 1],
    [0.1, 30, 3],
    [0.1, 70, 7],
    [0.29, 100, 29],
    [0.5, 2, 1],
    [0.5, 10, 5],
  ])('50: exactly the ratio %s (%i considered, %i to disable) is allowed', async (ratio, considered, toDisable) => {
    const kept = staff(considered - toDisable);
    const leavers = Array.from({ length: toDisable }, (_, i) => signUser(`gone${i}@terrapay.com`));

    const { accounts, result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), ...leavers],
      { maximumDisableRatio: ratio },
    );

    expect(result.outcome).toBe('completed');
    expect(accounts.disabledIds().sort()).toEqual(leavers.map((l) => l.id).sort());
  });

  it('47 / criterion 8: exempt non-members are not counted as accounts to disable', async () => {
    const kept = staff(9);
    const leaver = signUser('gone@terrapay.com');
    const exempt = Array.from({ length: 5 }, (_, i) => signUser(`box${i}@terrapay.com`));

    const { accounts, result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), leaver, ...exempt],
      { maximumDisableRatio: 0.1, exemptEmails: exempt.map((e) => e.email) },
    );

    expect(result.outcome).toBe('completed');
    expect(accounts.disabledIds()).toEqual([leaver.id]);
  });

  it('48 / F5: exempt accounts do not inflate the denominator and lift the limit', async () => {
    const kept = staff(8);
    const leavers = [signUser('gone1@terrapay.com'), signUser('gone2@terrapay.com')];
    const exemptMembers = staff(10);

    const { accounts, result } = await run(
      [...kept, ...exemptMembers].map((k) => k.entry),
      [...kept.map((k) => k.user), ...leavers, ...exemptMembers.map((k) => k.user)],
      { maximumDisableRatio: 0.1, exemptEmails: exemptMembers.map((k) => k.user.email) },
    );

    expect(result.outcome).toBe('aborted');
    expect(accounts.disabledIds()).toEqual([]);
  });

  it('49: admins do not count in the denominator', async () => {
    const kept = staff(8);
    const leavers = [signUser('gone1@terrapay.com'), signUser('gone2@terrapay.com')];
    const admins = Array.from({ length: 10 }, (_, i) => signUser(`admin${i}@terrapay.com`, { roles: [Role.ADMIN] }));

    const { accounts, result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), ...leavers, ...admins],
      { maximumDisableRatio: 0.1 },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.consideredUserCount).toBe(10);
    expect(accounts.disabledIds()).toEqual([]);
  });

  it('49: already-disabled accounts do not count in the denominator', async () => {
    const kept = staff(8);
    const leavers = [signUser('gone1@terrapay.com'), signUser('gone2@terrapay.com')];
    const dormant = Array.from({ length: 10 }, (_, i) => signUser(`dormant${i}@terrapay.com`, { disabled: true }));
    const dormantIds = dormant.map((d) => d.id).sort();

    const { accounts, result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), ...leavers, ...dormant],
      { maximumDisableRatio: 0.1 },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.consideredUserCount).toBe(10);
    expect(accounts.disabledIds().sort()).toEqual(dormantIds);
  });

  it('49: the denominator is exactly the accounts the sync could disable', async () => {
    const kept = staff(9);
    const leaver = signUser('gone@terrapay.com');
    const admin = signUser('admin@terrapay.com', { roles: [Role.ADMIN] });
    const dormant = signUser('dormant@terrapay.com', { disabled: true });
    const exempt = signUser('box@terrapay.com');

    const { result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), leaver, admin, dormant, exempt],
      { maximumDisableRatio: 0.1, exemptEmails: [exempt.email] },
    );

    expect(result.consideredUserCount).toBe(10);
    expect(result.outcome).toBe('completed');
  });

  it('51: a run with no accounts it could disable completes and disables nobody', async () => {
    const entry = member('only@terrapay.com');
    const admin = signUser('admin@terrapay.com', { roles: [Role.ADMIN] });
    const exempt = signUser('box@terrapay.com');

    const { accounts, result } = await run([entry], [admin, exempt], {
      maximumDisableRatio: 0.1,
      exemptEmails: [exempt.email],
    });

    expect(result.outcome).toBe('completed');
    expect(accounts.disabledIds()).toEqual([]);
  });
});

describe('the minimum membership', () => {
  it('criterion 12: fewer enabled members than the minimum stops the run and disables nobody', async () => {
    const kept = staff(2);
    const leaver = signUser('gone@terrapay.com');

    const { accounts, result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), leaver],
      { minimumMemberCount: 3 },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.abortReason).toBe('membership-below-floor');
    expect(accounts.disabledIds()).toEqual([]);
  });

  it('52: exactly the minimum lets the run act', async () => {
    const kept = staff(3);
    const leaver = signUser('gone@terrapay.com');

    const { accounts, result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), leaver],
      { minimumMemberCount: 3 },
    );

    expect(result.outcome).toBe('completed');
    expect(accounts.disabledIds()).toEqual([leaver.id]);
  });

  it('53: disabled directory users do not count toward the minimum', async () => {
    const kept = staff(2);
    const disabledEntries = [
      member('d1@terrapay.com', { accountEnabled: false }),
      member('d2@terrapay.com', { accountEnabled: false }),
    ];
    const leaver = signUser('gone@terrapay.com');

    const { accounts, result } = await run(
      [...kept.map((k) => k.entry), ...disabledEntries],
      [...kept.map((k) => k.user), leaver],
      { minimumMemberCount: 3 },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.abortReason).toBe('membership-below-floor');
    expect(accounts.disabledIds()).toEqual([]);
  });

  it('54: members with exempt addresses still count toward the minimum', async () => {
    const kept = staff(2);
    const exemptMember = member('ops@terrapay.com');
    const leaver = signUser('gone@terrapay.com');

    const { accounts, result } = await run(
      [...kept.map((k) => k.entry), exemptMember],
      [...kept.map((k) => k.user), leaver],
      { minimumMemberCount: 3, exemptEmails: ['ops@terrapay.com'] },
    );

    expect(result.outcome).toBe('completed');
    expect(accounts.disabledIds()).toEqual([leaver.id]);
  });
});

describe('already-disabled accounts', () => {
  it('57 / criterion 10: a disabled leaver is not disabled again', async () => {
    const [kept] = staff(1);
    const dormant = signUser('dormant@terrapay.com', { disabled: true, directoryObjectIds: [objectId()] });

    const { result } = await run([kept.entry], [kept.user, dormant]);

    expect(result.candidateUserIds).not.toContain(dormant.id);
    expect(result.disabledUserIds).not.toContain(dormant.id);
  });

  it('58: a disabled account that reappears as an enabled member stays disabled', async () => {
    const entry = member('back@terrapay.com');
    const dormant = signUser('back@terrapay.com', { disabled: true, directoryObjectIds: [entry.id] });

    const { accounts, result } = await run([entry], [dormant]);

    expect(accounts.isDisabled(dormant.id)).toBe(true);
    expect(result.candidateUserIds).not.toContain(dormant.id);
  });

  it('59: disabled accounts are not counted as accounts to disable', async () => {
    const kept = staff(9);
    const leaver = signUser('gone@terrapay.com');
    const dormant = Array.from({ length: 5 }, (_, i) => signUser(`dormant${i}@terrapay.com`, { disabled: true }));

    const { result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), leaver, ...dormant],
      { maximumDisableRatio: 0.1 },
    );

    expect(result.outcome).toBe('completed');
    expect(result.disabledUserIds).toEqual([leaver.id]);
  });
});

describe('determinism and reporting', () => {
  it('60: the same directory and accounts in a different order give the same decision', async () => {
    const kept = staff(6);
    const twinEnabled = member('twin@terrapay.com');
    const twinDisabled = member('twin@terrapay.com', { accountEnabled: false });
    const twinUser = signUser('twin@terrapay.com');
    const leavers = [
      signUser('gone1@terrapay.com'),
      signUser('gone2@terrapay.com', { directoryObjectIds: [objectId()] }),
    ];
    const directory = [...kept.map((k) => k.entry), twinEnabled, twinDisabled];
    const users = [...kept.map((k) => k.user), twinUser, ...leavers];

    const forwards = await run(directory, users);
    const backwards = await run([...directory].reverse(), [...users].reverse());

    expect(forwards.accounts.disabledIds().sort()).toEqual(leavers.map((l) => l.id).sort());
    expect(backwards.accounts.disabledIds().sort()).toEqual(forwards.accounts.disabledIds().sort());
  });

  it('11 / 62: a dry run disables nobody and names each account it would disable', async () => {
    const [kept] = staff(1);
    const leaver = signUser('would.go@terrapay.com', { directoryObjectIds: [objectId()] });

    const { accounts, result, log } = await run([kept.entry], [kept.user, leaver], { dryRun: true });

    expect(accounts.disabledIds()).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.candidateUserIds).toEqual([leaver.id]);
    expect(log.text()).toContain('would.go@terrapay.com');
  });
});

describe('failures and what the run reports (entries 63 to 67, added by mutation testing)', () => {
  it('63 / criterion 14 / F4: a failed directory read disables nobody and logs the failure', async () => {
    const leaver = signUser('gone@terrapay.com', { directoryObjectIds: [objectId()] });

    const { accounts, result, log } = await runCatching(
      [],
      [leaver],
      {},
      {
        graphFailure: new Error('Graph page 3 timed out after 30000 ms'),
      },
    );

    expect(result?.outcome ?? 'rejected').not.toBe('completed');
    expect(accounts.disabledIds()).toEqual([]);
    expect(log.text()).toContain('Graph page 3 timed out after 30000 ms');
  });

  it('64: a run stopped by the disable limit logs which accounts it would have disabled', async () => {
    const kept = staff(26);
    const leavers = Array.from({ length: 4 }, (_, i) => signUser(`limit${i}@terrapay.com`));

    const { log } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), ...leavers],
      { maximumDisableRatio: 0.1 },
    );

    for (const leaver of leavers) {
      const named = log.text().includes(leaver.email) || new RegExp(`\\b${leaver.id}\\b`).test(log.text());

      expect(named, `the log names ${leaver.email} (user ${leaver.id}):\n${log.text()}`).toBe(true);
    }
  });

  it('64: a run stopped by the minimum logs how many members the directory returned and the minimum', async () => {
    const kept = staff(7);

    const { log } = await run(
      kept.map((k) => k.entry),
      kept.map((k) => k.user),
      { minimumMemberCount: 11 },
    );

    expect(log.text()).toMatch(/\b7\b/);
    expect(log.text()).toMatch(/\b11\b/);
  });

  it('65: one account that cannot be disabled does not stop the others, and is reported as failed', async () => {
    const [kept] = staff(1);
    const stuck = signUser('stuck@terrapay.com');
    const leavers = [signUser('gone1@terrapay.com'), signUser('gone2@terrapay.com')];

    const { accounts, result, log, rejected } = await runCatching(
      [kept.entry],
      [kept.user, stuck, ...leavers],
      {},
      { unwritable: [stuck.id] },
    );

    expect(rejected).toBe(false);
    expect(accounts.disabledIds().sort()).toEqual(leavers.map((l) => l.id).sort());
    expect(result?.disabledUserIds.sort()).toEqual(leavers.map((l) => l.id).sort());
    expect(result?.failedUserIds).toEqual([stuck.id]);
    expect(log.text()).toContain('stuck@terrapay.com');
  });

  it('66: a run stopped by the disable limit reports who it would have disabled and that it disabled nobody', async () => {
    const kept = staff(26);
    const leavers = Array.from({ length: 4 }, (_, i) => signUser(`gone${i}@terrapay.com`));

    const { result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), ...leavers],
      { maximumDisableRatio: 0.1 },
    );

    expect([...result.candidateUserIds].sort()).toEqual(leavers.map((l) => l.id).sort());
    expect(result.disabledUserIds).toEqual([]);
    expect(result.failedUserIds).toEqual([]);
  });

  it('66: a run stopped by the minimum reports that it disabled nobody and names no stray accounts', async () => {
    const kept = staff(2);
    const leaver = signUser('gone@terrapay.com');

    const { result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), leaver],
      { minimumMemberCount: 3 },
    );

    expect(result.candidateUserIds.every((id) => id === leaver.id)).toBe(true);
    expect(result.disabledUserIds).toEqual([]);
    expect(result.failedUserIds).toEqual([]);
  });

  it('66: the run reports admins and exempt accounts separately, each counted once', async () => {
    const kept = staff(3);
    const admin = signUser('admin@terrapay.com', { roles: [Role.ADMIN] });
    const exemptAdmin = signUser('exempt.admin@terrapay.com', { roles: [Role.ADMIN] });
    const exempt = [signUser('box1@terrapay.com'), signUser('box2@terrapay.com')];

    const { result } = await run(
      kept.map((k) => k.entry),
      [...kept.map((k) => k.user), admin, exemptAdmin, ...exempt],
      { exemptEmails: [...exempt.map((e) => e.email), exemptAdmin.email] },
    );

    expect(result.skippedAdminCount).toBe(2);
    expect(result.exemptUserCount).toBe(2);
    expect(result.consideredUserCount).toBe(3);
  });

  it('67: a live run logs each account it disabled, by address', async () => {
    const [kept] = staff(1);
    const leaver = signUser('audit.me@terrapay.com', { directoryObjectIds: [objectId()] });

    const { log } = await run([kept.entry], [kept.user, leaver]);

    expect(log.text()).toContain('audit.me@terrapay.com');
  });
});

describe('object id normalisation (entries 68 to 70, added by mutation testing)', () => {
  it('68: a stored object id with surrounding whitespace matches the directory id', async () => {
    const entry = member('padded.id@terrapay.com');
    const user = signUser('nobody-holds-this@terrapay.com', { directoryObjectIds: [`  ${entry.id}\t`] });

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('68: a directory id with surrounding whitespace matches the stored object id', async () => {
    const id = objectId();
    const entry = member('padded.graph@terrapay.com', { id: ` ${id} ` });
    const user = signUser('nobody-holds-this@terrapay.com', { directoryObjectIds: [id] });

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it('68: whitespace around and inside surrounding braces is ignored', async () => {
    const entry = member('braced.padded@terrapay.com');
    const user = signUser('nobody-holds-this@terrapay.com', {
      directoryObjectIds: [` { ${entry.id.toUpperCase()} } `],
    });

    const { accounts } = await run([entry], [user]);

    expect(accounts.isDisabled(user.id)).toBe(false);
  });

  it.each([
    ['an opening brace only', (id: string) => `{${id}`],
    ['a closing brace only', (id: string) => `${id}}`],
    ['braces with text before them', (id: string) => `${id.slice(0, 9)}{${id.slice(9)}}`],
    ['braces with text after them', (id: string) => `{${id.slice(0, 9)}}${id.slice(9)}`],
  ])('69: a stored id with %s is not treated as braced and does not match', async (_label, mangle) => {
    const [kept] = staff(1);
    const entry = member('brace.target@terrapay.com');
    const user = signUser('nobody-holds-this@terrapay.com', { directoryObjectIds: [mangle(entry.id)] });

    const { accounts } = await run([kept.entry, entry], [kept.user, user]);

    expect(accounts.isDisabled(user.id)).toBe(true);
  });

  it.each([
    ['an opening brace only', (id: string) => `{${id}`],
    ['braces with text before them', (id: string) => `${id.slice(0, 9)}{${id.slice(9)}}`],
    ['braces with text after them', (id: string) => `{${id.slice(0, 9)}}${id.slice(9)}`],
  ])('69: a directory id with %s is not treated as braced and does not match', async (_label, mangle) => {
    const [kept] = staff(1);
    const id = objectId();
    const entry = member('brace.graph@terrapay.com', { id: mangle(id) });
    const user = signUser('nobody-holds-this@terrapay.com', { directoryObjectIds: [id] });

    const { accounts } = await run([kept.entry, entry], [kept.user, user]);

    expect(accounts.isDisabled(user.id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['empty braces', '{}'],
    ['blank braces', '{  }'],
  ])('70: a %s directory id does not keep an account whose stored id is equally empty', async (_label, blank) => {
    const [kept] = staff(1);
    const entry = member('blank.id@terrapay.com', { id: blank });
    const user = signUser('nobody-holds-this@terrapay.com', { directoryObjectIds: [blank, '{}', ' '] });

    const { accounts } = await run([kept.entry, entry], [kept.user, user]);

    expect(accounts.isDisabled(user.id)).toBe(true);
  });
});
