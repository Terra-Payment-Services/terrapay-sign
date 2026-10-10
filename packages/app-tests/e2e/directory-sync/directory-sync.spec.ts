/**
 * Directory sync, who is kept and who is disabled.
 *
 * Written from the specification alone. Each test seeds Sign accounts in a
 * database of its own, describes the tenant to a stub of Microsoft Graph and
 * the login endpoint, starts the built server with the sync configured
 * against the stub, runs the job once as the scheduler would, and then reads
 * what an operator would see: whether the account is disabled, whether its API
 * tokens still work, whether its webhooks still fire, and what the run logged.
 *
 * Criteria are numbered as in the specification; F-numbers are its failure
 * modes.
 */
// First, so the specs' database is chosen before @documenso/prisma connects.
import './support/worker-database';

import { randomBytes, randomUUID } from 'node:crypto';

import { prisma } from '@documenso/prisma';

import {
  ACTIVE,
  accountState,
  CUT_OFF,
  disabledUserCount,
  guest,
  member,
  OTHER_TENANT_ID,
  seedSignAccount,
  seedStaff,
  serviceAccounts,
} from './support/entra';
import { expect, expectDirectoryWasRead, type SyncRun, test } from './support/fixture';
import type { DirectoryUser } from './support/graph-stub';
import { SYNC_CLIENT_SECRET, TENANT_ID } from './support/tenant';

test.describe.configure({ mode: 'parallel', timeout: 300_000 });

const address = (who: string) => `${who}-${randomBytes(3).toString('hex')}@terrapay-stub.example`;

