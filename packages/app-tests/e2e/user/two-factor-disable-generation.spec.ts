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
 * Issue #196: a two-factor disable authorised against one setup must not erase another. Both disable routes (W1 and
 * W2) are driven over HTTP and the user row and audit log are read back from the database after each step.
 *
 * The write that lands between validation and the disabling write cannot be scheduled over HTTP, so C2, C3 and C6 are
 * covered in `packages/lib/server-only/2fa/disable-2fa.race.test.ts`.
 *
 * Each test sends its own X-Forwarded-For address and signs in once, to stay well under the sign-in rate limit.
 */

test.describe.configure({ mode: 'parallel', timeout: 90000 });

const PASSWORD = 'password';

const PERIOD_MS = 30_000;

const ROUTES = {
  W1: '/api/auth/two-factor',
  W2: '/api/auth/email-password/2fa',
} as const;

type RouteName = keyof typeof ROUTES;

const decryptSecret = (ciphertext: string | null) => {
  if (!DOCUMENSO_ENCRYPTION_KEY || !ciphertext) {
    throw new Error('Expected encryption key and 2FA secret');
  }

  return Buffer.from(symmetricDecrypt({ key: DOCUMENSO_ENCRYPTION_KEY, data: ciphertext })).toString('utf-8');
};

const decryptBackupCodes = (ciphertext: string) => {
  const codes: unknown = JSON.parse(decryptSecret(ciphertext));

  if (!Array.isArray(codes)) {
    throw new Error('Expected backup codes to be a list');
  }

  return codes.map(String);
};

/**
 * TOTP for a base32 secret. The server accepts only the current 30-second window, so if the window is about to roll
 * over, wait for the next one rather than send a code that may expire in flight.
 */
const totpFor = async (secret: string) => {
  const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);

  if (remaining < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 250));
  }

  return await generateHOTP(base32.decode(secret), Math.floor(Date.now() / PERIOD_MS));
};

const readUser = async (userId: number) => {
  return await prisma.user.findUniqueOrThrow({ where: { id: userId } });
};

const getCurrentTotpCode = async (userId: number) => {
  const user = await readUser(userId);

  return await totpFor(decryptSecret(user.twoFactorSecret));
};

const countDisableAudits = async (userId: number) => {
  return await prisma.userSecurityAuditLog.count({
    where: { userId, type: UserSecurityAuditLogType.AUTH_2FA_DISABLE },
  });
};

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

/**
 * Seed a unique user with 2FA enabled and a signed-in client, without spending any TOTP code (#197). The client signs
 * in before 2FA is switched on, and 2FA is switched on by a direct write rather than through enable, so the current
 * step is still unused when the test sends its first code. Returns the recovery codes read from the stored ciphertext.
 */
const seedTwoFactorUser = async () => {
  const { user } = await seedUser({ password: PASSWORD });
  const client = await newClient(randomIp());

  const response = await client.post('/api/auth/email-password/authorize', {
    data: { email: user.email, password: PASSWORD, csrfToken: await getCsrfToken(client) },
  });

  expect(response.status(), await response.text()).toBe(201);

  await setupTwoFactorAuthentication({ user });
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });

  const stored = await readUser(user.id);

  expect(stored.twoFactorEnabled).toBe(true);
  expect(stored.twoFactorBackupCodes).not.toBeNull();

  return { user, client, codes: decryptBackupCodes(stored.twoFactorBackupCodes ?? '') };
};

/**
 * TOTP for the step after the current one, once it has begun. A code of a step already accepted by the server is
 * refused, so a second use for the same secret needs a later step.
 */
const nextStepTotp = async (secret: string) => {
  await new Promise((resolve) => setTimeout(resolve, PERIOD_MS - (Date.now() % PERIOD_MS) + 250));

  return await totpFor(secret);
};

const expectRefused = async (response: APIResponse, code: string) => {
  expect(response.status(), await response.text()).toBe(400);
  expect(await response.json()).toMatchObject({ code });
};

const expectDisabled = async (userId: number) => {
  const user = await readUser(userId);

  expect(user.twoFactorEnabled).toBe(false);
  expect(user.twoFactorSecret).toBeNull();
  expect(user.twoFactorBackupCodes).toBeNull();
};

/**
 * Set up and enable a new authenticator over HTTP and return the secret it holds.
 */
const setupAndEnable = async (client: APIRequestContext, base: string, userId: number) => {
  const setup = await client.post(`${base}/setup`, { data: {} });

  expect(setup.ok(), await setup.text()).toBe(true);

  const { secret } = await setup.json();

  expect(typeof secret).toBe('string');

  const enable = await client.post(`${base}/enable`, { data: { code: await totpFor(secret) } });

  expect(enable.ok(), await enable.text()).toBe(true);
  expect((await readUser(userId)).twoFactorEnabled).toBe(true);

  return secret as string;
};

