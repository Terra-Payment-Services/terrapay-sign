import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #196: a disable authorised against one setup must not clear a setup enabled after it.
 *
 * validateTwoFactorAuthentication is replaced by a stub that runs a hook while "validating", so the row can change
 * between the check and the write, which HTTP cannot schedule.
 *
 * The database fake keeps the primary's state in `db` and applies the `where` of every write against the row as it is
 * at write time, as the database does. Three clients sit on top of it, as in the real client stack:
 *  - the root client (`prisma`, replica-or-root): writes go to the primary at once and are never rolled back with a
 *    transaction; reads return `db.replicaRow` when set (a lagging replica), else the primary row;
 *  - the primary client (`primaryClient()`): reads and writes the primary;
 *  - the transaction client handed to a `$transaction` callback: writes land on the primary and are logged, and when
 *    the callback throws, only the fields and audit rows that transaction wrote are undone.
 *
 * Failure modes this file pins:
 *  1. The clearing write is keyed on `id` only, so it erases a newer setup.
 *  2. The clearing write is keyed on `twoFactorEnabled` only, so a re-enabled row still matches.
 *  3. The audit row is written although the clearing write matched nothing.
 *  4. A clearing write that matched nothing is reported as success.
 *  5. The code is validated against, and the write pinned to, the caller's possibly stale row (C8).
 *  6. The clearing write or audit row bypasses the transaction, so a failed audit write leaves 2FA cleared (C10).
 *  7. The audit row is written outside the transaction, so a failure after it leaves the row but not the clearing
 *     write, or the clearing write but not the row (C12).
 */

const { TEST_KEY } = vi.hoisted(() => ({ TEST_KEY: 'disable-2fa-196-test-key' }));

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

type Args = { where?: Record<string, unknown>; data?: Record<string, unknown> };

type Write = { method: 'update' | 'updateMany'; where: Record<string, unknown>; data: Record<string, unknown> };

type ValidateArgs = { user: Row; totpCode?: string; backupCode?: string };

type Undo = { restoreFields: Partial<Row> } | { removeAudit: Record<string, unknown> };

const db: {
  row: Row;
  replicaRow: Row | null;
  audits: Array<Record<string, unknown>>;
  writes: Write[];
  onValidate: (() => void) | null;
  validation: boolean;
  validator: ((args: ValidateArgs) => boolean) | null;
  auditFails: boolean;
  commitFails: boolean;
} = {
  row: { id: 0, email: '', twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null },
  replicaRow: null,
  audits: [],
  writes: [],
  onValidate: null,
  validation: true,
  validator: null,
  auditFails: false,
  commitFails: false,
};

const matches = (row: Row, where: Record<string, unknown> = {}) => {
  return Object.entries(where).every(([field, value]) => {
    const expected = value !== null && typeof value === 'object' && 'equals' in value ? value.equals : value;

    return row[field as keyof Row] === expected;
  });
};

/**
 * A client whose reads come from `readRow` and whose writes land on the primary. With an `undoLog` the writes are
 * recorded so the owning transaction can undo exactly what it wrote.
 */
const makeClient = (readRow: () => Row, undoLog: Undo[] | null) => {
  const applyData = (data: Record<string, unknown>) => {
    if (undoLog) {
      const restoreFields: Record<string, unknown> = {};

      for (const field of Object.keys(data)) {
        restoreFields[field] = db.row[field as keyof Row];
      }

      undoLog.push({ restoreFields: restoreFields as Partial<Row> });
    }

    db.row = { ...db.row, ...data };
  };

  return {
    user: {
      updateMany: async ({ where = {}, data = {} }: Args) => {
        const isMatch = matches(db.row, where);

        db.writes.push({ method: 'updateMany', where, data });

        if (isMatch) {
          applyData(data);
        }

        return { count: isMatch ? 1 : 0 };
      },
      update: async ({ where = {}, data = {} }: Args) => {
        db.writes.push({ method: 'update', where, data });

        if (!matches(db.row, where)) {
          throw new Error('Record to update not found');
        }

        applyData(data);

        return { ...db.row };
      },
      findUnique: async () => ({ ...readRow() }),
      findUniqueOrThrow: async () => ({ ...readRow() }),
      findFirst: async () => ({ ...readRow() }),
    },
    userSecurityAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (db.auditFails) {
          throw new Error('audit write failed');
        }

        db.audits.push(data);
        undoLog?.push({ removeAudit: data });

        return data;
      },
    },
  };
};

