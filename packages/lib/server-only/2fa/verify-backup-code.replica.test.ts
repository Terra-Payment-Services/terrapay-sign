import { beforeEach, describe, expect, it, vi } from 'vitest';

import { symmetricDecrypt, symmetricEncrypt } from '../../universal/crypto';

/**
 * Issue #135, Amendment 1: C11 (primary reads), C13 (lifecycle change mid-check), C14 (forced contention).
 *
 * The exported prisma client reads from replicas when NEXT_PRIVATE_DATABASE_REPLICA_URLS is set, and exposes the
 * primary as `prisma.$primary()`. Writes from either client land on the primary. The fake below keeps one primary row
 * and, optionally, a frozen replica row that never catches up, so a decision taken on replica data is visible.
 *
 * Failure modes this file pins:
 *  1. A replica that still lists a spent code makes a fresh code fail (the conditional write never matches).
 *  2. A replica that still lists a spent code makes the spent code pass.
 *  3. A re-read after a lost conditional write goes to the replica, so the retry never converges.
 *  4. 2FA disabled or reset between the read and the conditional write throws instead of refusing.
 *  5. `twoFactorEnabled` turned false with the ciphertext left intact still lets the code pass.
 *  6. Two checks that read the same ciphertext both pass with one code, or one of two different codes is lost.
 *
 * The updateMany fake applies the database predicate: every scalar in `where` must equal the current primary row,
 * otherwise it returns count 0 and changes nothing.
 */

const { TEST_KEY } = vi.hoisted(() => ({ TEST_KEY: 'recovery-code-135-test-key' }));

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

type Gate = { needed: number; waiting: number; isOpen: boolean; open: () => void; promise: Promise<void> };

const db: {
  primary: Row;
  replica: Row | null;
  reads: Array<{ client: 'primary' | 'replica'; ciphertext: string | null }>;
  writes: Array<{ count: number }>;
  beforeWrite: (() => void) | null;
  afterWrite: ((count: number) => void) | null;
  gate: Gate | null;
} = {
  primary: { id: 0, email: '', twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null },
  replica: null,
  reads: [],
  writes: [],
  beforeWrite: null,
  afterWrite: null,
  gate: null,
};

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

const read = (client: 'primary' | 'replica', orThrow: boolean) => {
  return async (args: Args = {}) => {
    const source = client === 'replica' && db.replica ? db.replica : db.primary;
    const snapshot = { ...source };
    const isMatch = matches(snapshot, args.where);

    db.reads.push({ client, ciphertext: snapshot.twoFactorBackupCodes });

    const gate = db.gate;

    if (gate && !gate.isOpen) {
      gate.waiting++;

      if (gate.waiting >= gate.needed) {
        gate.open();
      }

      await gate.promise;
    }

    if (!isMatch) {
      if (orThrow) {
        throw new Error('No User found');
      }

      return null;
    }

    return pick(snapshot, args.select);
  };
};

const updateMany = async (args: Args = {}) => {
  const hook = db.beforeWrite;

  db.beforeWrite = null;

  if (hook) {
    hook();
  }

  // A write releases the gate too, so a check that writes before it reads cannot deadlock the others.
  if (db.gate && !db.gate.isOpen) {
    db.gate.open();
  }

  const isMatch = matches(db.primary, args.where);

  if (isMatch) {
    db.primary = { ...db.primary, ...args.data };
  }

  const count = isMatch ? 1 : 0;

  db.writes.push({ count });

  const after = db.afterWrite;

  db.afterWrite = null;

  if (after) {
    after(count);
  }

  return { count };
};

const userClient = (client: 'primary' | 'replica') => ({
  findUnique: read(client, false),
  findUniqueOrThrow: read(client, true),
  findFirst: read(client, false),
  findFirstOrThrow: read(client, true),
  updateMany,
});

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: userClient('replica'),
    $primary: () => ({ user: userClient('primary') }),
  },
}));

const { verifyBackupCode } = await import('./verify-backup-code');
const { validateTwoFactorAuthentication } = await import('./validate-2fa');

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

