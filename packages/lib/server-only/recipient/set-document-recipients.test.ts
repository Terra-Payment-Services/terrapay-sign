import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `setDocumentRecipients` takes the whole recipient list and treats anyone
 * missing from it as removed. The removal is a `deleteMany`, and both
 * `Field.recipientId` and `Signature.recipientId` cascade, so a signed
 * recipient left out of the array loses their signature rows while the audit
 * log keeps saying they signed. The only status gate was `completedAt`, which a
 * part-signed PENDING envelope sails past. These tests drop a signed recipient
 * from the array and watch what reaches the database.
 */

const envelopeFindFirst = vi.fn();
const recipientDeleteMany = vi.fn();
const recipientUpsert = vi.fn();
const fieldDeleteMany = vi.fn();

const transactionClient = {
  envelope: {
    findFirstOrThrow: async () => ({ signatureLevel: 'SES', status: 'PENDING' }),
  },
  recipient: {
    upsert: async (...args: unknown[]) => await recipientUpsert(...args),
    deleteMany: async (...args: unknown[]) => await recipientDeleteMany(...args),
  },
  field: {
    deleteMany: async (...args: unknown[]) => await fieldDeleteMany(...args),
  },
  documentAuditLog: {
    create: async () => ({}),
    createMany: async () => ({}),
  },
};

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: async (...args: unknown[]) => await envelopeFindFirst(...args),
    },
    user: {
      findFirstOrThrow: async () => ({ id: 9, name: 'Owner', email: 'owner@example.com' }),
    },
    $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      await callback(transactionClient),
  },
}));

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: async () => ({ envelopeWhereInput: {} }),
}));

vi.mock('../../jobs/client', () => ({
  jobs: {
    triggerJob: async () => undefined,
  },
}));

const { setDocumentRecipients } = await import('./set-document-recipients');

const signer = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  envelopeId: 'envelope_abc123',
  email: `signer-${id}@example.com`,
  name: `Signer ${id}`,
  role: 'SIGNER',
  signingOrder: id,
  token: `token-${id}`,
  signingStatus: 'NOT_SIGNED',
  sendStatus: 'SENT',
  authOptions: null,
  expiresAt: null,
  ...overrides,
});

const envelope = (recipients: ReturnType<typeof signer>[], fields: Record<string, unknown>[] = []) => ({
  id: 'envelope_abc123',
  secondaryId: 'document_7',
  signatureLevel: 'SES',
  status: 'PENDING',
  completedAt: null,
  documentMeta: { emailSettings: null },
  team: { organisation: { organisationClaim: { flags: { cfr21: false } } } },
  recipients,
  fields,
});

const asInput = (recipient: ReturnType<typeof signer>) => ({
  id: recipient.id,
  email: recipient.email,
  name: recipient.name,
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  role: recipient.role as never,
  signingOrder: recipient.signingOrder,
});

const setRecipients = async (recipients: ReturnType<typeof signer>[]) =>
  await setDocumentRecipients({
    userId: 9,
    teamId: 1,
    id: { type: 'envelopeId', id: 'envelope_abc123' },
    recipients: recipients.map(asInput),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    requestMetadata: { requestMetadata: {}, source: 'app', auth: null, auditUser: {} } as never,
  });

