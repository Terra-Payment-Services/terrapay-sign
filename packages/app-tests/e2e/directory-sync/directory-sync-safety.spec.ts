/**
 * Directory sync, the stops that make a run disable nobody.
 *
 * Criteria 12 to 14, 23 and 26 of the specification and failure modes F4 and
 * F5. Every test here includes at least one account the run would disable if
 * it went ahead, so "nobody was disabled" means the stop held rather than that
 * there was nothing to do. Every test checks the stub was reached, so a run
 * that never read the directory cannot pass, except those for criterion 23,
 * which leaves that open and checks instead that the run failed and named the
 * setting.
 *
 * The specification does not say whether the two built-in service accounts,
 * which every database has, or administrators count among the "considered
 * accounts" the disable ratio divides by. The counts below are chosen so the
 * verdict is the same either way; MATCHING-FAILURE-MODES.md lists the
 * question.
 */
// First, so the specs' database is chosen before @documenso/prisma connects.
import './support/worker-database';

import { randomBytes } from 'node:crypto';
import {
  ACTIVE,
  accountState,
  CUT_OFF,
  disabledUserCount,
  guest,
  member,
  seedSignAccount,
  seedStaff,
} from './support/entra';
import { expect, expectDirectoryWasRead, expectFailureLogged, type SyncRun, test } from './support/fixture';
import type { Fault, GraphStubOptions } from './support/graph-stub';

test.describe.configure({ mode: 'parallel', timeout: 300_000 });

const address = (who: string) => `${who}-${randomBytes(3).toString('hex')}@terrapay-stub.example`;

const seedLeavers = async (count: number) => {
  const leavers: { id: number; email: string }[] = [];

  for (let i = 0; i < count; i++) {
    leavers.push(await seedSignAccount({ email: address(`leaver-${i}`), microsoft: { objectId: member('x').id } }));
  }

  return leavers;
};

const MINIMUM = 'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS';

/** The words that tie a log line to the directory read, as in expectFailureLogged. */
const FAILURE_SUBJECT = /graph|directory|entra|microsoft|token|reconcile|sync|users|page/i;
const RATIO = 'NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO';

/**
 * Criterion 23: a run with an invalid setting fails and says which setting.
 * Whether it read Graph first is not part of the contract, so it is not
 * checked; the leaver the run would otherwise disable, and the count of
 * disabled accounts, show that it did nothing.
 */
const expectRejectedSetting = (run: SyncRun, setting: string) => {
  expect(run.outcome.state, `the run should fail on an invalid ${setting}`).toBe('failed');
  expect(run.log, `a log line naming ${setting}`).toContain(setting);
};

/**
 * A blank setting is not among criterion 23's invalid values, so the run may
 * read it as unset and apply the default, or reject it. Either way it must not
 * pass without having done one or the other.
 */
const expectDefaultOrRejected = (run: SyncRun, setting: string) => {
  if (run.outcome.state === 'failed' && run.log.includes(setting)) {
    return;
  }

  expectDirectoryWasRead(run);
};

test.describe('[DIRECTORY SYNC]: minimum members', () => {
  test('12: fewer enabled members than the minimum stops the run; guests and disabled users are not members', async ({
    sync,
  }) => {
    await seedStaff(3, sync.directory);
    sync.directory.push(guest(address('g1')), guest(address('g2')));
    sync.directory.push(
      member(address('off1'), { accountEnabled: false }),
      member(address('off2'), { accountEnabled: false }),
    );
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '4' } });

    expectDirectoryWasRead(run);
    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);
  });

  test('12: exactly the minimum lets the run act', async ({ sync }) => {
    await seedStaff(3, sync.directory);
    sync.directory.push(guest(address('g1')));
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '3' } });

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('12: the default minimum of 10 applies when none is set', async ({ sync }) => {
    await seedStaff(9, sync.directory);
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: undefined } });

    expectDirectoryWasRead(run);
    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);
  });

  for (const [label, value] of [
    ['a non-numeric', 'abc'],
    ['a zero', '0'],
    ['a negative', '-3'],
    ['a fractional', '2.5'],
    ['an infinite', 'Infinity'],
  ] as const) {
    test(`23 / F5: ${label} minimum fails the run, disables nobody and names the setting`, async ({ sync }) => {
      // Three members against a leaver: a run that read the setting as "no
      // minimum", or as any floor of three or less, would disable the leaver.
      await seedStaff(3, sync.directory);
      const [leaver] = await seedLeavers(1);

      const run = await sync.run({ env: { [MINIMUM]: value } });

      expectRejectedSetting(run, MINIMUM);
      expect(await disabledUserCount()).toBe(0);
      expect(await accountState(leaver.id)).toEqual(ACTIVE);
    });
  }

  test('30: rows that repeat a user do not raise the member count to the minimum', async ({ sync }) => {
    // Three distinct enabled members, each of whom Graph returns twice, once
    // with the object id in upper case: six rows, three people. A floor of
    // five counted by rows would let the run disable the leaver.
    const staff = await seedStaff(3, sync.directory);
    const people = sync.directory.slice(0, 3);
    sync.directory.push({ ...people[0] }, { ...people[1], id: people[1].id.toUpperCase() });
    sync.directory.push({ ...people[2], id: people[2].id.toUpperCase() });
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ env: { [MINIMUM]: '5' }, stub: { maxPageSize: 2 } });

    expectDirectoryWasRead(run);
    expect(run.stub.userPageRequests().length, 'every page of six rows was read').toBeGreaterThanOrEqual(3);
    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);

    for (const person of staff) {
      expect(await accountState(person.id)).toEqual(ACTIVE);
    }
  });

  test('F5: a blank minimum does not switch the minimum off', async ({ sync }) => {
    // Three members: fewer than the default of ten, so a run that read the
    // setting as "no minimum" would go ahead and disable the leaver.
    await seedStaff(3, sync.directory);
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ env: { [MINIMUM]: '' } });

    expectDefaultOrRejected(run, MINIMUM);
    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);
  });
});

