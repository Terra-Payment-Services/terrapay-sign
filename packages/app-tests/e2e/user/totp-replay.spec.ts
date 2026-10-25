import { randomInt } from 'node:crypto';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENSO_ENCRYPTION_KEY } from '@documenso/lib/constants/crypto';
import { setupTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/setup-2fa';
import { symmetricDecrypt } from '@documenso/lib/universal/crypto';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, request, test } from '@playwright/test';
import { FieldType, SigningStatus, UserSecurityAuditLogType } from '@prisma/client';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

/**
 * Issue #197: an accepted TOTP code must not be accepted again within its step at the account sinks S1 to S5, while
 * recipient 2FA (S6) keeps accepting one code for several fields. Every sink is driven over HTTP against the running
 * app and the user row, sessions and audit log are read back from the database.
 *
 * Seeding never spends a TOTP code: 2FA is set up with `setupTwoFactorAuthentication` and switched on with a direct
 * write, and the session for the session-bound sinks is opened by signing in before 2FA is switched on. Otherwise the
 * seed itself would consume the current step and every first use below would be refused.
 *
 * Codes are always derived from an explicit step counter. A same-step sequence starts only when at least ten seconds
 * of the step remain, and the tests that need a later step wait for its boundary.
 *
 * Sign-in is limited to ten attempts per user and fifty per IP in fifteen minutes, so each test uses its own
 * X-Forwarded-For address and no user signs in more than six times.
 */

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const PASSWORD = 'password';

const PERIOD_MS = 30_000;

const MIN_ROOM_MS = 10_000;

const ROUTES = {
  W1: '/api/auth/two-factor',
  W2: '/api/auth/email-password/2fa',
} as const;

const VIEW_PATHS = [`${ROUTES.W1}/view-recovery-codes`, `${ROUTES.W2}/view-recovery-codes`];

const DISABLE_PATHS = [`${ROUTES.W1}/disable`, `${ROUTES.W2}/disable`];

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const currentCounter = () => Math.floor(Date.now() / PERIOD_MS);

const msLeftInStep = () => PERIOD_MS - (Date.now() % PERIOD_MS);

/**
 * Return the current step counter, first waiting for the next step if fewer than ten seconds of this one remain.
 */
const freshStep = async () => {
  if (msLeftInStep() < MIN_ROOM_MS) {
    await sleep(msLeftInStep() + 250);
  }

  return currentCounter();
};

/**
 * Wait until the step counter reaches `counter`.
 */
const waitForCounter = async (counter: number) => {
  while (currentCounter() < counter) {
    await sleep(msLeftInStep() + 250);
  }

  expect(currentCounter(), 'premise: the wait landed in the expected step').toBe(counter);
};

/**
 * Fail loudly if a sequence meant to run inside one step crossed a boundary, since its assertions assume one step.
 */
const expectStillInStep = (counter: number) => {
  expect(currentCounter(), 'premise: the sequence stayed inside one TOTP step').toBe(counter);
};

const codeAt = async (secret: string, counter: number) => await generateHOTP(base32.decode(secret), counter);

const decrypt = (ciphertext: string | null) => {
  if (!DOCUMENSO_ENCRYPTION_KEY || !ciphertext) {
    throw new Error('Expected encryption key and ciphertext');
  }

  return Buffer.from(symmetricDecrypt({ key: DOCUMENSO_ENCRYPTION_KEY, data: ciphertext })).toString('utf-8');
};

const readUser = async (userId: number) => await prisma.user.findUniqueOrThrow({ where: { id: userId } });

const readSecret = async (userId: number) => decrypt((await readUser(userId)).twoFactorSecret);

const readBackupCodes = async (userId: number) => {
  const codes: unknown = JSON.parse(decrypt((await readUser(userId)).twoFactorBackupCodes));

  if (!Array.isArray(codes)) {
    throw new Error('Expected backup codes to be a list');
  }

  return codes.map(String);
};

const countSessions = async (userId: number) => await prisma.session.count({ where: { userId } });

