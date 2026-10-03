import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A signing link does not stop working once it has been used. A recipient can
 * sign, close the tab, reopen the same link a week later and still be shown a
 * reject button. Before the guard below, taking it deleted their signature row
 * and overwrote `signedAt` with the time of the rejection, so a contract that
 * had been signed at a provable moment came out of the archive claiming it was
 * rejected at some later one. These tests aim at exactly that path.
 */

const findFirst = vi.fn();
const update = vi.fn();
const auditLogCreate = vi.fn();
const triggerJob = vi.fn();
const userFindFirst = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: {
      findFirst: async (...args: unknown[]) => await findFirst(...args),
      update: async (...args: unknown[]) => await update(...args),
    },
    user: {
      findFirst: async (...args: unknown[]) => await userFindFirst(...args),
    },
    documentAuditLog: {
      create: async (...args: unknown[]) => await auditLogCreate(...args),
    },
    $transaction: async (operations: Promise<unknown>[]) => await Promise.all(operations),
  },
}));

vi.mock('@documenso/lib/jobs/client', () => ({
  jobs: {
    triggerJob: async (...args: unknown[]) => await triggerJob(...args),
  },
}));

const { rejectDocumentWithToken } = await import('./reject-document-with-token');

const recipient = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  name: 'Counterparty',
  email: 'counterparty@example.com',
  role: 'SIGNER',
  token: 'token-42',
  signingStatus: 'NOT_SIGNED',
  signedAt: null,
  expiresAt: null,
  rejectionReason: null,
  envelope: {
    id: 'envelope_abc123',
    status: 'PENDING',
    secondaryId: 'document_7',
  },
  ...overrides,
});

const reject = async (userId?: number, isAccess2FAVerified?: boolean) =>
  await rejectDocumentWithToken({
    token: 'token-42',
    id: { type: 'envelopeId', id: 'envelope_abc123' },
    reason: 'Changed my mind',
    userId,
    isAccess2FAVerified,
  });

describe('rejectDocumentWithToken', () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    auditLogCreate.mockReset();
    triggerJob.mockReset();
    userFindFirst.mockReset();

    update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 42, ...data }));
    auditLogCreate.mockResolvedValue({});
    triggerJob.mockResolvedValue(undefined);
  });

  it('rejects for a recipient who has not signed', async () => {
    findFirst.mockResolvedValue(recipient());

    const result = await reject();

    expect(result.signingStatus).toBe('REJECTED');
    expect(update).toHaveBeenCalledOnce();
  });

  it('refuses a rejection from a recipient who has already signed', async () => {
    const signedAt = new Date('2026-03-01T09:00:00.000Z');

    findFirst.mockResolvedValue(recipient({ signingStatus: 'SIGNED', signedAt }));

    await expect(reject()).rejects.toThrow(/already actioned/);
  });

  it('leaves the signature and the original signing time untouched when it refuses', async () => {
    findFirst.mockResolvedValue(recipient({ signingStatus: 'SIGNED', signedAt: new Date('2026-03-01T09:00:00.000Z') }));

    await expect(reject()).rejects.toThrow();

    // No write of any kind. `signedAt` keeps its value, the signature row is
    // never cascaded away, and nothing tells the world the document was
    // rejected.
    expect(update).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
    expect(triggerJob).not.toHaveBeenCalled();
  });

  it('refuses a second rejection from a recipient who has already rejected', async () => {
    findFirst.mockResolvedValue(recipient({ signingStatus: 'REJECTED', rejectionReason: 'First reason' }));

    await expect(reject()).rejects.toThrow(/already actioned/);
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * "Require account" was checked only when the signing page loaded. Anyone
 * holding a forwarded signing link could call the reject mutation directly and
 * reject on the recipient's behalf without ever signing in.
 */
describe('rejectDocumentWithToken with account access auth', () => {
  const accountRecipient = () => recipient({ authOptions: { accessAuth: ['ACCOUNT'], actionAuth: [] } });

  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    auditLogCreate.mockReset();
    triggerJob.mockReset();
    userFindFirst.mockReset();

    update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 42, ...data }));
    auditLogCreate.mockResolvedValue({});
    triggerJob.mockResolvedValue(undefined);
    userFindFirst.mockResolvedValue({ id: 7 });
    findFirst.mockResolvedValue(accountRecipient());
  });

  it('refuses a caller who is not signed in, and writes nothing', async () => {
    await expect(reject()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(update).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
    expect(triggerJob).not.toHaveBeenCalled();
  });

  it('refuses a caller signed in as someone other than the recipient', async () => {
    await expect(reject(8)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(update).not.toHaveBeenCalled();
  });

  it('rejects for the recipient signed in to their own account', async () => {
    const result = await reject(7);

    expect(result.signingStatus).toBe('REJECTED');
  });
});

/**
 * A recipient whose access auth is an emailed code was never asked for it
 * before rejecting, so anyone with the link could reject for them.
 */
describe('rejectDocumentWithToken with an emailed access code', () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    auditLogCreate.mockReset();
    triggerJob.mockReset();

    update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 42, ...data }));
    auditLogCreate.mockResolvedValue({});
    triggerJob.mockResolvedValue(undefined);
    findFirst.mockResolvedValue(recipient({ authOptions: { accessAuth: ['TWO_FACTOR_AUTH'], actionAuth: [] } }));
  });

  it('refuses a caller who has not entered the code, and writes nothing', async () => {
    await expect(reject(undefined, false)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(update).not.toHaveBeenCalled();
  });

  it('rejects once the code has been entered', async () => {
    const result = await reject(undefined, true);

    expect(result.signingStatus).toBe('REJECTED');
  });
});