test.describe('[DIRECTORY SYNC]: disable limit', () => {
  test('13: more than the ratio of considered accounts stops the run', async ({ sync }) => {
    await seedStaff(8, sync.directory);
    const leavers = await seedLeavers(2);

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.1' } });

    expectDirectoryWasRead(run);
    expect(await disabledUserCount()).toBe(0);

    for (const leaver of leavers) {
      expect(await accountState(leaver.id)).toEqual(ACTIVE);
    }
  });

  test('13: exactly the ratio is allowed', async ({ sync }) => {
    await seedStaff(9, sync.directory);
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.1' } });

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);
  });

  test('13: the ratio defaults to 0.1 when none is set', async ({ sync }) => {
    await seedStaff(8, sync.directory);
    const leavers = await seedLeavers(2);

    const run = await sync.run({ env: { NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: undefined } });

    expectDirectoryWasRead(run);
    expect(await disabledUserCount()).toBe(0);

    for (const leaver of leavers) {
      expect(await accountState(leaver.id)).toEqual(ACTIVE);
    }
  });

  for (const [label, value] of [
    ['a non-numeric', 'abc'],
    ['a zero', '0'],
    ['a negative', '-0.1'],
    ['a just-too-large', '0.51'],
    ['a whole', '1'],
    ['an infinite', 'Infinity'],
  ] as const) {
    test(`23 / F5: ${label} ratio fails the run, disables nobody and names the setting`, async ({ sync }) => {
      // Eight of ten accounts would go: a run that took the setting as a
      // ratio of 0.8 or more, or as no limit, would disable them.
      await seedStaff(2, sync.directory);
      const leavers = await seedLeavers(8);

      const run = await sync.run({ env: { [RATIO]: value } });

      expectRejectedSetting(run, RATIO);
      expect(await disabledUserCount()).toBe(0);

      for (const leaver of leavers) {
        expect(await accountState(leaver.id)).toEqual(ACTIVE);
      }
    });
  }

  test('F5: a blank ratio does not lift the disable limit', async ({ sync }) => {
    await seedStaff(2, sync.directory);
    const leavers = await seedLeavers(8);

    const run = await sync.run({ env: { [RATIO]: '' } });

    expectDefaultOrRejected(run, RATIO);
    expect(await disabledUserCount()).toBe(0);

    for (const leaver of leavers) {
      expect(await accountState(leaver.id)).toEqual(ACTIVE);
    }
  });

  test('8 / F5: exempt accounts do not count toward the limit as accounts to disable', async ({ sync }) => {
    // One leaver in ten is exactly the limit. Five exempt accounts are absent
    // from the tenant; counted as disables they would push the run over it.
    await seedStaff(9, sync.directory);
    const [leaver] = await seedLeavers(1);
    const exempt: { id: number; email: string }[] = [];

    for (let i = 0; i < 5; i++) {
      exempt.push(await seedSignAccount({ email: address(`exempt-${i}`) }));
    }

    const run = await sync.run({
      env: {
        NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.1',
        NEXT_PRIVATE_ENTRA_RECONCILE_EXEMPT_EMAILS: exempt.map((e) => e.email).join(','),
      },
    });

    expectDirectoryWasRead(run);
    expect(await accountState(leaver.id)).toEqual(CUT_OFF);

    for (const account of exempt) {
      expect(await accountState(account.id)).toEqual(ACTIVE);
    }
  });

  test('8 / F5: exempt accounts do not inflate the denominator and lift the limit', async ({ sync }) => {
    // Two leavers in ten is over the limit. Twelve exempt accounts added to
    // the denominator would bring it under (2 in 22) and let the run go ahead.
    await seedStaff(8, sync.directory);
    const leavers = await seedLeavers(2);
    const exempt: { id: number; email: string }[] = [];

    for (let i = 0; i < 12; i++) {
      const email = address(`exempt-${i}`);
      const entry = member(email);
      sync.directory.push(entry);
      exempt.push(await seedSignAccount({ email, microsoft: { objectId: entry.id } }));
    }

    const run = await sync.run({
      env: {
        NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO: '0.1',
        NEXT_PRIVATE_ENTRA_RECONCILE_EXEMPT_EMAILS: exempt.map((e) => e.email).join(','),
      },
    });

    expectDirectoryWasRead(run);
    expect(await disabledUserCount()).toBe(0);

    for (const leaver of leavers) {
      expect(await accountState(leaver.id)).toEqual(ACTIVE);
    }
  });
});