const countSignIn2faFailures = async (userId: number) =>
  await prisma.userSecurityAuditLog.count({ where: { userId, type: UserSecurityAuditLogType.SIGN_IN_2FA_FAIL } });

const countDisableAudits = async (userId: number) =>
  await prisma.userSecurityAuditLog.count({ where: { userId, type: UserSecurityAuditLogType.AUTH_2FA_DISABLE } });

const randomIp = () => `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;

const newClient = async (ip: string) => {
  return await request.newContext({
    baseURL: NEXT_PUBLIC_WEBAPP_URL(),
    extraHTTPHeaders: { 'x-forwarded-for': ip, origin: new URL(NEXT_PUBLIC_WEBAPP_URL()).origin },
  });
};

const getCsrfToken = async (client: APIRequestContext) => {
  const response = await client.get('/api/auth/csrf');
  const { csrfToken } = await response.json();

  if (!csrfToken) {
    throw new Error('No CSRF token');
  }

  return String(csrfToken);
};

const authorize = async (client: APIRequestContext, email: string, csrfToken: string, totpCode?: string) => {
  return await client.post('/api/auth/email-password/authorize', {
    data: { email, password: PASSWORD, totpCode, csrfToken },
  });
};

const signIn = async (client: APIRequestContext, email: string, totpCode?: string) => {
  return await authorize(client, email, await getCsrfToken(client), totpCode);
};

const isAuthenticated = async (client: APIRequestContext) => {
  const response = await client.get('/api/auth/session');
  const session = await response.json();

  return session.isAuthenticated === true;
};

const expectRefused = async (response: APIResponse, code: string) => {
  expect(response.ok(), `expected ${code}, got ${response.status()}`).toBe(false);

  const body = await response.json();

  expect(body).toMatchObject({ code });
  expect(body).not.toHaveProperty('backupCodes');
};

/**
 * Seed a user with 2FA on and an open session, without spending any TOTP code. The session is opened by signing in
 * before 2FA is switched on, and 2FA is switched on by a direct write rather than through enable.
 */
const seedTwoFactorUser = async (ip: string) => {
  const { user } = await seedUser({ password: PASSWORD });

  const session = await newClient(ip);
  const signInResponse = await signIn(session, user.email);

  expect(signInResponse.status(), await signInResponse.text()).toBe(201);

  await setupTwoFactorAuthentication({ user });
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });

  expect((await readUser(user.id)).twoFactorEnabled).toBe(true);
  expect(await isAuthenticated(session)).toBe(true);

  return { user, session, secret: await readSecret(user.id), backupCodes: await readBackupCodes(user.id) };
};

test.describe('[USER] TOTP codes are single use within their step (#197)', () => {
  test('[C1][C3] S1: a code that signed in once is refused for a second sign-in, and the next step signs in', async () => {
    const ip = randomIp();
    const { user, secret } = await seedTwoFactorUser(ip);

    const counter = await freshStep();
    const code = await codeAt(secret, counter);
    const sessionsBefore = await countSessions(user.id);

    const first = await newClient(ip);
    const firstResponse = await signIn(first, user.email, code);

    expect(firstResponse.status(), await firstResponse.text()).toBe(201);
    expect(await isAuthenticated(first)).toBe(true);
    expect(await countSessions(user.id)).toBe(sessionsBefore + 1);

    const failuresBefore = await countSignIn2faFailures(user.id);

    const replay = await newClient(ip);
    const replayResponse = await signIn(replay, user.email, code);

    await expectRefused(replayResponse, 'INVALID_TWO_FACTOR_CODE');
    expect(await isAuthenticated(replay)).toBe(false);
    expect(await countSessions(user.id)).toBe(sessionsBefore + 1);
    expect(await countSignIn2faFailures(user.id)).toBe(failuresBefore + 1);

    const failureRow = await prisma.userSecurityAuditLog.findFirstOrThrow({
      where: { userId: user.id, type: UserSecurityAuditLogType.SIGN_IN_2FA_FAIL },
      orderBy: { createdAt: 'desc' },
    });

    // Confirms the per-test address reaches the server, so the IP rate limit bucket is ours.
    expect(failureRow.ipAddress).toBe(ip);

    expectStillInStep(counter);

    // C3: the user is not locked out beyond the step.
    await waitForCounter(counter + 1);

    const next = await newClient(ip);
    const nextResponse = await signIn(next, user.email, await codeAt(secret, counter + 1));

    expect(nextResponse.status(), await nextResponse.text()).toBe(201);
    expect(await isAuthenticated(next)).toBe(true);
    expect(await countSessions(user.id)).toBe(sessionsBefore + 2);
  });

  test('[C1] S2: a code that changed the password once is refused for a second change and the password stays', async () => {
    const ip = randomIp();
    const { user, session, secret } = await seedTwoFactorUser(ip);

    const counter = await freshStep();
    const code = await codeAt(secret, counter);

    const first = await session.post('/api/auth/email-password/update-password', {
      data: { currentPassword: PASSWORD, password: 'Replay197!', totpCode: code },
    });

    expect(first.status(), await first.text()).toBe(201);

    const hashAfterFirst = (await readUser(user.id)).password;

    // Correct current password and a valid new one, so the code is the only input that can fail.
    const replay = await session.post('/api/auth/email-password/update-password', {
      data: { currentPassword: 'Replay197!', password: 'Another197!', totpCode: code },
    });

    expect(replay.status(), await replay.text()).toBe(401);
    expect(await replay.json()).toMatchObject({ code: 'INCORRECT_TWO_FACTOR_CODE' });
    expect((await readUser(user.id)).password).toBe(hashAfterFirst);

    expectStillInStep(counter);
  });

  test('[C1][C3] S3: a code that signed in is refused at both disable routes, and the next step disables', async () => {
    const ip = randomIp();
    const { user, secret } = await seedTwoFactorUser(ip);

    const counter = await freshStep();
    const code = await codeAt(secret, counter);

    const client = await newClient(ip);
    const signInResponse = await signIn(client, user.email, code);

    expect(signInResponse.status(), await signInResponse.text()).toBe(201);

    const before = await readUser(user.id);

    for (const disablePath of DISABLE_PATHS) {
      const response = await client.post(disablePath, { data: { totpCode: code } });

      expect(response.status(), `${disablePath}: ${await response.text()}`).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INCORRECT_TWO_FACTOR_CODE' });

      const after = await readUser(user.id);

      expect(after.twoFactorEnabled).toBe(true);
      expect(after.twoFactorSecret).toBe(before.twoFactorSecret);
      expect(after.twoFactorBackupCodes).toBe(before.twoFactorBackupCodes);
    }

    expect(await countDisableAudits(user.id)).toBe(0);
    expectStillInStep(counter);

    await waitForCounter(counter + 1);

    const disable = await client.post(DISABLE_PATHS[0], { data: { totpCode: await codeAt(secret, counter + 1) } });

    expect(disable.status(), await disable.text()).toBe(201);
    expect((await readUser(user.id)).twoFactorEnabled).toBe(false);
    expect(await countDisableAudits(user.id)).toBe(1);
  });

  test('[C1] S4: a code that showed the recovery codes once shows nothing on a second use at either route', async () => {
    const ip = randomIp();
    const { session, secret, backupCodes } = await seedTwoFactorUser(ip);

    const counter = await freshStep();
    const code = await codeAt(secret, counter);

    const first = await session.post(VIEW_PATHS[0], { data: { token: code } });

    expect(first.ok(), await first.text()).toBe(true);

    const { backupCodes: shown } = await first.json();

    expect([...shown].sort()).toEqual([...backupCodes].sort());

    for (const viewPath of [...VIEW_PATHS, VIEW_PATHS[0]]) {
      const replay = await session.post(viewPath, { data: { token: code } });

      await expectRefused(replay, 'INCORRECT_TWO_FACTOR_CODE');
    }

    expectStillInStep(counter);
  });

  for (const [name, base] of Object.entries(ROUTES)) {
    test(`[C1] S5 ${name}: the code that enabled 2FA is refused for sign-in in the same step`, async () => {
      const ip = randomIp();
      const { user } = await seedUser({ password: PASSWORD });

      const session = await newClient(ip);
      const plainSignIn = await signIn(session, user.email);

      expect(plainSignIn.status(), await plainSignIn.text()).toBe(201);

      const setup = await session.post(`${base}/setup`, { data: {} });

      expect(setup.ok(), await setup.text()).toBe(true);

      const { secret } = await setup.json();

      expect(typeof secret).toBe('string');

      const counter = await freshStep();
      const code = await codeAt(secret, counter);

      const enable = await session.post(`${base}/enable`, { data: { code } });

      expect(enable.ok(), await enable.text()).toBe(true);
      expect((await readUser(user.id)).twoFactorEnabled).toBe(true);

      const sessionsBefore = await countSessions(user.id);
      const failuresBefore = await countSignIn2faFailures(user.id);

      const replay = await newClient(ip);
      const replayResponse = await signIn(replay, user.email, code);

      await expectRefused(replayResponse, 'INVALID_TWO_FACTOR_CODE');
      expect(await isAuthenticated(replay)).toBe(false);
      expect(await countSessions(user.id)).toBe(sessionsBefore);
      expect(await countSignIn2faFailures(user.id)).toBe(failuresBefore + 1);

      expectStillInStep(counter);
    });
  }

  test('[C2] a code that signed in is refused at password change, disable and view codes in the same step', async () => {
    const ip = randomIp();
    const { user, secret } = await seedTwoFactorUser(ip);

    const counter = await freshStep();
    const code = await codeAt(secret, counter);

    const client = await newClient(ip);
    const signInResponse = await signIn(client, user.email, code);

    expect(signInResponse.status(), await signInResponse.text()).toBe(201);

    const before = await readUser(user.id);

    const update = await client.post('/api/auth/email-password/update-password', {
      data: { currentPassword: PASSWORD, password: 'Replay197!', totpCode: code },
    });

    expect(update.status(), await update.text()).toBe(401);
    expect(await update.json()).toMatchObject({ code: 'INCORRECT_TWO_FACTOR_CODE' });

    for (const disablePath of DISABLE_PATHS) {
      const response = await client.post(disablePath, { data: { totpCode: code } });

      expect(response.status(), `${disablePath}: ${await response.text()}`).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INCORRECT_TWO_FACTOR_CODE' });
    }

    for (const viewPath of VIEW_PATHS) {
      const response = await client.post(viewPath, { data: { token: code } });

      await expectRefused(response, 'INCORRECT_TWO_FACTOR_CODE');
    }

    const after = await readUser(user.id);

    expect(after.password).toBe(before.password);
    expect(after.twoFactorEnabled).toBe(true);
    expect(after.twoFactorSecret).toBe(before.twoFactorSecret);
    expect(after.twoFactorBackupCodes).toBe(before.twoFactorBackupCodes);
    expect(await countDisableAudits(user.id)).toBe(0);

    expectStillInStep(counter);
  });

  test('[C4] after a code of step c+1 is accepted, the unused code of step c is refused', async () => {
    const ip = randomIp();
    const target = await seedTwoFactorUser(ip);

    const counter = currentCounter();

    await waitForCounter(counter + 1);

    // On the account routes C4 already holds through the one-step window, which accepts only the current step, so
    // this pins the behaviour rather than isolating the last-accepted-step check.
    const previousTarget = await codeAt(target.secret, counter);

    const current = await newClient(ip);
    const currentResponse = await signIn(current, target.user.email, await codeAt(target.secret, counter + 1));

    expect(currentResponse.status(), await currentResponse.text()).toBe(201);

    const sessionsBefore = await countSessions(target.user.id);

    const older = await newClient(ip);
    const olderResponse = await signIn(older, target.user.email, previousTarget);

    await expectRefused(olderResponse, 'INVALID_TWO_FACTOR_CODE');
    expect(await isAuthenticated(older)).toBe(false);
    expect(await countSessions(target.user.id)).toBe(sessionsBefore);

    // The same older code is refused at an account sink as well.
    const view = await target.session.post(VIEW_PATHS[0], { data: { token: previousTarget } });

    await expectRefused(view, 'INCORRECT_TWO_FACTOR_CODE');

    expectStillInStep(counter + 1);
  });

  for (const parallel of [2, 4]) {
    test(`[C5] S1 against S1: ${parallel} concurrent sign-ins with one code give exactly one session, over three rounds`, async () => {
      const ip = randomIp();

      for (let round = 0; round < 3; round++) {
        // A fresh user each round keeps every user well under the sign-in rate limit.
        const { user, secret } = await seedTwoFactorUser(ip);

        const clients = await Promise.all(Array.from({ length: parallel }, async () => await newClient(ip)));
        const csrfTokens = await Promise.all(clients.map(async (client) => await getCsrfToken(client)));

        const counter = await freshStep();
        const code = await codeAt(secret, counter);
        const sessionsBefore = await countSessions(user.id);
        const failuresBefore = await countSignIn2faFailures(user.id);

        const responses = await Promise.all(
          clients.map(async (client, index) => await authorize(client, user.email, csrfTokens[index], code)),
        );

        const statuses = responses.map((response) => response.status());

        expect(
          statuses.filter((value) => value === 201),
          `round ${round}: ${JSON.stringify(statuses)}`,
        ).toHaveLength(1);

        for (const loser of responses.filter((response) => response.status() !== 201)) {
          await expectRefused(loser, 'INVALID_TWO_FACTOR_CODE');
        }

        const sessions = await Promise.all(clients.map(async (client) => await isAuthenticated(client)));

        expect(sessions.filter(Boolean)).toHaveLength(1);
        expect(await countSessions(user.id)).toBe(sessionsBefore + 1);
        expect(await countSignIn2faFailures(user.id)).toBe(failuresBefore + parallel - 1);

        expectStillInStep(counter);
      }
    });
  }

  test('[C5] S1 against S4: a sign-in and a view of recovery codes with one code, exactly one succeeds, over four rounds', async () => {
    const ip = randomIp();

    for (let round = 0; round < 4; round++) {
      const { user, session, secret } = await seedTwoFactorUser(ip);

      const signInClient = await newClient(ip);
      const csrfToken = await getCsrfToken(signInClient);

      const counter = await freshStep();
      const code = await codeAt(secret, counter);
      const sessionsBefore = await countSessions(user.id);

      const [signInResponse, viewResponse] = await Promise.all([
        authorize(signInClient, user.email, csrfToken, code),
        session.post(VIEW_PATHS[round % 2], { data: { token: code } }),
      ]);

      const signedIn = signInResponse.status() === 201;
      const viewed = viewResponse.ok();

      expect(
        Number(signedIn) + Number(viewed),
        `round ${round}: sign-in ${signInResponse.status()}, view ${viewResponse.status()}`,
      ).toBe(1);

      if (signedIn) {
        await expectRefused(viewResponse, 'INCORRECT_TWO_FACTOR_CODE');
        expect(await countSessions(user.id)).toBe(sessionsBefore + 1);
      } else {
        await expectRefused(signInResponse, 'INVALID_TWO_FACTOR_CODE');
        expect(await isAuthenticated(signInClient)).toBe(false);
        expect(await countSessions(user.id)).toBe(sessionsBefore);
      }

      expectStillInStep(counter);
    }
  });

  test('[C6] after disable, a new secret enables with the current step even though that step was used under the old one', async () => {
    const ip = randomIp();
    const { user, session, secret: oldSecret } = await seedTwoFactorUser(ip);

    const counter = await freshStep();

    // Uses step c under the old secret.
    const disable = await session.post(DISABLE_PATHS[0], { data: { totpCode: await codeAt(oldSecret, counter) } });

    expect(disable.status(), await disable.text()).toBe(201);
    expect((await readUser(user.id)).twoFactorEnabled).toBe(false);

    const setup = await session.post(`${ROUTES.W1}/setup`, { data: {} });

    expect(setup.ok(), await setup.text()).toBe(true);

    const { secret: newSecret } = await setup.json();

    expect(newSecret).not.toBe(oldSecret);

    const enable = await session.post(`${ROUTES.W1}/enable`, { data: { code: await codeAt(newSecret, counter) } });

    expect(enable.ok(), await enable.text()).toBe(true);

    const after = await readUser(user.id);

    expect(after.twoFactorEnabled).toBe(true);
    expect(decrypt(after.twoFactorSecret)).toBe(newSecret);

    expectStillInStep(counter);
  });
});

/**
 * C8: consuming a step is tied to the secret the code was checked against. An enable request that verified secret A's
 * code must not spend the step for secret B, which setup put in place while the request was in flight.
 */
test.describe('[USER] a TOTP code cannot spend the step of another secret (#197, C8)', () => {
  /**
   * Sign in a fresh user without 2FA and run setup, so the user holds secret A with 2FA still off.
   */
  const seedSetUpUser = async (ip: string) => {
    const { user } = await seedUser({ password: PASSWORD });

    const session = await newClient(ip);
    const plainSignIn = await signIn(session, user.email);

    expect(plainSignIn.status(), await plainSignIn.text()).toBe(201);

    const setup = await session.post(`${ROUTES.W1}/setup`, { data: {} });

    expect(setup.ok(), await setup.text()).toBe(true);

    const { secret } = await setup.json();

    expect(typeof secret).toBe('string');
    expect(await readSecret(user.id)).toBe(secret);

    return { user, session, secretA: String(secret) };
  };

  /**
   * The User columns that setup writes: every two-factor or TOTP column except the enabled flag. Read from the schema,
   * so a column the fix adds is replaced along with the secret.
   */
  const setupColumns = async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'User' AND (column_name ILIKE '%twofactor%' OR column_name ILIKE '%totp%')
        AND column_name <> 'twoFactorEnabled'`;

    const columns = rows.map((row) => row.column_name);

    expect(columns).toEqual(expect.arrayContaining(['twoFactorSecret', 'twoFactorBackupCodes', 'lastTotpCounter']));

    return columns;
  };

  test('[A3][C8] deterministic: enable checks A, setup replaces it with B before enable consumes, and B still enables in that step', async () => {
    const ip = randomIp();
    const { user, session, secretA } = await seedSetUpUser(ip);

    // A donor user supplies what setup would write for secret B; its 2FA state is copied in under the row lock.
    const { user: donor } = await seedUser({ password: PASSWORD });

    await setupTwoFactorAuthentication({ user: donor });

    const secretB = await readSecret(donor.id);

    expect(secretB).not.toBe(secretA);

    const columns = await setupColumns();
    const assignments = columns.map((column) => `"${column}" = d."${column}"`).join(', ');

    const counter = await freshStep();
    const codeA = await codeAt(secretA, counter);
    const codeB = await codeAt(secretB, counter);

    let enableA: Promise<APIResponse> | undefined;
    let blockedBehindLock = false;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;

        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

        // The enable request reads secret A and verifies its code, then waits on the row lock to write.
        enableA = session.post(`${ROUTES.W1}/enable`, { data: { code: codeA } });

        for (let attempt = 0; attempt < 100 && !blockedBehindLock; attempt++) {
          const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;

          blockedBehindLock = waiting > 0;

          if (!blockedBehindLock) {
            await sleep(50);
          }
        }

        // Setup's effect, written while enable waits: secret B, its backup codes and a cleared counter.
        await tx.$executeRawUnsafe(
          `UPDATE "User" SET ${assignments} FROM "User" d WHERE "User".id = $1 AND d.id = $2`,
          user.id,
          donor.id,
        );
      },
      { timeout: 20_000 },
    );

    expect(blockedBehindLock, 'premise: the enable request waited on the locked User row').toBe(true);

    if (!enableA) {
      throw new Error('Expected the enable request to have been sent');
    }

    const oldEnable = await enableA;
    const oldEnableText = await oldEnable.text();

    expect.soft(oldEnable.ok(), `the enable that checked secret A: ${oldEnable.status()} ${oldEnableText}`).toBe(false);

    const afterRace = await readUser(user.id);

    expect(decrypt(afterRace.twoFactorSecret), 'secret B is the active secret after the race').toBe(secretB);
    expect.soft(afterRace.twoFactorEnabled, 'the enable that checked A did not switch 2FA on for B').toBe(false);

    const enableB = await session.post(`${ROUTES.W1}/enable`, { data: { code: codeB } });

    expect(
      enableB.ok(),
      `enable with B's code for step ${counter} (lastTotpCounter after the race ${afterRace.lastTotpCounter}): ${enableB.status()} ${await enableB.text()}`,
    ).toBe(true);

    const after = await readUser(user.id);

    expect(after.twoFactorEnabled).toBe(true);
    expect(decrypt(after.twoFactorSecret)).toBe(secretB);

    expectStillInStep(counter);
  });

  test('[A3][C8] concurrent repeats: enable with A races setup of B, and whenever B is left in place its code for the step enables', async () => {
    const ROUNDS = 12;
    const failures: string[] = [];
    const counts = { setupWon: 0, enableWon: 0, both: 0, neither: 0 };

    for (let round = 0; round < ROUNDS; round++) {
      // A fresh user and address each round keep every user and address under the sign-in rate limit.
      const { user, session, secretA } = await seedSetUpUser(randomIp());

      const counter = await freshStep();
      const codeA = await codeAt(secretA, counter);

      const [enable, setup] = await Promise.all([
        session.post(`${ROUTES.W1}/enable`, { data: { code: codeA } }),
        session.post(`${ROUTES.W1}/setup`, { data: {} }),
      ]);

      const label = `round ${round} enable=${enable.status()} setup=${setup.status()}`;
      const after = await readUser(user.id);
      const activeSecret = decrypt(after.twoFactorSecret);

      if (enable.ok() && setup.ok()) {
        counts.both++;
      } else if (enable.ok()) {
        counts.enableWon++;
      } else if (setup.ok()) {
        counts.setupWon++;
      } else {
        counts.neither++;
      }

      if (after.twoFactorEnabled) {
        if (activeSecret !== secretA) {
          failures.push(`${label}: 2FA is on for a secret the enable request did not check`);
        }

        expectStillInStep(counter);
        continue;
      }

      if (enable.ok()) {
        failures.push(`${label}: enable answered 200 but 2FA is off`);
      }

      if (activeSecret === secretA) {
        expectStillInStep(counter);
        continue;
      }

      const { secret: secretB } = setup.ok() ? await setup.json() : { secret: undefined };

      if (activeSecret !== secretB) {
        failures.push(`${label}: the active secret is neither A nor the one setup returned`);
        continue;
      }

      const enableB = await session.post(`${ROUTES.W1}/enable`, {
        data: { code: await codeAt(activeSecret, counter) },
      });

      if (!enableB.ok()) {
        failures.push(
          `${label}: B's code for step ${counter} is refused (lastTotpCounter after the race ${after.lastTotpCounter}): ${enableB.status()} ${await enableB.text()}`,
        );
      }

      expectStillInStep(counter);
    }

    console.log(
      `C8 rounds=${ROUNDS} setupWon=${counts.setupWon} enableWon=${counts.enableWon} both=${counts.both} neither=${counts.neither} failures=${failures.length}`,
    );

    expect(failures, failures.join('\n')).toEqual([]);
  });
});