test.describe('[USER] two-factor disable is bound to the setup it validated (#196)', () => {
  for (const [name, base] of Object.entries(ROUTES)) {
    test(`[C1] ${name} disables with a valid TOTP code and writes one audit row`, async () => {
      const { user, client } = await seedTwoFactorUser();

      const response = await client.post(`${base}/disable`, { data: { totpCode: await getCurrentTotpCode(user.id) } });

      expect(response.status(), await response.text()).toBe(201);

      await expectDisabled(user.id);
      expect(await countDisableAudits(user.id)).toBe(1);
    });

    test(`[C1] ${name} disables with an unused recovery code and writes one audit row`, async () => {
      const { user, codes, client } = await seedTwoFactorUser();

      const response = await client.post(`${base}/disable`, { data: { backupCode: codes[0] } });

      expect(response.status(), await response.text()).toBe(201);

      await expectDisabled(user.id);
      expect(await countDisableAudits(user.id)).toBe(1);
    });

    test(`[C9] ${name}: a wrong code is refused with 400 INCORRECT_TWO_FACTOR_CODE and changes nothing`, async () => {
      const { user, client } = await seedTwoFactorUser();
      const before = await readUser(user.id);
      const current = await getCurrentTotpCode(user.id);
      const wrong = current === '000000' ? '000001' : '000000';

      const response = await client.post(`${base}/disable`, { data: { totpCode: wrong } });

      await expectRefused(response, 'INCORRECT_TWO_FACTOR_CODE');

      const after = await readUser(user.id);

      expect(after.twoFactorEnabled).toBe(true);
      expect(after.twoFactorSecret).toBe(before.twoFactorSecret);
      expect(after.twoFactorBackupCodes).toBe(before.twoFactorBackupCodes);
      expect(await countDisableAudits(user.id)).toBe(0);
    });

    test(`[C4] ${name}: two concurrent disables with one TOTP code give one 201 and one audit row`, async () => {
      const { user, client } = await seedTwoFactorUser();
      const totpCode = await getCurrentTotpCode(user.id);

      const responses = await Promise.all([
        client.post(`${base}/disable`, { data: { totpCode } }),
        client.post(`${base}/disable`, { data: { totpCode } }),
      ]);

      const statuses = responses.map((response) => response.status());

      expect(
        statuses.filter((status) => status === 201),
        JSON.stringify(statuses),
      ).toHaveLength(1);

      const refused = responses.find((response) => response.status() !== 201);

      if (!refused) {
        throw new Error('Expected one disable to be refused');
      }

      await expectRefused(refused, 'INCORRECT_TWO_FACTOR_CODE');

      await expectDisabled(user.id);
      expect(await countDisableAudits(user.id)).toBe(1);
    });

    test(`[C5] ${name}: a code from the old secret is refused after disable and re-setup`, async () => {
      const { user, client } = await seedTwoFactorUser();

      const oldSecret = decryptSecret((await readUser(user.id)).twoFactorSecret);
      const oldCode = await totpFor(oldSecret);

      const first = await client.post(`${base}/disable`, { data: { totpCode: oldCode } });

      expect(first.status(), await first.text()).toBe(201);
      await expectDisabled(user.id);

      const newSecret = await setupAndEnable(client, base, user.id);

      expect(newSecret).not.toBe(oldSecret);

      // If both secrets give the same six digits in this window, the old code would validate against the new secret.
      while ((await totpFor(newSecret)) === oldCode) {
        await new Promise((resolve) => setTimeout(resolve, PERIOD_MS - (Date.now() % PERIOD_MS) + 250));
      }

      const afterEnable = await readUser(user.id);

      const stale = await client.post(`${base}/disable`, { data: { totpCode: oldCode } });

      await expectRefused(stale, 'INCORRECT_TWO_FACTOR_CODE');

      const afterStale = await readUser(user.id);

      expect(afterStale.twoFactorEnabled).toBe(true);
      expect(afterStale.twoFactorSecret).toBe(afterEnable.twoFactorSecret);
      expect(afterStale.twoFactorBackupCodes).toBe(afterEnable.twoFactorBackupCodes);
      expect(await countDisableAudits(user.id)).toBe(1);

      // The enable above spent this step for the new secret, so the closing disable uses the next one.
      const current = await client.post(`${base}/disable`, { data: { totpCode: await nextStepTotp(newSecret) } });

      expect(current.status(), await current.text()).toBe(201);
      await expectDisabled(user.id);
      expect(await countDisableAudits(user.id)).toBe(2);
    });
  }
});

test.describe('[USER] a disable with two-factor already off is refused with 400 (#196, C11)', () => {
  for (const [name, base] of Object.entries(ROUTES)) {
    test(`[C11] ${name}: a disable after two-factor was turned off gives 400 INCORRECT_TWO_FACTOR_CODE`, async () => {
      const { user, client } = await seedTwoFactorUser();

      const first = await client.post(`${base}/disable`, { data: { totpCode: await getCurrentTotpCode(user.id) } });

      expect(first.status(), await first.text()).toBe(201);
      await expectDisabled(user.id);

      const response = await client.post(`${base}/disable`, { data: { totpCode: '123456' } });

      await expectRefused(response, 'INCORRECT_TWO_FACTOR_CODE');
      await expectDisabled(user.id);
      expect(await countDisableAudits(user.id)).toBe(1);
    });

    test(`[C11] ${name}: a disable for a user who never enabled two-factor gives 400 INCORRECT_TWO_FACTOR_CODE`, async () => {
      const { user } = await seedUser({ password: PASSWORD });
      const client = await newClient(randomIp());

      const signIn = await client.post('/api/auth/email-password/authorize', {
        data: { email: user.email, password: PASSWORD, csrfToken: await getCsrfToken(client) },
      });

      expect(signIn.status(), await signIn.text()).toBe(201);

      const response = await client.post(`${base}/disable`, { data: { totpCode: '123456' } });

      await expectRefused(response, 'INCORRECT_TWO_FACTOR_CODE');
      await expectDisabled(user.id);
      expect(await countDisableAudits(user.id)).toBe(0);
    });
  }
});
