import { randomInt } from 'node:crypto';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENSO_ENCRYPTION_KEY } from '@documenso/lib/constants/crypto';
import { setupTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/setup-2fa';
import { symmetricDecrypt } from '@documenso/lib/universal/crypto';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, request, test } from '@playwright/test';
import { UserSecurityAuditLogType } from '@prisma/client';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

/**
 * Issue #135: a two-factor recovery code must work once. Every route that
 * accepts one (S1 to S6 in the spec) is driven over HTTP against the running
 * app, and the stored list is read back from the database after each step.
 *
 * Sign-in and password update are rate limited per IP and per user. Each test
 * sends its own X-Forwarded-For address so the tests do not share an IP
 * bucket, and no user signs in more than nine times.
 */

test.describe.configure({ mode: 'parallel', timeout: 90000 });

const PASSWORD = 'password';

const WRONG_CODE = 'FFFFF-FFFFF';

const decryptBackupCodes = (ciphertext: string | null) => {
  if (!DOCUMENSO_ENCRYPTION_KEY || !ciphertext) {
    throw new Error('Expected encryption key and backup codes');
  }

  const plain = Buffer.from(symmetricDecrypt({ key: DOCUMENSO_ENCRYPTION_KEY, data: ciphertext })).toString('utf-8');

  const codes: unknown = JSON.parse(plain);

  if (!Array.isArray(codes)) {
    throw new Error('Expected backup codes to be a list');
  }

  return codes.map(String);
};

const readStored = async (userId: number) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  return {
    ciphertext: user.twoFactorBackupCodes,
    codes: user.twoFactorBackupCodes ? decryptBackupCodes(user.twoFactorBackupCodes) : [],
    twoFactorEnabled: user.twoFactorEnabled,
  };
};

/**
 * Derive the current TOTP for a user the same way `verifyTwoFactorAuthenticationToken` does.
 */
const getCurrentTotpCode = async (userId: number) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!DOCUMENSO_ENCRYPTION_KEY || !user.twoFactorSecret) {
    throw new Error('Expected encryption key and 2FA secret');
  }

  const secret = Buffer.from(symmetricDecrypt({ key: DOCUMENSO_ENCRYPTION_KEY, data: user.twoFactorSecret })).toString(
    'utf-8',
  );

  return await generateHOTP(base32.decode(secret), Math.floor(Date.now() / 30_000));
};

/**
 * Seed a unique user with 2FA enabled and return the ten recovery codes read
 * from the stored ciphertext. 2FA is switched on by a direct write rather than
 * through enable, so no TOTP code is spent and the current step is still unused
 * when a test sends its first code (#197).
 */
const seedTwoFactorUser = async (password = PASSWORD) => {
  const { user } = await seedUser({ password });

  await setupTwoFactorAuthentication({ user });

  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });

  const stored = await readStored(user.id);

  expect(stored.twoFactorEnabled).toBe(true);
  expect(stored.codes).toHaveLength(10);
  expect(new Set(stored.codes).size).toBe(10);

  return { user, codes: stored.codes };
};