/**
 * S6 is out of scope for consumption: a recipient with authenticator 2FA is asked for a code per signature field and
 * may use one code for all of them inside one step.
 */
test.describe('[DOCUMENT_AUTH] recipient authenticator 2FA still accepts one code for several actions (#197, C7)', () => {
  const trpcMutation = async (client: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
    return await client.post(`/api/trpc/${procedure}`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ json: input }),
    });
  };

  const seedTwoFactorRecipientDocument = async (ip: string, globalAccessAuth: Array<'TWO_FACTOR_AUTH'>) => {
    const { user: owner, team } = await seedUser();
    const recipientUser = await seedTwoFactorUser(ip);

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner,
      teamId: team.id,
      recipients: [recipientUser.user],
      fields: [FieldType.SIGNATURE, FieldType.SIGNATURE],
      updateDocumentOptions: {
        authOptions: createDocumentAuthOptions({ globalAccessAuth, globalActionAuth: ['TWO_FACTOR_AUTH'] }),
      },
    });

    const [recipient] = recipients;

    expect(recipient.fields.filter((field) => field.type === FieldType.SIGNATURE)).toHaveLength(2);

    return {
      ...recipientUser,
      token: recipient.token,
      recipientId: recipient.id,
      fieldIds: recipient.fields.map((field) => field.id),
      documentId: mapSecondaryIdToDocumentId(document.secondaryId),
    };
  };

  const authenticatorAuth = (token: string) => ({ type: 'TWO_FACTOR_AUTH', method: 'authenticator', token });

  const signBothFieldsAndComplete = async (
    client: APIRequestContext,
    seeded: Awaited<ReturnType<typeof seedTwoFactorRecipientDocument>>,
    code: string,
  ) => {
    for (const fieldId of seeded.fieldIds) {
      const response = await trpcMutation(client, 'field.signFieldWithToken', {
        token: seeded.token,
        fieldId,
        value: 'Replay Signer',
        isBase64: false,
        authOptions: authenticatorAuth(code),
      });

      expect(response.ok(), `field ${fieldId}: ${await response.text()}`).toBe(true);
    }

    const fields = await prisma.field.findMany({ where: { id: { in: seeded.fieldIds } } });

    expect(fields.every((field) => field.inserted)).toBe(true);

    const complete = await trpcMutation(client, 'recipient.completeDocumentWithToken', {
      token: seeded.token,
      documentId: seeded.documentId,
      accessAuthOptions: authenticatorAuth(code),
    });

    expect(complete.ok(), await complete.text()).toBe(true);

    const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.recipientId } });

    expect(recipient.signingStatus).toBe(SigningStatus.SIGNED);
  };

  test('[C7] action auth: two signature fields and completion with the same code inside one step', async () => {
    const ip = randomIp();
    const seeded = await seedTwoFactorRecipientDocument(ip, []);

    const counter = await freshStep();
    const code = await codeAt(seeded.secret, counter);

    await signBothFieldsAndComplete(seeded.session, seeded, code);

    expectStillInStep(counter);
  });

  test('[C7] access and action auth: sign-in, access verification twice, two fields and completion with one code', async () => {
    const ip = randomIp();
    const seeded = await seedTwoFactorRecipientDocument(ip, ['TWO_FACTOR_AUTH']);

    const counter = await freshStep();
    const code = await codeAt(seeded.secret, counter);

    // S1 consumes the step for account sinks; S6 must still take the same code.
    const client = await newClient(ip);
    const signInResponse = await signIn(client, seeded.user.email, code);

    expect(signInResponse.status(), await signInResponse.text()).toBe(201);

    for (let attempt = 0; attempt < 2; attempt++) {
      const verify = await trpcMutation(client, 'document.accessAuth.verify2FA', {
        token: seeded.token,
        authOptions: authenticatorAuth(code),
      });

      expect(verify.ok(), `access verification ${attempt}: ${await verify.text()}`).toBe(true);
    }

    await signBothFieldsAndComplete(client, seeded, code);

    expectStillInStep(counter);
  });
});
