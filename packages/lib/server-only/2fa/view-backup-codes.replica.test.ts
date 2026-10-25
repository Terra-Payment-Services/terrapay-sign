import { beforeEach, describe, expect, it, vi } from 'vitest';

import { symmetricDecrypt, symmetricEncrypt } from '../../universal/crypto';

/**
 * Issue #135, Amendment 1: C12, viewing codes is bound to what was authenticated.
 *
 * With a recovery code R, the view returns the list the consuming write produced (the generation R was checked
 * against), without re-reading the row by user id. With a TOTP code, it returns the list from the snapshot whose
 * secret validated the TOTP. If 2FA is disabled, reset or replaced after authentication, the view never returns the
 * new setup's codes.
 *
 * Failure modes this file pins:
 *  1. After R is consumed, a new setup commits and the view re-reads the row, handing out the new setup's codes.
 *  2. After R is consumed, 2FA is disabled and the view re-reads the row and throws instead of returning the list.
 *  3. A TOTP for the old secret authorises the view, and the view returns a new setup's codes.
 *  4. A fix that always refuses: the no-change controls require the view to return the right list.
 *
 * TOTP validation is mocked: it answers true only for TOTP_TOKEN checked against the generation-1 secret.
 */

const { TEST_KEY, TOTP_TOKEN, SECRET_1, SECRET_2 } = vi.hoisted(() => ({
  TEST_KEY: 'recovery-code-135-test-key',
  TOTP_TOKEN: '135135',
  SECRET_1: 'encrypted-secret-generation-1',
  SECRET_2: 'encrypted-secret-generation-2',
}));

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

type Args = { where?: Record<string, unknown>; select?: Record<string, boolean>; data?: Partial<Row> };

const db: {
  primary: Row;
  afterWrite: ((count: number) => void) | null;
  afterTotp: (() => void) | null;
} = {
  primary: { id: 0, email: '', twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null },
  afterWrite: null,
  afterTotp: null,
};

vi.mock('./verify-2fa-token', () => ({
  verifyTwoFactorAuthenticationToken: async ({
    user,
    totpCode,
  }: {
    user: { twoFactorSecret: string | null };
    totpCode: string;
  }) => {
    const isValid = totpCode === TOTP_TOKEN && user.twoFactorSecret === SECRET_1;
    const hook = db.afterTotp;

    db.afterTotp = null;

    if (isValid && hook) {
      hook();
    }

    return isValid;
  },
}));

const matches = (row: Row, where: Record<string, unknown> = {}) => {
  return Object.entries(where).every(([field, value]) => {
    const expected = value !== null && typeof value === 'object' && 'equals' in value ? value.equals : value;

    return row[field as keyof Row] === expected;
  });
};

const pick = (row: Row, select?: Record<string, boolean>) => {
  if (!select) {
    return { ...row };
  }

  return Object.fromEntries(Object.keys(select).map((field) => [field, row[field as keyof Row]]));
};

const read = (orThrow: boolean) => {
  return async (args: Args = {}) => {
    const snapshot = { ...db.primary };

    if (!matches(snapshot, args.where)) {
      if (orThrow) {
        throw new Error('No User found');
      }

      return null;
    }

    return pick(snapshot, args.select);
  };
};

const updateMany = async (args: Args = {}) => {
  const isMatch = matches(db.primary, args.where);

  if (isMatch) {
    db.primary = { ...db.primary, ...args.data };
  }

  const count = isMatch ? 1 : 0;
  const hook = db.afterWrite;

  db.afterWrite = null;

  if (hook) {
    hook(count);
  }

  return { count };
};

// No replica lag here: both clients serve the primary row, so only the binding is under test.
const userClient = () => ({
  findUnique: read(false),
  findUniqueOrThrow: read(true),
  findFirst: read(false),
  findFirstOrThrow: read(true),
  updateMany,
});

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: userClient(),
    $primary: () => ({ user: userClient() }),
  },
}));

const { viewBackupCodes } = await import('./view-backup-codes');
const { AppError, AppErrorCode } = await import('../../errors/app-error');

const USER_ID = 135;

const encryptCodes = (codes: string[]) => symmetricEncrypt({ key: TEST_KEY, data: JSON.stringify(codes) });

const decryptCodes = (ciphertext: string | null) => {
  if (!ciphertext) {
    return null;
  }

  return JSON.parse(Buffer.from(symmetricDecrypt({ key: TEST_KEY, data: ciphertext })).toString('utf-8')) as string[];
};