test.describe('[DIRECTORY SYNC]: who keeps an account', () => {
  test('1: a Microsoft user who is no longer in the tenant is disabled, with tokens expired and webhooks off', async ({
    sync,
  }) => {
    await seedStaff(4, sync.directory);
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('1: a Microsoft user whose Entra account is disabled is disabled', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const email = address('switched-off');
    const entry = member(email, { accountEnabled: false });
    sync.directory.push(entry);
    const leaver = await seedSignAccount({ email, microsoft: { objectId: entry.id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('1: staff still in the tenant keep working accounts', async ({ sync }) => {
    const staff = await seedStaff(4, sync.directory);
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);

    for (const person of staff) {
      expect(await accountState(person.id)).toEqual(ACTIVE);
    }
  });

  test('2 / F1: a user renamed in Entra after first signing in is kept', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const oldAddress = address('priya.old');
    const entry = member(address('priya.new'));
    sync.directory.push(entry);
    const renamed = await seedSignAccount({ email: oldAddress, microsoft: { objectId: entry.id } });
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(renamed.id)).toEqual(ACTIVE);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('3 / F2: a leaver whose old address now belongs to someone else is disabled', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const reused = address('accounts');
    const leaver = await seedSignAccount({ email: reused, microsoft: { objectId: member('gone').id } });
    sync.directory.push(member(reused));

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('4: a user who never signed in with Microsoft is kept when an enabled member has the address', async ({
    sync,
  }) => {
    await seedStaff(4, sync.directory);
    const email = address('password-user');
    sync.directory.push(member(email));
    const kept = await seedSignAccount({ email });
    const leaver = await seedSignAccount({ email: address('password-leaver') });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(kept.id)).toEqual(ACTIVE);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('4: the sign-in name counts as the address when a member has no mail', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const email = address('no-mailbox');
    sync.directory.push(member(email, { mail: null }));
    const kept = await seedSignAccount({ email });
    const leaver = await seedSignAccount({ email: address('password-leaver') });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(kept.id)).toEqual(ACTIVE);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('4: an address held only by a disabled Entra account does not keep a user', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const email = address('former');
    sync.directory.push(member(email, { accountEnabled: false }));
    const leaver = await seedSignAccount({ email });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('5 / F7: addresses match regardless of case and surrounding whitespace', async ({ sync }) => {
    await seedStaff(4, sync.directory);

    const a = address('mixedcase');
    const b = address('padded');
    const c = address('stored-upper');
    sync.directory.push(member(a, { mail: a.toUpperCase(), userPrincipalName: a.toUpperCase() }));
    sync.directory.push(member(b, { mail: `  ${b}  `, userPrincipalName: ` ${b}\t` }));
    sync.directory.push(member(c));

    const lower = await seedSignAccount({ email: a });
    const padded = await seedSignAccount({ email: b });
    const upper = await seedSignAccount({ email: c, storedEmail: c.replace(/^stored-upper/, 'Stored-UPPER') });
    const leaver = await seedSignAccount({ email: address('password-leaver') });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(lower.id)).toEqual(ACTIVE);
    expect(await accountState(padded.id)).toEqual(ACTIVE);
    expect(await accountState(upper.id)).toEqual(ACTIVE);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('6 / F3: platform administrators are never disabled', async ({ sync }) => {
    await seedStaff(6, sync.directory);
    const admin = await seedSignAccount({ email: address('admin'), isAdmin: true });
    const microsoftAdmin = await seedSignAccount({
      email: address('ms-admin'),
      isAdmin: true,
      microsoft: { objectId: member('gone').id },
    });
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(admin.id)).toEqual(ACTIVE);
    expect(await accountState(microsoftAdmin.id)).toEqual(ACTIVE);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('7 / F3: the two built-in service accounts are never disabled', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);

    const accounts = await serviceAccounts();

    expect(accounts).toHaveLength(2);
    expect(accounts.every((a) => !a.disabled)).toBe(true);
  });

  test('8 / F3: exempt accounts are never disabled, whatever the case and spacing of the list', async ({ sync }) => {
    await seedStaff(6, sync.directory);
    const first = address('robot');
    const second = address('auditor');
    const exemptA = await seedSignAccount({ email: first });
    const exemptB = await seedSignAccount({ email: second, microsoft: { objectId: member('gone').id } });
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run({
      env: { NEXT_PRIVATE_ENTRA_RECONCILE_EXEMPT_EMAILS: ` ${first.toUpperCase()} ,${second}, ` },
    });

    expectDirectoryWasRead(run);
    expect(await accountState(exemptA.id)).toEqual(ACTIVE);
    expect(await accountState(exemptB.id)).toEqual(ACTIVE);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('9: a guest in the tenant does not keep a Sign account', async ({ sync }) => {
    await seedStaff(6, sync.directory);
    const byEmail = address('contractor');
    const viaMicrosoft = address('partner');
    sync.directory.push(guest(byEmail));
    const guestEntry = guest(viaMicrosoft);
    sync.directory.push(guestEntry);

    const emailGuest = await seedSignAccount({ email: byEmail });
    const microsoftGuest = await seedSignAccount({ email: viaMicrosoft, microsoft: { objectId: guestEntry.id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(emailGuest.id)).toEqual(CUT_OFF);
    expect(await accountState(microsoftGuest.id)).toEqual(CUT_OFF);
  });

  test('10: an already-disabled account is left exactly as it was, even if it reappears in the tenant', async ({
    sync,
  }) => {
    await seedStaff(4, sync.directory);
    const gone = await seedSignAccount({
      email: address('gone'),
      disabled: true,
      microsoft: { objectId: member('x').id },
    });
    const back = address('returned');
    const backEntry = member(back);
    sync.directory.push(backEntry);
    const returned = await seedSignAccount({ email: back, disabled: true, microsoft: { objectId: backEntry.id } });
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);

    // Seeded disabled with a live token and an enabled webhook; nothing the run
    // does should touch either account.
    expect(await accountState(gone.id)).toEqual({ ...ACTIVE, disabled: true });
    expect(await accountState(returned.id)).toEqual({ ...ACTIVE, disabled: true });
  });

  for (const [label, value] of [
    ['unset', undefined],
    ['"true"', 'true'],
    ['"FALSE"', 'FALSE'],
  ] as const) {
    test(`11: dry run (${label}) reports who would be disabled and disables nobody`, async ({ sync }) => {
      await seedStaff(4, sync.directory);
      const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

      const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: value } });

      expectDirectoryWasRead(run);
      expect(await disabledUserCount()).toBe(0);
      expect(await accountState(leaver.id)).toEqual(ACTIVE);

      const named = run.log.includes(leaver.email) || new RegExp(`\\b${leaver.id}\\b`).test(run.log);
      expect(named, `the dry run log names ${leaver.email} (user ${leaver.id}):\n${run.log}`).toBe(true);
    });
  }

  test('F8: a Microsoft identity issued by another tenant does not keep an account', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    // The foreign token carries an object id that an enabled member of our
    // tenant has, and an address our tenant does not have.
    const insider = sync.directory[0];
    const foreign = await seedSignAccount({
      email: address('outsider'),
      microsoft: { objectId: insider.id, tenantId: OTHER_TENANT_ID },
    });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(foreign.id)).toEqual(CUT_OFF);
  });

  test('15: every page is read before anyone is disabled, and members on the last page are kept', async ({ sync }) => {
    const staff = await seedStaff(6, sync.directory);
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const disabledBeforeLastPage: number[] = [];

    const run = await sync.run({
      stub: {
        maxPageSize: 2,
        beforePage: async (page) => {
          if (page === 3) {
            disabledBeforeLastPage.push(await disabledUserCount());
          }
        },
      },
    });

    expectDirectoryWasRead(run);

    const pages = run.stub.userPageRequests();
    expect(pages.map((p) => p.page)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(pages.filter((p) => (p.page ?? 0) > 1).every((p) => p.url.includes('$skiptoken='))).toBe(true);

    expect(disabledBeforeLastPage.length).toBeGreaterThan(0);
    expect(disabledBeforeLastPage.every((count) => count === 0)).toBe(true);

    expect(await accountState(leaver.id)).toEqual(CUT_OFF);

    for (const person of staff) {
      expect(await accountState(person.id)).toEqual(ACTIVE);
    }
  });

  test('19: a Microsoft user whose accountEnabled comes back null is disabled', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const email = address('null-enabled');
    const entry = member(email, { accountEnabled: null });
    sync.directory.push(entry);
    const leaver = await seedSignAccount({ email, microsoft: { objectId: entry.id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('19: a Microsoft user whose accountEnabled is missing from the response is disabled', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const email = address('no-enabled');
    const entry = member(email, { accountEnabled: null, absent: ['accountEnabled'] });
    sync.directory.push(entry);
    const leaver = await seedSignAccount({ email, microsoft: { objectId: entry.id } });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('19: an address held only by a user with accountEnabled null or missing keeps nobody', async ({ sync }) => {
    await seedStaff(6, sync.directory);
    const nullEmail = address('null-address');
    const absentEmail = address('absent-address');
    sync.directory.push(member(nullEmail, { accountEnabled: null }));
    sync.directory.push(member(absentEmail, { accountEnabled: null, absent: ['accountEnabled'] }));
    const viaNull = await seedSignAccount({ email: nullEmail });
    const viaAbsent = await seedSignAccount({ email: absentEmail });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(viaNull.id)).toEqual(CUT_OFF);
    expect(await accountState(viaAbsent.id)).toEqual(CUT_OFF);
  });

  test('24: on the users read, null or missing accountEnabled does not count toward the minimum', async ({ sync }) => {
    // Four enabled members and a minimum of five. Counted as members, the two
    // users below would make six, and the run would go ahead and disable the
    // leaver.
    await seedStaff(4, sync.directory);
    sync.directory.push(member(address('null-floor'), { accountEnabled: null }));
    sync.directory.push(member(address('absent-floor'), { accountEnabled: null, absent: ['accountEnabled'] }));
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '5' } });

    expectDirectoryWasRead(run);
    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);
  });

  test('24: on the users read, the run completes with null and missing accountEnabled at the minimum', async ({
    sync,
  }) => {
    // Exactly the minimum of enabled members, plus the two users: the run
    // must neither abort on them nor stop at the floor.
    await seedStaff(4, sync.directory);
    const nullEntry = member(address('null-run'), { accountEnabled: null });
    const absentEntry = member(address('absent-run'), { accountEnabled: null, absent: ['accountEnabled'] });
    sync.directory.push(nullEntry, absentEntry);
    const viaNull = await seedSignAccount({ email: nullEntry.mail ?? '', microsoft: { objectId: nullEntry.id } });
    const viaAbsent = await seedSignAccount({ email: absentEntry.mail ?? '', microsoft: { objectId: absentEntry.id } });

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '4' } });

    expectDirectoryWasRead(run);
    expect(run.outcome.state, `the run completed:\n${run.log}`).toBe('completed');
    expect(await accountState(viaNull.id)).toEqual(CUT_OFF);
    expect(await accountState(viaAbsent.id)).toEqual(CUT_OFF);
  });

  /**
   * The tenant's users, all in one access group, with two whose
   * accountEnabled comes back null and missing. Graph serves the group from
   * the same user objects, so both read paths see the same values.
   */
  const accessGroupOf = (directory: DirectoryUser[]) => {
    const groupId = randomUUID();

    return {
      env: { NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID: groupId },
      stub: { groups: { [groupId]: { displayName: 'Sign users', members: directory.map((u) => u.id) } } },
    };
  };

  const expectGroupWasRead = (run: SyncRun) => {
    expectDirectoryWasRead(run, { tokenOnly: true });
    expect(run.stub.groupMemberRequests().length, "requests for the access group's members").toBeGreaterThan(0);
  };

  test('24: on the access-group read, null or missing accountEnabled keeps no account and the run completes', async ({
    sync,
  }) => {
    await seedStaff(4, sync.directory);
    const nullEntry = member(address('group-null'), { accountEnabled: null });
    const absentEntry = member(address('group-absent'), { accountEnabled: null, absent: ['accountEnabled'] });
    sync.directory.push(nullEntry, absentEntry);
    const viaNull = await seedSignAccount({ email: nullEntry.mail ?? '', microsoft: { objectId: nullEntry.id } });
    const viaAbsent = await seedSignAccount({ email: absentEntry.mail ?? '', microsoft: { objectId: absentEntry.id } });
    const group = accessGroupOf(sync.directory);

    const run = await sync.run({
      env: { ...group.env, NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '4' },
      stub: group.stub,
    });

    expectGroupWasRead(run);
    expect(run.outcome.state, `the run completed:\n${run.log}`).toBe('completed');
    expect(await accountState(viaNull.id)).toEqual(CUT_OFF);
    expect(await accountState(viaAbsent.id)).toEqual(CUT_OFF);
  });

  test('24: on the access-group read, null or missing accountEnabled does not count toward the minimum', async ({
    sync,
  }) => {
    await seedStaff(4, sync.directory);
    sync.directory.push(member(address('group-null-floor'), { accountEnabled: null }));
    sync.directory.push(member(address('group-absent-floor'), { accountEnabled: null, absent: ['accountEnabled'] }));
    const leaver = await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });
    const group = accessGroupOf(sync.directory);

    const run = await sync.run({
      env: { ...group.env, NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '5' },
      stub: group.stub,
    });

    expectGroupWasRead(run);
    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);
  });

  // Criterion 25. Each account below signed in as an enabled member, by
  // object id, under an address the tenant does not have, so only a tenant
  // match keeps it (F8 is the same account under another tenant).
  const SPELLINGS: [string, string][] = [
    ['upper case', TENANT_ID.toUpperCase()],
    ['braces', `{${TENANT_ID}}`],
    ['surrounding whitespace', `  ${TENANT_ID}\t`],
    ['all three', ` {${TENANT_ID.toUpperCase()}} `],
  ];

  test('25: a token tenant id spelt with other case, braces or whitespace matches the tenant', async ({ sync }) => {
    await seedStaff(4, sync.directory);
    const kept: { label: string; id: number }[] = [];

    for (const [label, tid] of SPELLINGS) {
      const insider = member(address('renamed'));
      sync.directory.push(insider);
      const account = await seedSignAccount({
        email: address('old-name'),
        microsoft: { objectId: insider.id, tenantId: tid },
      });
      kept.push({ label, id: account.id });
    }

    const insider = member(address('renamed'));
    sync.directory.push(insider);
    const foreign = await seedSignAccount({
      email: address('outsider'),
      microsoft: { objectId: insider.id, tenantId: OTHER_TENANT_ID },
    });

    const run = await sync.run();

    expectDirectoryWasRead(run);

    for (const { label, id } of kept) {
      expect(await accountState(id), `token tenant spelt with ${label}`).toEqual(ACTIVE);
    }

    expect(await accountState(foreign.id), 'a token from another tenant').toEqual(CUT_OFF);
  });

  for (const [label, configured] of SPELLINGS) {
    test(`25: a configured tenant id spelt with ${label} matches the token's tenant`, async ({ sync }) => {
      await seedStaff(4, sync.directory);
      const insider = member(address('renamed'));
      sync.directory.push(insider);
      const account = await seedSignAccount({ email: address('old-name'), microsoft: { objectId: insider.id } });
      const other = member(address('renamed'));
      sync.directory.push(other);
      const foreign = await seedSignAccount({
        email: address('outsider'),
        microsoft: { objectId: other.id, tenantId: OTHER_TENANT_ID },
      });

      const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_TENANT_ID: configured } });

      expectDirectoryWasRead(run);
      // Microsoft's token endpoint is documented to take the bare GUID in its
      // path; the configured spelling must not reach it.
      expect(
        run.stub.tokenRequests().map((r) => r.url.toLowerCase()),
        'token requests name the tenant as a bare GUID',
      ).toEqual(run.stub.tokenRequests().map(() => `/${TENANT_ID}/oauth2/v2.0/token`));
      expect(await accountState(account.id)).toEqual(ACTIVE);
      expect(await accountState(foreign.id), 'a token from another tenant').toEqual(CUT_OFF);
    });
  }

  test('20: an address that is only an alias (proxyAddresses or otherMails) keeps nobody', async ({ sync }) => {
    await seedStaff(6, sync.directory);
    const proxyAlias = address('proxy-alias');
    const otherAlias = address('other-alias');
    sync.directory.push(
      member(address('primary-a'), { proxyAddresses: [`SMTP:primary@terrapay-stub.example`, `smtp:${proxyAlias}`] }),
    );
    sync.directory.push(member(address('primary-b'), { otherMails: [otherAlias] }));
    const byProxy = await seedSignAccount({ email: proxyAlias });
    const byOther = await seedSignAccount({ email: otherAlias });

    const run = await sync.run();

    expectDirectoryWasRead(run);
    expect(await accountState(byProxy.id)).toEqual(CUT_OFF);
    expect(await accountState(byOther.id)).toEqual(CUT_OFF);
  });

  for (const [mode, dryRun] of [
    ['dry run', 'true'],
    ['live', 'false'],
  ] as const) {
    test(`21: the ${mode} log never contains a stored id_token, the Graph access token or the client secret`, async ({
      sync,
    }) => {
      await seedStaff(4, sync.directory);
      await seedSignAccount({ email: address('leaver'), microsoft: { objectId: member('x').id } });

      const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: dryRun } });

      expectDirectoryWasRead(run);

      const accounts = await prisma.account.findMany({ select: { id_token: true } });
      const idTokens = accounts.map((a) => a.id_token).filter((t): t is string => Boolean(t));
      const accessTokens = run.stub.issuedAccessTokens();

      expect(idTokens.length).toBeGreaterThan(0);
      expect(accessTokens.length).toBeGreaterThan(0);

      const leaked: string[] = [];

      if (run.fullLog.includes(SYNC_CLIENT_SECRET)) {
        leaked.push('client secret');
      }

      for (const token of accessTokens) {
        if (run.fullLog.includes(token)) {
          leaked.push('Graph access token');
        }
      }

      for (const token of idTokens) {
        // The whole token, or any of its three parts on its own.
        if ([token, ...token.split('.')].some((part) => part.length >= 16 && run.fullLog.includes(part))) {
          leaked.push('id_token');
        }
      }

      expect(leaked, 'secrets found in the run log').toEqual([]);
    });
  }
});