const graphFailure = (status: number, code: string): Fault => ({
  kind: 'status',
  status,
  body: { error: { code, message: 'Injected by the test.', innerError: { date: new Date().toISOString() } } },
});

const FAILURES: { name: string; tokenFault?: Fault; pageFaults?: Record<number, Fault>; reachesGraph: boolean }[] = [
  {
    name: 'the token request is refused (invalid_client)',
    tokenFault: {
      kind: 'status',
      status: 401,
      body: {
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret provided.',
        error_codes: [7000215],
      },
    },
    reachesGraph: false,
  },
  {
    name: 'the token endpoint fails (503)',
    tokenFault: {
      kind: 'status',
      status: 503,
      body: { error: 'temporarily_unavailable', error_description: 'AADSTS50001', error_codes: [50001] },
    },
    reachesGraph: false,
  },
  {
    name: 'the first page fails (503)',
    pageFaults: { 1: graphFailure(503, 'serviceNotAvailable') },
    reachesGraph: true,
  },
  {
    name: 'the first page is refused for want of permission (403)',
    pageFaults: { 1: graphFailure(403, 'Authorization_RequestDenied') },
    reachesGraph: true,
  },
  {
    name: 'Graph keeps throttling (429)',
    pageFaults: { 1: { ...graphFailure(429, 'TooManyRequests'), headers: { 'retry-after': '1' } } as Fault },
    reachesGraph: true,
  },
  { name: 'a later page fails (500)', pageFaults: { 2: graphFailure(500, 'generalException') }, reachesGraph: true },
  {
    name: 'a later page is not JSON',
    pageFaults: { 2: { kind: 'body', body: '<html><body>Bad gateway</body></html>', contentType: 'text/html' } },
    reachesGraph: true,
  },
  {
    name: 'a later page has no value array',
    pageFaults: { 2: { kind: 'body', body: JSON.stringify({ '@odata.context': 'x', error: null }) } },
    reachesGraph: true,
  },
  {
    name: 'a later page has a value that is not an array',
    pageFaults: { 2: { kind: 'body', body: JSON.stringify({ '@odata.context': 'x', value: { id: 'x' } }) } },
    reachesGraph: true,
  },
  { name: 'a later page is cut off mid-body', pageFaults: { 2: { kind: 'truncated' } }, reachesGraph: true },
];