const makeCodes = (prefix: string) => {
  return Array.from({ length: 10 }, (_, index) => `${prefix}${index}AAA-BBBBB`);
};

const makeRow = (codes: string[] | null, secret: string | null): Row => ({
  id: USER_ID,
  email: 'recovery-135@test.documenso.com',
  twoFactorEnabled: true,
  twoFactorSecret: secret,
  twoFactorBackupCodes: codes ? encryptCodes(codes) : null,
});

const sorted = (codes: string[] | null) => [...(codes ?? [])].sort();

const generation1 = makeCodes('G');
const generation2 = makeCodes('H');
const [codeR] = generation1;

const replaceWithNewSetup = () => {
  db.primary = makeRow(generation2, SECRET_2);
};

const disable = () => {
  db.primary = { ...db.primary, twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null };
};

const view = async (token: string, user: Row) => {
  return await viewBackupCodes({ token, user }).then(
    (codes) => ({ codes, error: null }),
    (error: unknown) => ({ codes: null, error }),
  );
};

/**
 * The TOTP view may return the validating snapshot's list or refuse as a wrong code would. It must never return the
 * new setup's list.
 */
const expectSnapshotListOrRefusal = (outcome: { codes: string[] | null; error: unknown }) => {
  if (outcome.codes) {
    expect(outcome.codes.some((code) => generation2.includes(code))).toBe(false);
    expect(sorted(outcome.codes)).toEqual(sorted(generation1));

    return;
  }

  expect(AppError.parseError(outcome.error).code).toBe(AppErrorCode.INCORRECT_TWO_FACTOR_CODE);
};

beforeEach(() => {
  db.primary = makeRow(generation1, SECRET_1);
  db.afterWrite = null;
  db.afterTotp = null;
});

describe('viewBackupCodes with a recovery code returns the consumed generation (C12)', () => {
  it('control: returns generation 1 without R when nothing changes', async () => {
    const outcome = await view(codeR, { ...db.primary });

    expect(outcome.error).toBeNull();
    expect(sorted(outcome.codes)).toEqual(sorted(generation1.filter((code) => code !== codeR)));
  });

  it('returns generation 1 without R when a new setup commits right after the consuming write', async () => {
    const snapshot = { ...db.primary };

    db.afterWrite = (count) => {
      if (count === 1) {
        replaceWithNewSetup();
      }
    };

    const outcome = await view(codeR, snapshot);

    expect(outcome.error).toBeNull();
    expect(outcome.codes?.some((code) => generation2.includes(code))).toBe(false);
    expect(sorted(outcome.codes)).toEqual(sorted(generation1.filter((code) => code !== codeR)));
    expect(sorted(decryptCodes(db.primary.twoFactorBackupCodes))).toEqual(sorted(generation2));
  });

  it('returns generation 1 without R, without throwing, when 2FA is disabled right after the consuming write', async () => {
    const snapshot = { ...db.primary };

    db.afterWrite = (count) => {
      if (count === 1) {
        disable();
      }
    };

    const outcome = await view(codeR, snapshot);

    expect(outcome.error).toBeNull();
    expect(sorted(outcome.codes)).toEqual(sorted(generation1.filter((code) => code !== codeR)));
  });
});

describe('viewBackupCodes with a TOTP code is bound to the validating snapshot (C12)', () => {
  it('control: returns generation 1 unchanged when nothing changes', async () => {
    const ciphertext = db.primary.twoFactorBackupCodes;
    const outcome = await view(TOTP_TOKEN, { ...db.primary });

    expect(outcome.error).toBeNull();
    expect(sorted(outcome.codes)).toEqual(sorted(generation1));
    expect(db.primary.twoFactorBackupCodes).toBe(ciphertext);
  });

  it('never returns the new setup list when the row was replaced before the view began', async () => {
    const snapshot = { ...db.primary };

    replaceWithNewSetup();

    expectSnapshotListOrRefusal(await view(TOTP_TOKEN, snapshot));
  });

  it('never returns the new setup list when the row is replaced while the TOTP is being checked', async () => {
    const snapshot = { ...db.primary };

    db.afterTotp = replaceWithNewSetup;

    expectSnapshotListOrRefusal(await view(TOTP_TOKEN, snapshot));
  });

  it('does not throw an unexpected error when 2FA is disabled while the TOTP is being checked', async () => {
    const snapshot = { ...db.primary };

    db.afterTotp = disable;

    expectSnapshotListOrRefusal(await view(TOTP_TOKEN, snapshot));
  });
});
