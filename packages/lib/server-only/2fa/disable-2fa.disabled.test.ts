import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #196 (C11): a disable that finds two-factor already off on the primary is refused with
 * INCORRECT_TWO_FACTOR_CODE and HTTP 400, writes nothing and writes no audit row.
 *
 * `./validate-2fa` is deliberately not mocked. The real validator throws a different error for a user with 2FA off or
 * without a secret, so this file pins that the disable refuses before validation runs. Only the database is faked.
 */

const { TEST_KEY } = vi.hoisted(() => ({ TEST_KEY: 'disable-2fa-196-disabled-test-key' }));

vi.mock('../../constants/crypto', () => ({
  DOCUMENSO_ENCRYPTION_KEY: TEST_KEY,
  DOCUMENSO_ENCRYPTION_SECONDARY_KEY: `${TEST_KEY}-secondary`,
}));

type Row = {
  id: number;
  email: string;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorBackupCodes: string | null;
};

const USER_ID = 196;

const db: { row: Row; writes: Array<Record<string, unknown>>; audits: Array<Record<string, unknown>> } = {
  row: { id: USER_ID, email: '', twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null },
  writes: [],
  audits: [],
};

const makeClient = () => ({
  user: {
    updateMany: async (args: Record<string, unknown>) => {
      db.writes.push(args);

      return { count: 0 };
    },
    update: async (args: Record<string, unknown>) => {
      db.writes.push(args);

      return { ...db.row };
    },
    findUnique: async () => ({ ...db.row }),
    findUniqueOrThrow: async () => ({ ...db.row }),
    findFirst: async () => ({ ...db.row }),
  },
  userSecurityAuditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      db.audits.push(data);

      return data;
    },
  },
});

const rootClient = {
  ...makeClient(),
  $primary: () => makeClient(),
  $transaction: async (work: unknown) => {
    if (typeof work !== 'function') {
      return await Promise.all(work as Array<Promise<unknown>>);
    }

    return await work(makeClient());
  },
};

vi.mock('@documenso/prisma', () => ({ prisma: rootClient }));

vi.mock('../database/primary-client', () => ({ primaryClient: () => rootClient }));

const { disableTwoFactorAuthentication } = await import('./disable-2fa');

const disableAs = async (credentials: { totpCode?: string; backupCode?: string }) => {
  return await disableTwoFactorAuthentication({
    user: { ...db.row, twoFactorEnabled: true, twoFactorSecret: 'caller-stale-secret' },
    ...credentials,
    requestMetadata: { ipAddress: '10.0.0.1', userAgent: 'vitest' } as never,
  });
};

const expectRefusedAsWrongCode = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({ code: 'INCORRECT_TWO_FACTOR_CODE', statusCode: 400 });
};

beforeEach(() => {
  db.writes = [];
  db.audits = [];
});

describe('disableTwoFactorAuthentication when two-factor is already off on the primary (C11)', () => {
  const cases: Array<[string, Partial<Row>]> = [
    ['twoFactorEnabled is false', { twoFactorEnabled: false, twoFactorSecret: 'encrypted-secret' }],
    ['twoFactorEnabled is false and nothing is stored', { twoFactorEnabled: false, twoFactorSecret: null }],
    ['twoFactorSecret is null while twoFactorEnabled is true', { twoFactorEnabled: true, twoFactorSecret: null }],
  ];

  for (const [label, row] of cases) {
    for (const credentials of [{ totpCode: '123456' }, { backupCode: 'AAAAA-BBBBB' }]) {
      it(`refuses with INCORRECT_TWO_FACTOR_CODE and 400, and writes nothing, when ${label} (${Object.keys(credentials)[0]})`, async () => {
        db.row = {
          id: USER_ID,
          email: 'disable-196@test.documenso.com',
          twoFactorBackupCodes: null,
          twoFactorEnabled: false,
          twoFactorSecret: null,
          ...row,
        };

        const before = { ...db.row };

        await expectRefusedAsWrongCode(disableAs(credentials));

        expect(db.row).toEqual(before);
        expect(db.writes).toHaveLength(0);
        expect(db.audits).toHaveLength(0);
      });
    }
  }
});