describe('setDocumentRecipients', () => {
  beforeEach(() => {
    envelopeFindFirst.mockReset();
    recipientDeleteMany.mockReset();
    recipientUpsert.mockReset();
    fieldDeleteMany.mockReset();

    recipientUpsert.mockImplementation(async ({ where, update }: { where: { id: number }; update: object }) => ({
      ...signer(where.id),
      ...update,
      id: where.id,
    }));
    recipientDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('removes a recipient who has not touched the document', async () => {
    const keep = signer(1);
    const drop = signer(2);

    envelopeFindFirst.mockResolvedValue(envelope([keep, drop]));

    await setRecipients([keep]);

    expect(recipientDeleteMany).toHaveBeenCalledOnce();
    expect(recipientDeleteMany.mock.calls[0][0].where.id.in).toEqual([2]);
  });

  it('refuses to remove a recipient who has already signed', async () => {
    const keep = signer(1);
    const signed = signer(2, { signingStatus: 'SIGNED', signedAt: new Date('2026-03-01T09:00:00.000Z') });

    envelopeFindFirst.mockResolvedValue(envelope([keep, signed]));

    await expect(setRecipients([keep])).rejects.toThrow(/already interacted/);

    // Nothing is deleted, so the signature rows that cascade off recipient 2
    // survive and the audit log keeps agreeing with the database.
    expect(recipientDeleteMany).not.toHaveBeenCalled();
  });

  it('refuses even though the envelope is still pending rather than completed', async () => {
    const stillToSign = signer(1);
    const signed = signer(2, { signingStatus: 'SIGNED' });

    // completedAt null, status PENDING: the old gate let this straight through.
    envelopeFindFirst.mockResolvedValue(envelope([stillToSign, signed]));

    await expect(setRecipients([stillToSign])).rejects.toThrow(/already interacted/);
    expect(recipientDeleteMany).not.toHaveBeenCalled();
  });

  it('refuses to remove a recipient who has inserted a field without signing off', async () => {
    const keep = signer(1);
    const partway = signer(2);

    envelopeFindFirst.mockResolvedValue(envelope([keep, partway], [{ id: 11, recipientId: 2, inserted: true }]));

    await expect(setRecipients([keep])).rejects.toThrow(/already interacted/);
    expect(recipientDeleteMany).not.toHaveBeenCalled();
  });

  it('refuses before writing anything, so no partial update survives the rejection', async () => {
    const keep = signer(1);
    const signed = signer(2, { signingStatus: 'SIGNED' });

    envelopeFindFirst.mockResolvedValue(envelope([keep, signed]));

    await expect(setRecipients([keep])).rejects.toThrow();

    expect(recipientUpsert).not.toHaveBeenCalled();
    expect(fieldDeleteMany).not.toHaveBeenCalled();
  });

  it('still removes a CC recipient, who has nothing to lose', async () => {
    const keep = signer(1);
    const cc = signer(2, { role: 'CC', signingStatus: 'SIGNED' });

    envelopeFindFirst.mockResolvedValue(envelope([keep, cc]));

    await setRecipients([keep]);

    expect(recipientDeleteMany.mock.calls[0][0].where.id.in).toEqual([2]);
  });
});

describe('setDocumentRecipients and "Require account" access', () => {
  beforeEach(() => {
    envelopeFindFirst.mockReset();
    recipientUpsert.mockReset();
    recipientDeleteMany.mockReset();

    recipientUpsert.mockImplementation(async ({ where, update }: { where: { id: number }; update: object }) => ({
      ...signer(where.id),
      ...update,
      id: where.id,
    }));
    recipientDeleteMany.mockResolvedValue({ count: 0 });
  });

  const setRecipientsWithAccess = async (recipient: ReturnType<typeof signer>, accessAuth: 'ACCOUNT'[]) =>
    await setDocumentRecipients({
      userId: 9,
      teamId: 1,
      id: { type: 'envelopeId', id: 'envelope_abc123' },
      recipients: [{ ...asInput(recipient), accessAuth }],
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      requestMetadata: { requestMetadata: {}, source: 'app', auth: null, auditUser: {} } as never,
    });

  it('refuses to give a recipient account access they did not have, and writes nothing', async () => {
    const recipient = signer(1);

    envelopeFindFirst.mockResolvedValue(envelope([recipient]));

    await expect(setRecipientsWithAccess(recipient, ['ACCOUNT'])).rejects.toMatchObject({ code: 'INVALID_BODY' });
    expect(recipientUpsert).not.toHaveBeenCalled();
  });

  it('keeps account access on a recipient who already had it', async () => {
    const recipient = signer(1, { authOptions: { accessAuth: ['ACCOUNT'], actionAuth: [] } });

    envelopeFindFirst.mockResolvedValue(envelope([recipient]));

    await setRecipientsWithAccess(recipient, ['ACCOUNT']);

    expect(recipientUpsert).toHaveBeenCalledOnce();
    expect(recipientUpsert.mock.calls[0][0].update.authOptions).toEqual({ accessAuth: ['ACCOUNT'], actionAuth: [] });
  });
});