test.describe('[DIRECTORY SYNC]: Graph failures', () => {
  for (const failure of FAILURES) {
    test(`14 / F4: nobody is disabled when ${failure.name}`, async ({ sync }) => {
      // Three pages of two. Had a partial read been taken as the whole
      // directory, the staff on the unread pages would be disabled too.
      const staff = await seedStaff(6, sync.directory);
      const [leaver] = await seedLeavers(1);

      const run = await sync.run({
        stub: { maxPageSize: 2, tokenFault: failure.tokenFault, pageFaults: failure.pageFaults },
      });

      expectDirectoryWasRead(run, { tokenOnly: !failure.reachesGraph });
      expect(await disabledUserCount()).toBe(0);
      expect(await accountState(leaver.id)).toEqual(ACTIVE);

      for (const person of staff) {
        expect(await accountState(person.id)).toEqual(ACTIVE);
      }

      expectFailureLogged(run);
    });
  }

  for (const [where, page, status] of [
    ['the first page', 1, 503],
    ['a later page', 2, 400],
  ] as const) {
    test(`26: when ${where} fails, the log carries the status and nothing of a token in the error body`, async ({
      sync,
    }) => {
      // Shaped like a bearer token, in every free-text place Graph's error
      // body has: the code, the message and the inner error.
      const tail = randomBytes(24).toString('base64url');
      const tokenLike = `eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.${tail}`;

      await seedStaff(6, sync.directory);
      const [leaver] = await seedLeavers(1);

      const run = await sync.run({
        stub: {
          maxPageSize: 2,
          pageFaults: {
            [page]: {
              kind: 'status',
              status,
              body: {
                error: {
                  code: tokenLike,
                  message: `Bearer ${tokenLike} was not accepted.`,
                  innerError: { date: new Date().toISOString(), 'request-id': tokenLike, 'client-request-id': tail },
                },
              },
            },
          },
        },
      });

      expectDirectoryWasRead(run);
      expect(await disabledUserCount()).toBe(0);
      expect(await accountState(leaver.id)).toEqual(ACTIVE);

      // The value whole, or a recognisable piece of it.
      for (const piece of [tokenLike, tail, tail.slice(0, 16), tail.slice(-16)]) {
        expect(run.fullLog.includes(piece), `the log contains part of the token-like value: ${piece}`).toBe(false);
      }

      const statusLines = run.log
        .split('\n')
        .filter((line) => new RegExp(`\\b${status}\\b`).test(line) && FAILURE_SUBJECT.test(line));

      expect(
        statusLines.length,
        `a log line about the Graph failure carrying the status ${status}:\n${run.log}`,
      ).toBeGreaterThan(0);
    });
  }

  // Criterion 28: a continuation link is followed only if it is HTTPS on the
  // Graph origin in use. The first page's link is replaced; the run must fail
  // before sending anything to it, and log no part of it.
  const secretLooking = () => `sk_live_${randomBytes(18).toString('base64url')}`;
  const BAD_LINKS: { name: string; make: (link: string, origins: { graph: string; elsewhere: string }) => string }[] = [
    { name: 'on another origin', make: (link, o) => link.replace(o.graph, o.elsewhere) },
    { name: 'over plain http', make: (link) => link.replace(/^https:/, 'http:') },
    { name: 'empty', make: () => '' },
    {
      name: 'malformed, carrying a secret-looking value',
      make: () => {
        const secret = secretLooking();
        return `https://[${secret}/v1.0/users?$skiptoken=${secret}`;
      },
    },
  ];

  for (const bad of BAD_LINKS) {
    test(`28: a nextLink ${bad.name} fails the run, is never followed and is not logged`, async ({ sync }) => {
      // Three pages of two. A client that stopped at the bad link would take
      // the first page for the whole tenant and disable the staff after it.
      const staff = await seedStaff(6, sync.directory);
      const [leaver] = await seedLeavers(1);
      const sent: string[] = [];

      const run = await sync.run({
        stub: {
          maxPageSize: 2,
          nextLinkFor: (page, link, origins) => {
            if (page !== 1) {
              return link;
            }

            const replaced = bad.make(link, origins);
            sent.push(replaced);

            return replaced;
          },
        },
      });

      expectDirectoryWasRead(run);
      // Once per attempt: the job is retried, and each attempt reads page 1.
      expect(sent.length, 'the first page carried the replaced link').toBeGreaterThan(0);
      expect(run.outcome.state).toBe('failed');
      expect(await disabledUserCount()).toBe(0);
      expect(await accountState(leaver.id)).toEqual(ACTIVE);

      for (const person of staff) {
        expect(await accountState(person.id)).toEqual(ACTIVE);
      }

      expect(run.stub.elsewhereRequests(), 'requests to the other origin').toEqual([]);
      expect(run.stub.plaintextAttempts(), 'plain-http connections to the Graph port').toEqual([]);
      expect(
        run.stub.userPageRequests().filter((r) => (r.page ?? 0) > 1),
        'no page after the bad link was requested',
      ).toEqual([]);

      // Each link's distinctive parts: the whole link, its continuation
      // token, any secret-looking value, and the other origin's host and port.
      const pieces: string[] = [];

      for (const link of sent) {
        pieces.push(...(link.match(/(?<=\$skiptoken=)[A-Za-z0-9_-]+|sk_live_[A-Za-z0-9_-]+/g) ?? []));

        if (link) {
          pieces.push(link);
        }

        if (link.startsWith(run.stub.elsewhereBaseUrl)) {
          pieces.push(new URL(run.stub.elsewhereBaseUrl).host);
        }
      }

      for (const piece of pieces) {
        expect(run.fullLog.includes(piece), `the log contains part of the link: ${piece}`).toBe(false);
      }
    });
  }

  test('29: a login endpoint that never answers fails the run in bounded time', async ({ sync }) => {
    test.setTimeout(600_000);

    const staff = await seedStaff(6, sync.directory);
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ stub: { tokenFault: { kind: 'hang' } }, timeoutMs: 480_000 });

    expectDirectoryWasRead(run, { tokenOnly: true });
    expect(run.outcome.state, 'the run failed rather than hanging or completing').toBe('failed');
    expect(
      run.stub.tokenRequests().some((r) => r.abandoned),
      'the client abandoned the token request that never answered',
    ).toBe(true);
    expect(run.stub.userPageRequests()).toEqual([]);
    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);

    for (const person of staff) {
      expect(await accountState(person.id)).toEqual(ACTIVE);
    }

    expectFailureLogged(run);
  });

  // Criterion 34: a transport error is logged without the request URL or any
  // part of a response. Each fault makes an error whose own message would
  // carry one of them if passed through.
  const TRANSPORT: { name: string; stub: (secret: string) => Partial<GraphStubOptions>; urlPiece: boolean }[] = [
    {
      name: 'the connection to a later page drops without an answer',
      stub: () => ({ pageFaults: { 2: { kind: 'reset' } } }),
      urlPiece: true,
    },
    {
      name: 'a later page is cut off mid-body',
      stub: () => ({ pageFaults: { 2: { kind: 'truncated' } } }),
      urlPiece: true,
    },
    {
      name: 'a later page is not JSON and begins with a secret',
      stub: (secret) => ({ pageFaults: { 2: { kind: 'body', body: `${secret} <html>Bad gateway</html>` } } }),
      urlPiece: true,
    },
    {
      name: 'the login endpoint drops the connection',
      stub: () => ({ tokenFault: { kind: 'reset' } }),
      urlPiece: false,
    },
    {
      name: 'the login endpoint answers with something that is not JSON and begins with a secret',
      stub: (secret) => ({ tokenFault: { kind: 'body', body: `${secret} <html>Proxy error</html>` } }),
      urlPiece: false,
    },
  ];

  for (const transport of TRANSPORT) {
    test(`34: when ${transport.name}, the log carries neither the URL nor the response`, async ({ sync }) => {
      const secret = secretLooking();
      await seedStaff(6, sync.directory);
      const [leaver] = await seedLeavers(1);

      const run = await sync.run({ stub: { maxPageSize: 2, ...transport.stub(secret) } });

      expectDirectoryWasRead(run, { tokenOnly: !transport.urlPiece });
      expect(await disabledUserCount()).toBe(0);
      expect(await accountState(leaver.id)).toEqual(ACTIVE);
      expectFailureLogged(run);

      const pieces = [secret, secret.slice(0, 16), secret.slice(-16)];

      // The URL of the request that failed: its continuation token is the part
      // nobody but the client could know.
      for (const request of transport.urlPiece ? run.stub.userPageRequests() : []) {
        const token = new URL(request.url, 'https://stub').searchParams.get('$skiptoken');

        if (token) {
          pieces.push(token);
        }
      }

      for (const request of transport.urlPiece ? [] : run.stub.tokenRequests()) {
        pieces.push(request.url);
      }

      for (const piece of pieces) {
        expect(run.fullLog.includes(piece), `the log contains ${piece}`).toBe(false);
      }
    });
  }

  test('14 / F4: nobody is disabled when a later page never answers, and the run gives up on it', async ({ sync }) => {
    test.setTimeout(600_000);

    const staff = await seedStaff(6, sync.directory);
    const [leaver] = await seedLeavers(1);

    const run = await sync.run({ stub: { maxPageSize: 2, pageFaults: { 2: { kind: 'hang' } } }, timeoutMs: 480_000 });

    expectDirectoryWasRead(run);
    // Criterion 32: a timed-out request fails the job; it never completes.
    expect(run.outcome.state, 'the run failed rather than hanging or completing').toBe('failed');
    expect(
      run.stub.userPageRequests().some((r) => r.page === 2 && r.abandoned),
      'the client abandoned the page that never answered',
    ).toBe(true);

    expect(await disabledUserCount()).toBe(0);
    expect(await accountState(leaver.id)).toEqual(ACTIVE);

    for (const person of staff) {
      expect(await accountState(person.id)).toEqual(ACTIVE);
    }

    expectFailureLogged(run);
  });
});