const makeRow = (codes: string[] | null, overrides: Partial<Row> = {}): Row => ({
  id: USER_ID,
  email: 'recovery-135@test.documenso.com',
  twoFactorEnabled: true,
  twoFactorSecret: 'encrypted-secret-generation-1',
  twoFactorBackupCodes: codes ? encryptCodes(codes) : null,
  ...overrides,
});

const primaryCodes = () => decryptCodes(db.primary.twoFactorBackupCodes);

const sorted = (codes: string[] | null) => [...(codes ?? [])].sort();

const openGate = (needed: number) => {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  const gate: Gate = {
    needed,
    waiting: 0,
    isOpen: false,
    open: () => {
      gate.isOpen = true;
      open();
    },
    promise,
  };

  db.gate = gate;
};

beforeEach(() => {
  db.primary = makeRow(null);
  db.replica = null;
  db.reads = [];
  db.writes = [];
  db.beforeWrite = null;
  db.afterWrite = null;
  db.gate = null;
});

describe('verifyBackupCode decides on primary data (C11)', () => {
  const codes = makeCodes('A');
  const [spent, fresh, other] = codes;

  it('refuses a code the primary shows spent although the replica still lists it', async () => {
    db.replica = makeRow(codes);
    db.primary = makeRow(codes.filter((code) => code !== spent));

    const primaryBefore = db.primary.twoFactorBackupCodes;

    expect(await verifyBackupCode({ user: db.replica, backupCode: spent })).toBe(false);
    expect(db.primary.twoFactorBackupCodes).toBe(primaryBefore);
  });

  it('passes a fresh code while the replica still shows a spent one, and removes it on the primary', async () => {
    db.replica = makeRow(codes);
    db.primary = makeRow(codes.filter((code) => code !== spent));

    expect(await verifyBackupCode({ user: db.replica, backupCode: fresh })).toBe(true);
    expect(sorted(primaryCodes())).toEqual(sorted(codes.filter((code) => code !== spent && code !== fresh)));
  });

  it('passes a code from a new setup the replica does not show yet, and refuses the old generation', async () => {
    const oldCodes = makeCodes('0');
    const newCodes = makeCodes('N');

    db.replica = makeRow(oldCodes, { twoFactorSecret: 'encrypted-secret-generation-0' });
    db.primary = makeRow(newCodes);

    expect(await verifyBackupCode({ user: db.replica, backupCode: oldCodes[0] })).toBe(false);
    expect(sorted(primaryCodes())).toEqual(sorted(newCodes));

    expect(await verifyBackupCode({ user: db.primary, backupCode: newCodes[0] })).toBe(true);
    expect(sorted(primaryCodes())).toEqual(sorted(newCodes.slice(1)));
  });

  it('passes a code from a new setup while the replica still shows 2FA off with no codes', async () => {
    const newCodes = makeCodes('N');

    db.replica = makeRow(null, { twoFactorEnabled: false, twoFactorSecret: null });
    db.primary = makeRow(newCodes);

    expect(await verifyBackupCode({ user: db.primary, backupCode: newCodes[4] })).toBe(true);
    expect(sorted(primaryCodes())).toEqual(sorted(newCodes.filter((code) => code !== newCodes[4])));
  });

  it('re-reads the primary after a lost conditional write, so a code still unspent passes', async () => {
    db.primary = makeRow(codes);
    db.replica = { ...db.primary };

    // Another request consumes a different code between this check's read and its write.
    db.beforeWrite = () => {
      db.primary = { ...db.primary, twoFactorBackupCodes: encryptCodes(codes.filter((code) => code !== other)) };
    };

    expect(await verifyBackupCode({ user: db.replica, backupCode: fresh })).toBe(true);
    expect(db.writes.some((write) => write.count === 0)).toBe(true);
    expect(sorted(primaryCodes())).toEqual(sorted(codes.filter((code) => code !== other && code !== fresh)));
  });
});