const randomIp = () => `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;

const newClient = async (ip: string) => {
  return await request.newContext({
    baseURL: NEXT_PUBLIC_WEBAPP_URL(),
    extraHTTPHeaders: { 'x-forwarded-for': ip },
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

type SignInCredentials = {
  email: string;
  password?: string;
  totpCode?: string;
  backupCode?: string;
};

const signIn = async (
  client: APIRequestContext,
  { email, password = PASSWORD, totpCode, backupCode }: SignInCredentials,
) => {
  const csrfToken = await getCsrfToken(client);

  return await client.post('/api/auth/email-password/authorize', {
    data: { email, password, totpCode, backupCode, csrfToken },
  });
};

const isAuthenticated = async (client: APIRequestContext) => {
  const response = await client.get('/api/auth/session');
  const session = await response.json();

  return session.isAuthenticated === true;
};

/**
 * TOTP for the step after the current one, once it has begun. A code of a step the server has accepted is refused
 * until the next step, so a second TOTP use for the same user waits for the boundary.
 */
const getNextStepTotpCode = async (userId: number) => {
  await new Promise((resolve) => setTimeout(resolve, 30_000 - (Date.now() % 30_000) + 250));

  return await getCurrentTotpCode(userId);
};

/**
 * A fresh client signed in with the current TOTP, for the session-bound sinks.
 */
const signedInClient = async (ip: string, email: string, userId: number, password = PASSWORD) => {
  const client = await newClient(ip);
  const response = await signIn(client, { email, password, totpCode: await getCurrentTotpCode(userId) });

  expect(response.status()).toBe(201);
  expect(await isAuthenticated(client)).toBe(true);

  return client;
};

const expectRefused = async (response: APIResponse, code: string) => {
  expect(response.ok()).toBe(false);
  expect(await response.json()).toMatchObject({ code });
};

const countTwoFactorFailures = async (userId: number) => {
  return await prisma.userSecurityAuditLog.count({
    where: { userId, type: UserSecurityAuditLogType.SIGN_IN_2FA_FAIL },
  });
};

test.describe('[USER] recovery code single use (#135)', () => {
  test('[C1][C2] a recovery code signs in once, is refused on reuse, and a second code still works', async () => {
    const { user, codes } = await seedTwoFactorUser();
    const [codeR, codeR2] = codes;
    const ip = randomIp();

    const first = await newClient(ip);
    const firstResponse = await signIn(first, { email: user.email, backupCode: codeR });

    expect(firstResponse.status()).toBe(201);
    expect(await isAuthenticated(first)).toBe(true);

    const afterFirst = await readStored(user.id);

    expect(afterFirst.codes).toHaveLength(9);
    expect(afterFirst.codes).not.toContain(codeR);
    expect(afterFirst.codes).toContain(codeR2);

    await first.post('/api/auth/signout');
    expect(await isAuthenticated(first)).toBe(false);

    const failuresBefore = await countTwoFactorFailures(user.id);

    const reuse = await newClient(ip);
    const reuseResponse = await signIn(reuse, { email: user.email, backupCode: codeR });

    await expectRefused(reuseResponse, 'INVALID_TWO_FACTOR_CODE');
    expect(await isAuthenticated(reuse)).toBe(false);
    expect(await countTwoFactorFailures(user.id)).toBe(failuresBefore + 1);

    const failureRow = await prisma.userSecurityAuditLog.findFirstOrThrow({
      where: { userId: user.id, type: UserSecurityAuditLogType.SIGN_IN_2FA_FAIL },
      orderBy: { createdAt: 'desc' },
    });

    // Confirms the per-test address reaches the server, so the IP rate limit bucket is ours.
    expect(failureRow.ipAddress).toBe(ip);

    const second = await newClient(ip);
    const secondResponse = await signIn(second, { email: user.email, backupCode: codeR2 });

    expect(secondResponse.status()).toBe(201);
    expect(await isAuthenticated(second)).toBe(true);

    const afterSecond = await readStored(user.id);

    expect(afterSecond.codes).toHaveLength(8);
    expect(afterSecond.codes).not.toContain(codeR2);
  });

  test('[C3] a code spent at sign-in is refused at password update and at view recovery codes', async () => {
    const { user, codes } = await seedTwoFactorUser();
    const [codeR] = codes;
    const ip = randomIp();

    const client = await newClient(ip);
    const signInResponse = await signIn(client, { email: user.email, backupCode: codeR });

    expect(signInResponse.status()).toBe(201);

    const passwordBefore = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password;

    const updateResponse = await client.post('/api/auth/email-password/update-password', {
      data: { currentPassword: PASSWORD, password: 'Test123!', backupCode: codeR },
    });

    expect(updateResponse.status()).toBe(401);
    expect(await updateResponse.json()).toMatchObject({ code: 'INCORRECT_TWO_FACTOR_CODE' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password).toBe(passwordBefore);

    const viewResponse = await client.post('/api/auth/email-password/2fa/view-recovery-codes', {
      data: { token: codeR },
    });

    await expectRefused(viewResponse, 'INCORRECT_TWO_FACTOR_CODE');

    const viewTwoFactorResponse = await client.post('/api/auth/two-factor/view-recovery-codes', {
      data: { token: codeR },
    });

    await expectRefused(viewTwoFactorResponse, 'INCORRECT_TWO_FACTOR_CODE');

    const stored = await readStored(user.id);

    expect(stored.codes).toHaveLength(9);
    expect(stored.codes).not.toContain(codeR);
  });

  test('[C3] a code spent at view recovery codes is refused at sign-in', async () => {
    const { user, codes } = await seedTwoFactorUser();
    const [codeR] = codes;
    const ip = randomIp();

    const client = await signedInClient(ip, user.email, user.id);

    const viewResponse = await client.post('/api/auth/email-password/2fa/view-recovery-codes', {
      data: { token: codeR },
    });

    expect(viewResponse.ok()).toBe(true);

    const failuresBefore = await countTwoFactorFailures(user.id);

    const other = await newClient(ip);
    const signInResponse = await signIn(other, { email: user.email, backupCode: codeR });

    await expectRefused(signInResponse, 'INVALID_TWO_FACTOR_CODE');
    expect(await isAuthenticated(other)).toBe(false);
    expect(await countTwoFactorFailures(user.id)).toBe(failuresBefore + 1);
  });

  test('[C1] a code spent at sign-in cannot disable 2FA at either disable route', async () => {
    const { user, codes } = await seedTwoFactorUser();
    const [codeR] = codes;
    const ip = randomIp();

    const client = await newClient(ip);
    const signInResponse = await signIn(client, { email: user.email, backupCode: codeR });

    expect(signInResponse.status()).toBe(201);

    const emailPasswordDisable = await client.post('/api/auth/email-password/2fa/disable', {
      data: { backupCode: codeR },
    });

    await expectRefused(emailPasswordDisable, 'INCORRECT_TWO_FACTOR_CODE');
    expect((await readStored(user.id)).twoFactorEnabled).toBe(true);

    const twoFactorDisable = await client.post('/api/auth/two-factor/disable', {
      data: { backupCode: codeR },
    });

    await expectRefused(twoFactorDisable, 'INCORRECT_TWO_FACTOR_CODE');

    const stored = await readStored(user.id);

    expect(stored.twoFactorEnabled).toBe(true);
    expect(stored.codes).toHaveLength(9);
    expect(stored.codes).not.toContain(codeR);
  });

  test('[C1] an unspent recovery code disables 2FA at the two-factor disable route', async () => {
    const { user, codes } = await seedTwoFactorUser();
    const ip = randomIp();

    const client = await signedInClient(ip, user.email, user.id);

    const disableResponse = await client.post('/api/auth/two-factor/disable', {
      data: { backupCode: codes[3] },
    });

    expect(disableResponse.status()).toBe(201);

    const stored = await readStored(user.id);

    expect(stored.twoFactorEnabled).toBe(false);
    expect(stored.ciphertext).toBeNull();
  });

  for (const parallel of [2, 8]) {
    test(`[C4] ${parallel} concurrent sign-ins with one unused code yield exactly one session`, async () => {
      const { user, codes } = await seedTwoFactorUser();
      const [codeR] = codes;
      const ip = randomIp();

      const clients = await Promise.all(Array.from({ length: parallel }, async () => await newClient(ip)));
      const csrfTokens = await Promise.all(clients.map(async (client) => await getCsrfToken(client)));
      const failuresBefore = await countTwoFactorFailures(user.id);

      const responses = await Promise.all(
        clients.map(
          async (client, index) =>
            await client.post('/api/auth/email-password/authorize', {
              data: { email: user.email, password: PASSWORD, backupCode: codeR, csrfToken: csrfTokens[index] },
            }),
        ),
      );

      const statuses = responses.map((response) => response.status());

      expect(statuses.filter((value) => value === 201)).toHaveLength(1);

      // C4 amended: every loser gets the S1 wrong-code response, InvalidTwoFactorCode with a SIGN_IN_2FA_FAIL row.
      const losers = responses.filter((response) => response.status() !== 201);

      expect(losers).toHaveLength(parallel - 1);

      for (const loser of losers) {
        await expectRefused(loser, 'INVALID_TWO_FACTOR_CODE');
      }

      expect(await countTwoFactorFailures(user.id)).toBe(failuresBefore + parallel - 1);

      const sessions = await Promise.all(clients.map(async (client) => await isAuthenticated(client)));

      expect(sessions.filter(Boolean)).toHaveLength(1);

      const stored = await readStored(user.id);

      expect(stored.codes).toHaveLength(9);
      expect(stored.codes).not.toContain(codeR);
      expect(stored.codes.sort()).toEqual(codes.filter((code) => code !== codeR).sort());
    });
  }

  test('[C4] concurrent sign-ins with two different unused codes both succeed and both codes are spent', async () => {
    const { user, codes } = await seedTwoFactorUser();
    const [codeR, codeR2] = codes;
    const ip = randomIp();

    const clients = await Promise.all([newClient(ip), newClient(ip)]);
    const csrfTokens = await Promise.all(clients.map(async (client) => await getCsrfToken(client)));

    const responses = await Promise.all(
      [codeR, codeR2].map(
        async (backupCode, index) =>
          await clients[index].post('/api/auth/email-password/authorize', {
            data: { email: user.email, password: PASSWORD, backupCode, csrfToken: csrfTokens[index] },
          }),
      ),
    );

    expect(responses.map((response) => response.status())).toEqual([201, 201]);

    const stored = await readStored(user.id);

    expect(stored.codes).toHaveLength(8);
    expect(stored.codes.sort()).toEqual(codes.filter((code) => code !== codeR && code !== codeR2).sort());
  });

  test('[C5][C6] every other code works once, all are refused once spent, and TOTP still signs in', async () => {
    const { user, codes } = await seedTwoFactorUser();
    const [codeR, ...others] = codes;
    const ip = randomIp();

    const client = await newClient(ip);
    const signInResponse = await signIn(client, { email: user.email, backupCode: codeR });

    expect(signInResponse.status()).toBe(201);

    // The other nine are spent at the view routes, alternating S5 and S6, since
    // sign-in is limited to ten attempts per user in fifteen minutes.
    const viewPaths = ['/api/auth/email-password/2fa/view-recovery-codes', '/api/auth/two-factor/view-recovery-codes'];

    let expectedRemaining = codes.filter((code) => code !== codeR);

    for (const [index, code] of others.entries()) {
      const viewPath = viewPaths[index % 2];
      const viewResponse = await client.post(viewPath, { data: { token: code } });

      expect(viewResponse.ok()).toBe(true);

      expectedRemaining = expectedRemaining.filter((remaining) => remaining !== code);

      const { backupCodes } = await viewResponse.json();

      expect([...backupCodes].sort()).toEqual([...expectedRemaining].sort());
      expect((await readStored(user.id)).codes.sort()).toEqual([...expectedRemaining].sort());

      const reuseResponse = await client.post(viewPaths[(index + 1) % 2], { data: { token: code } });

      await expectRefused(reuseResponse, 'INCORRECT_TWO_FACTOR_CODE');
    }

    expect((await readStored(user.id)).codes).toEqual([]);

    for (const code of codes) {
      const viewResponse = await client.post(viewPaths[0], { data: { token: code } });

      await expectRefused(viewResponse, 'INCORRECT_TWO_FACTOR_CODE');
    }

    const refused = await newClient(ip);
    const refusedResponse = await signIn(refused, { email: user.email, backupCode: others[8] });

    await expectRefused(refusedResponse, 'INVALID_TWO_FACTOR_CODE');
    expect(await isAuthenticated(refused)).toBe(false);

    const totp = await newClient(ip);
    const totpResponse = await signIn(totp, { email: user.email, totpCode: await getCurrentTotpCode(user.id) });

    expect(totpResponse.status()).toBe(201);
    expect(await isAuthenticated(totp)).toBe(true);
  });

  for (const viewPath of [
    '/api/auth/email-password/2fa/view-recovery-codes',
    '/api/auth/two-factor/view-recovery-codes',
  ]) {
    test(`[C6] viewing codes at ${viewPath} with a recovery code returns the remaining nine`, async () => {
      const { user, codes } = await seedTwoFactorUser();
      const [, , codeR] = codes;
      const ip = randomIp();

      const client = await signedInClient(ip, user.email, user.id);

      const viewResponse = await client.post(viewPath, { data: { token: codeR } });

      expect(viewResponse.ok()).toBe(true);

      const { backupCodes } = await viewResponse.json();

      expect(backupCodes).toHaveLength(9);
      expect(backupCodes).not.toContain(codeR);
      expect([...backupCodes].sort()).toEqual(codes.filter((code) => code !== codeR).sort());
      expect((await readStored(user.id)).codes.sort()).toEqual([...backupCodes].sort());
    });
  }

  test('[C7] TOTP at sign-in, password update and view codes leaves the stored ciphertext unchanged', async () => {
    // Each TOTP use is in its own step (#197), so this test spends three steps.
    test.setTimeout(180_000);

    const { user, codes } = await seedTwoFactorUser();
    const ip = randomIp();
    const { ciphertext } = await readStored(user.id);

    const client = await signedInClient(ip, user.email, user.id);

    expect((await readStored(user.id)).ciphertext).toBe(ciphertext);

    const updateResponse = await client.post('/api/auth/email-password/update-password', {
      data: { currentPassword: PASSWORD, password: 'Test123!', totpCode: await getNextStepTotpCode(user.id) },
    });

    expect(updateResponse.status()).toBe(201);
    expect((await readStored(user.id)).ciphertext).toBe(ciphertext);

    const viewResponse = await client.post('/api/auth/email-password/2fa/view-recovery-codes', {
      data: { token: await getNextStepTotpCode(user.id) },
    });

    expect(viewResponse.ok()).toBe(true);

    const { backupCodes } = await viewResponse.json();

    expect([...backupCodes].sort()).toEqual([...codes].sort());
    expect((await readStored(user.id)).ciphertext).toBe(ciphertext);
  });

  test('[C8] a wrong recovery code at every sink leaves the stored ciphertext byte-identical', async () => {
    const { user } = await seedTwoFactorUser();
    const ip = randomIp();
    const { ciphertext } = await readStored(user.id);

    const outsider = await newClient(ip);
    const signInResponse = await signIn(outsider, { email: user.email, backupCode: WRONG_CODE });

    await expectRefused(signInResponse, 'INVALID_TWO_FACTOR_CODE');
    expect((await readStored(user.id)).ciphertext).toBe(ciphertext);

    const client = await signedInClient(ip, user.email, user.id);

    const updateResponse = await client.post('/api/auth/email-password/update-password', {
      data: { currentPassword: PASSWORD, password: 'Test123!', backupCode: WRONG_CODE },
    });

    expect(updateResponse.status()).toBe(401);
    expect((await readStored(user.id)).ciphertext).toBe(ciphertext);

    const refusals: Array<[string, Record<string, string>]> = [
      ['/api/auth/email-password/2fa/disable', { backupCode: WRONG_CODE }],
      ['/api/auth/two-factor/disable', { backupCode: WRONG_CODE }],
      ['/api/auth/email-password/2fa/view-recovery-codes', { token: WRONG_CODE }],
      ['/api/auth/two-factor/view-recovery-codes', { token: WRONG_CODE }],
    ];

    for (const [sinkPath, data] of refusals) {
      const response = await client.post(sinkPath, { data });

      await expectRefused(response, 'INCORRECT_TWO_FACTOR_CODE');
      expect((await readStored(user.id)).ciphertext).toBe(ciphertext);
    }

    expect((await readStored(user.id)).twoFactorEnabled).toBe(true);
  });

  test('[C9] a correct recovery code at password update is spent even when the new password is refused', async () => {
    // Chosen behaviour: the code is a credential that was presented and accepted,
    // so it is consumed although the request then fails with SAME_PASSWORD.
    // The password must pass the new-password schema to reach the same-password check.
    const strongPassword = 'Recovery135!';
    const { user, codes } = await seedTwoFactorUser(strongPassword);
    const [codeR] = codes;
    const ip = randomIp();

    const client = await signedInClient(ip, user.email, user.id, strongPassword);

    const updateResponse = await client.post('/api/auth/email-password/update-password', {
      data: { currentPassword: strongPassword, password: strongPassword, backupCode: codeR },
    });

    await expectRefused(updateResponse, 'SAME_PASSWORD');

    const stored = await readStored(user.id);

    expect(stored.codes).toHaveLength(9);
    expect(stored.codes).not.toContain(codeR);

    const viewResponse = await client.post('/api/auth/two-factor/view-recovery-codes', { data: { token: codeR } });

    await expectRefused(viewResponse, 'INCORRECT_TWO_FACTOR_CODE');
  });
});