const rollBack = (undoLog: Undo[]) => {
  for (const undo of [...undoLog].reverse()) {
    if ('restoreFields' in undo) {
      db.row = { ...db.row, ...undo.restoreFields };
    } else {
      db.audits = db.audits.filter((audit) => audit !== undo.removeAudit);
    }
  }
};

const primaryReads = makeClient(() => db.row, null);

const rootClient = {
  ...makeClient(() => db.replicaRow ?? db.row, null),
  $primary: () => primaryReads,
  $transaction: async (work: unknown) => {
    if (typeof work !== 'function') {
      return await Promise.all(work as Array<Promise<unknown>>);
    }

    const undoLog: Undo[] = [];

    try {
      const result = await work(makeClient(() => db.row, undoLog));

      // A failure at commit, after the callback returned and every write in it succeeded.
      if (db.commitFails) {
        throw new Error('commit failed');
      }

      return result;
    } catch (error) {
      rollBack(undoLog);

      throw error;
    }
  },
};

vi.mock('@documenso/prisma', () => ({ prisma: rootClient }));

vi.mock('../database/primary-client', () => ({
  primaryClient: () => ({ ...primaryReads, $transaction: rootClient.$transaction }),
}));

vi.mock('./validate-2fa', () => ({
  validateTwoFactorAuthentication: async (args: ValidateArgs) => {
    const hook = db.onValidate;

    db.onValidate = null;

    if (hook) {
      hook();
    }

    return db.validator ? db.validator(args) : db.validation;
  },
}));

const { disableTwoFactorAuthentication } = await import('./disable-2fa');

const USER_ID = 196;

const GENERATION_A = { secret: 'encrypted-secret-A', codes: 'encrypted-codes-A' };
const GENERATION_B = { secret: 'encrypted-secret-B', codes: 'encrypted-codes-B' };

const makeRow = (generation: { secret: string; codes: string }, twoFactorEnabled = true): Row => ({
  id: USER_ID,
  email: 'disable-196@test.documenso.com',
  twoFactorEnabled,
  twoFactorSecret: generation.secret,
  twoFactorBackupCodes: generation.codes,
});

const DISABLED = { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null };

const disableAs = async (snapshot: Row, credentials: { totpCode?: string; backupCode?: string }) => {
  return await disableTwoFactorAuthentication({
    user: snapshot,
    ...credentials,
    requestMetadata: { ipAddress: '10.0.0.1', userAgent: 'vitest' } as never,
  });
};

const disableAuditRows = () => db.audits.filter((audit) => audit.type === 'AUTH_2FA_DISABLE');

const expectRefused = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({ code: 'INCORRECT_TWO_FACTOR_CODE' });
};

beforeEach(() => {
  db.row = makeRow(GENERATION_A);
  db.audits = [];
  db.writes = [];
  db.onValidate = null;
  db.validation = true;
  db.replicaRow = null;
  db.validator = null;
  db.auditFails = false;
  db.commitFails = false;
});

describe('disableTwoFactorAuthentication, uncontended', () => {
  it('clears the setup it validated and writes one audit row', async () => {
    await disableAs({ ...db.row }, { totpCode: '123456' });

    expect(db.row).toMatchObject(DISABLED);
    expect(disableAuditRows()).toHaveLength(1);
    expect(disableAuditRows()[0]).toMatchObject({ userId: USER_ID });
  });

  it('refuses a code that does not validate and changes nothing', async () => {
    db.validation = false;

    const before = { ...db.row };

    await expectRefused(disableAs({ ...db.row }, { totpCode: '000000' }));

    expect(db.row).toEqual(before);
    expect(db.audits).toHaveLength(0);
  });
});