describe('verifyBackupCode refuses when 2FA changes between the read and the write (C13)', () => {
  const codes = makeCodes('L');
  const [codeR] = codes;

  const disabledRow = { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null };

  it('refuses without throwing when 2FA is disabled mid-check (fields as disable-2fa.ts writes them)', async () => {
    db.primary = makeRow(codes);

    const snapshot = { ...db.primary };

    db.beforeWrite = () => {
      db.primary = { ...db.primary, ...disabledRow };
    };

    await expect(verifyBackupCode({ user: snapshot, backupCode: codeR })).resolves.toBe(false);
    expect(db.primary.twoFactorBackupCodes).toBeNull();
    expect(db.primary.twoFactorEnabled).toBe(false);
  });

  it('refuses without throwing when an admin resets 2FA mid-check (same fields as disable, reset-two-factor-authentication.ts)', async () => {
    db.primary = makeRow(codes);

    const snapshot = { ...db.primary };

    db.beforeWrite = () => {
      db.primary = { ...db.primary, ...disabledRow };
    };

    await expect(verifyBackupCode({ user: snapshot, backupCode: codes[5] })).resolves.toBe(false);
    expect(db.primary.twoFactorBackupCodes).toBeNull();
  });

  it('refuses when twoFactorEnabled turns false mid-check and the ciphertext is left intact', async () => {
    db.primary = makeRow(codes);

    const snapshot = { ...db.primary };
    const ciphertext = db.primary.twoFactorBackupCodes;

    db.beforeWrite = () => {
      db.primary = { ...db.primary, twoFactorEnabled: false };
    };

    await expect(verifyBackupCode({ user: snapshot, backupCode: codeR })).resolves.toBe(false);
    expect(db.primary.twoFactorBackupCodes).toBe(ciphertext);
  });

  it('refuses a code of the replaced list when a new setup lands mid-check, and leaves the new list alone', async () => {
    const newCodes = makeCodes('M');

    db.primary = makeRow(codes);

    const snapshot = { ...db.primary };
    const replacement = encryptCodes(newCodes);

    db.beforeWrite = () => {
      db.primary = {
        ...db.primary,
        twoFactorSecret: 'encrypted-secret-generation-2',
        twoFactorBackupCodes: replacement,
      };
    };

    await expect(verifyBackupCode({ user: snapshot, backupCode: codeR })).resolves.toBe(false);
    expect(db.primary.twoFactorBackupCodes).toBe(replacement);
  });

  it('answers false at the sign-in check (validateTwoFactorAuthentication) when 2FA is disabled mid-check', async () => {
    db.primary = makeRow(codes);

    const snapshot = { ...db.primary };

    db.beforeWrite = () => {
      db.primary = { ...db.primary, ...disabledRow };
    };

    await expect(validateTwoFactorAuthentication({ user: snapshot, backupCode: codeR })).resolves.toBe(false);
  });
});

describe('verifyBackupCode under forced contention (C14)', () => {
  const codes = makeCodes('C');
  const [codeR, codeR2] = codes;

  for (const parallel of [2, 8]) {
    it(`${parallel} checks of the same code that all read one ciphertext: exactly one passes`, async () => {
      db.primary = makeRow(codes);

      const snapshot = { ...db.primary };

      openGate(parallel);

      const results = await Promise.all(
        Array.from({ length: parallel }, async () => await verifyBackupCode({ user: snapshot, backupCode: codeR })),
      );

      expect(db.reads.length).toBeGreaterThanOrEqual(parallel);
      expect(new Set(db.reads.slice(0, parallel).map((entry) => entry.ciphertext)).size).toBe(1);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(sorted(primaryCodes())).toEqual(sorted(codes.filter((code) => code !== codeR)));
    });
  }

  it('two checks of different codes that both read one ciphertext: both pass and the list loses both', async () => {
    db.primary = makeRow(codes);

    const snapshot = { ...db.primary };

    openGate(2);

    const results = await Promise.all([
      verifyBackupCode({ user: snapshot, backupCode: codeR }),
      verifyBackupCode({ user: snapshot, backupCode: codeR2 }),
    ]);

    expect(new Set(db.reads.slice(0, 2).map((entry) => entry.ciphertext)).size).toBe(1);
    expect(db.writes.some((write) => write.count === 0)).toBe(true);
    expect(results).toEqual([true, true]);
    expect(sorted(primaryCodes())).toEqual(sorted(codes.filter((code) => code !== codeR && code !== codeR2)));
  });
});