describe('the clearing write is conditional on the validated setup (C2)', () => {
  it('pins the id, twoFactorEnabled true and the secret that validated', async () => {
    await disableAs({ ...db.row }, { totpCode: '123456' });

    const clearing = db.writes.filter((write) => write.data.twoFactorEnabled === false);

    expect(clearing).toHaveLength(1);
    expect(clearing[0].where).toMatchObject({
      id: USER_ID,
      twoFactorEnabled: true,
      twoFactorSecret: GENERATION_A.secret,
    });
  });

  it('writes nothing, writes no audit row and refuses when a new setup is enabled mid-validation', async () => {
    const snapshot = { ...db.row };

    db.onValidate = () => {
      db.row = makeRow(GENERATION_B);
    };

    await expectRefused(disableAs(snapshot, { totpCode: '123456' }));

    expect(db.row).toEqual(makeRow(GENERATION_B));
    expect(disableAuditRows()).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it('refuses when the setup was replaced through disable, setup and enable in between', async () => {
    const snapshot = { ...db.row };

    db.onValidate = () => {
      db.row = { ...db.row, ...DISABLED };
      db.row = { ...db.row, twoFactorSecret: GENERATION_B.secret, twoFactorBackupCodes: GENERATION_B.codes };
      db.row = { ...db.row, twoFactorEnabled: true };
    };

    await expectRefused(disableAs(snapshot, { totpCode: '123456' }));

    expect(db.row.twoFactorEnabled).toBe(true);
    expect(db.row.twoFactorSecret).toBe(GENERATION_B.secret);
    expect(db.row.twoFactorBackupCodes).toBe(GENERATION_B.codes);
    expect(db.audits).toHaveLength(0);
  });

  it('refuses when only the secret changed and 2FA stayed on', async () => {
    const snapshot = { ...db.row };

    db.onValidate = () => {
      db.row = { ...db.row, twoFactorSecret: GENERATION_B.secret };
    };

    await expectRefused(disableAs(snapshot, { totpCode: '123456' }));

    expect(db.row.twoFactorEnabled).toBe(true);
    expect(db.row.twoFactorSecret).toBe(GENERATION_B.secret);
    expect(db.audits).toHaveLength(0);
  });
});

describe('already disabled in between (C3)', () => {
  it('writes nothing, writes no audit row and refuses rather than reporting a fresh disable', async () => {
    const snapshot = { ...db.row };

    db.onValidate = () => {
      db.row = { ...db.row, ...DISABLED };
    };

    await expectRefused(disableAs(snapshot, { totpCode: '123456' }));

    expect(db.row).toMatchObject(DISABLED);
    expect(db.audits).toHaveLength(0);
  });

  it('refuses when twoFactorEnabled turned false and the secret is left intact', async () => {
    const snapshot = { ...db.row };

    db.onValidate = () => {
      db.row = { ...db.row, twoFactorEnabled: false };
    };

    await expectRefused(disableAs(snapshot, { totpCode: '123456' }));

    expect(db.row.twoFactorSecret).toBe(GENERATION_A.secret);
    expect(db.audits).toHaveLength(0);
  });
});

describe('recovery-code path (C6)', () => {
  it('leaves a new setup intact when the write for a validated recovery code is refused', async () => {
    const snapshot = { ...db.row };

    // Validation consumes a code from the old list, then another request replaces the setup.
    db.onValidate = () => {
      db.row = { ...db.row, twoFactorBackupCodes: 'encrypted-codes-A-minus-one' };
      db.row = makeRow(GENERATION_B);
    };

    await expectRefused(disableAs(snapshot, { backupCode: 'AAAAA-BBBBB' }));

    expect(db.row).toEqual(makeRow(GENERATION_B));
    expect(db.audits).toHaveLength(0);
  });

  it('refuses when the recovery code was validated and 2FA was then disabled', async () => {
    const snapshot = { ...db.row };

    db.onValidate = () => {
      db.row = { ...db.row, ...DISABLED };
    };

    await expectRefused(disableAs(snapshot, { backupCode: 'AAAAA-BBBBB' }));

    expect(db.row).toMatchObject(DISABLED);
    expect(db.audits).toHaveLength(0);
  });

  it('clears the setup and writes one audit row when a recovery code validates and nothing changed', async () => {
    await disableAs({ ...db.row }, { backupCode: 'AAAAA-BBBBB' });

    expect(db.row).toMatchObject(DISABLED);
    expect(disableAuditRows()).toHaveLength(1);
  });
});

describe('the row is read from the primary, not taken from the caller (C8)', () => {
  const OWNERS: Record<string, string> = {
    'totp-A': GENERATION_A.secret,
    'totp-B': GENERATION_B.secret,
    'AAAAA-AAAAA': GENERATION_A.secret,
    'BBBBB-BBBBB': GENERATION_B.secret,
  };

  // Accepts a code only when the user it is checked against holds the secret the code belongs to.
  const acceptsOwnSecretOnly = ({ user, totpCode, backupCode }: ValidateArgs) => {
    return OWNERS[totpCode ?? backupCode ?? ''] === user.twoFactorSecret;
  };

  // The primary holds B, a lagging replica and the caller's snapshot still describe A.
  const primaryHoldsB = () => {
    const stale = makeRow(GENERATION_A);

    db.row = makeRow(GENERATION_B);
    db.replicaRow = stale;
    db.validator = acceptsOwnSecretOnly;

    return stale;
  };

  it('disables B with a valid TOTP code of B and writes one audit row', async () => {
    const stale = primaryHoldsB();

    await disableAs(stale, { totpCode: 'totp-B' });

    expect(db.row).toMatchObject(DISABLED);
    expect(disableAuditRows()).toHaveLength(1);
  });

  it('disables B with an unused recovery code of B and writes one audit row', async () => {
    const stale = primaryHoldsB();

    await disableAs(stale, { backupCode: 'BBBBB-BBBBB' });

    expect(db.row).toMatchObject(DISABLED);
    expect(disableAuditRows()).toHaveLength(1);
  });

  it('pins the clearing write to the primary secret', async () => {
    const stale = primaryHoldsB();

    await disableAs(stale, { totpCode: 'totp-B' });

    const clearing = db.writes.filter((write) => write.data.twoFactorEnabled === false);

    expect(clearing).toHaveLength(1);
    expect(clearing[0].where).toMatchObject({
      id: USER_ID,
      twoFactorEnabled: true,
      twoFactorSecret: GENERATION_B.secret,
    });
  });

  it('refuses a TOTP code that is valid only for A and leaves B untouched', async () => {
    const stale = primaryHoldsB();

    await expectRefused(disableAs(stale, { totpCode: 'totp-A' }));

    expect(db.row).toEqual(makeRow(GENERATION_B));
    expect(db.writes).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it('refuses a recovery code that is valid only for A and leaves B untouched', async () => {
    const stale = primaryHoldsB();

    await expectRefused(disableAs(stale, { backupCode: 'AAAAA-AAAAA' }));

    expect(db.row).toEqual(makeRow(GENERATION_B));
    expect(db.writes).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });
});

describe('the fake keeps root and transaction state apart (C10)', () => {
  it('keeps a root-client write made inside a transaction callback when the transaction rolls back', async () => {
    await expect(
      rootClient.$transaction(async (tx: typeof rootClient) => {
        await tx.user.update({ where: { id: USER_ID }, data: { twoFactorBackupCodes: 'written-in-transaction' } });
        await rootClient.user.update({ where: { id: USER_ID }, data: { email: 'root-write@test.documenso.com' } });

        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    expect(db.row.email).toBe('root-write@test.documenso.com');
    expect(db.row.twoFactorBackupCodes).toBe(GENERATION_A.codes);
  });

  it('rolls the clearing write back when the audit write fails after it matched', async () => {
    db.auditFails = true;

    await expect(disableAs({ ...db.row }, { totpCode: '123456' })).rejects.toThrow();

    expect(db.writes.some((write) => write.data.twoFactorEnabled === false)).toBe(true);
    expect(db.row).toEqual(makeRow(GENERATION_A));
    expect(db.audits).toHaveLength(0);
  });

  it('leaves neither the clearing write nor the audit row when the transaction fails at commit (C12)', async () => {
    db.commitFails = true;

    await expect(disableAs({ ...db.row }, { totpCode: '123456' })).rejects.toThrow();

    expect(db.writes.some((write) => write.data.twoFactorEnabled === false)).toBe(true);
    expect(db.audits).toHaveLength(0);
    expect(db.row).toEqual(makeRow(GENERATION_A));
  });

  it('disables when validation rewrote only the recovery-code list before the clearing write', async () => {
    const snapshot = { ...db.row };

    // As #135's consumption does: the list changes, the secret and the enabled flag do not.
    db.onValidate = () => {
      db.row = { ...db.row, twoFactorBackupCodes: 'encrypted-codes-A-minus-one' };
    };

    await disableAs(snapshot, { backupCode: 'AAAAA-BBBBB' });

    expect(db.row).toMatchObject(DISABLED);
    expect(disableAuditRows()).toHaveLength(1);
  });
});
