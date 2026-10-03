import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The field list has the same total-replacement shape as the recipient list:
 * anything missing from the array is deleted. `Signature.fieldId` cascades, so
 * omitting a signature field that a recipient has already filled in throws the
 * signature away and leaves the audit log claiming a signature that no longer
 * exists. The envelope only had to be short of `completedAt` to get here.
 */

const envelopeFindFirst = vi.fn();
const fieldDeleteMany = vi.fn();
const fieldUpsert = vi.fn();

const transactionClient = {
  field: {
    upsert: async (...args: unknown[]) => await fieldUpsert(...args),
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
    $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      await callback(transactionClient),
  },
}));

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: async () => ({ envelopeWhereInput: {} }),
}));

const { setFieldsForDocument } = await import('./set-fields-for-document');

const recipient = {
  id: 2,
  email: 'signer@example.com',
  name: 'Signer',
  role: 'SIGNER',
  signingStatus: 'NOT_SIGNED',
};

/**
 * Prisma hands positions back as Decimal. The change check calls `toNumber` on
 * them and the audit diff calls `equals`, so the stub has to answer both.
 */
const decimal = (value: number) => ({
  toNumber: () => value,
  equals: (other: unknown) => Number(other) === value,
  toString: () => String(value),
});

const field = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  secondaryId: `field_${id}`,
  envelopeId: 'envelope_abc123',
  envelopeItemId: 'envelope_item_1',
  recipientId: 2,
  recipient,
  type: 'SIGNATURE',
  page: 1,
  positionX: decimal(10),
  positionY: decimal(10),
  width: decimal(40),
  height: decimal(10),
  customText: '',
  inserted: false,
  fieldMeta: null,
  ...overrides,
});

const asInput = (persisted: ReturnType<typeof field>) => ({
  id: persisted.id,
  envelopeItemId: persisted.envelopeItemId,
  recipientId: persisted.recipientId,
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  type: persisted.type as never,
  pageNumber: persisted.page,
  pageX: persisted.positionX.toNumber(),
  pageY: persisted.positionY.toNumber(),
  pageWidth: persisted.width.toNumber(),
  pageHeight: persisted.height.toNumber(),
});

const setFields = async (fields: ReturnType<typeof field>[]) =>
  await setFieldsForDocument({
    userId: 9,
    teamId: 1,
    id: { type: 'envelopeId', id: 'envelope_abc123' },
    fields: fields.map(asInput),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    requestMetadata: { requestMetadata: {}, source: 'app', auth: null, auditUser: {} } as never,
  });

describe('setFieldsForDocument', () => {
  beforeEach(() => {
    envelopeFindFirst.mockReset();
    fieldDeleteMany.mockReset();
    fieldUpsert.mockReset();

    fieldUpsert.mockImplementation(async ({ where }: { where: { id: number } }) => field(where.id));
    fieldDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('removes a field nobody has filled in', async () => {
    const keep = field(10);
    const drop = field(11);

    envelopeFindFirst.mockResolvedValue({
      id: 'envelope_abc123',
      secondaryId: 'document_7',
      completedAt: null,
      recipients: [recipient],
      envelopeItems: [{ id: 'envelope_item_1' }],
      fields: [keep, drop],
    });

    await setFields([keep]);

    expect(fieldDeleteMany.mock.calls[0][0].where.id.in).toEqual([11]);
  });

  it('refuses to remove a field the recipient has already filled in', async () => {
    const keep = field(10);
    const signed = field(11, { inserted: true });

    envelopeFindFirst.mockResolvedValue({
      id: 'envelope_abc123',
      secondaryId: 'document_7',
      completedAt: null,
      recipients: [recipient],
      envelopeItems: [{ id: 'envelope_item_1' }],
      fields: [keep, signed],
    });

    await expect(setFields([keep])).rejects.toThrow(/already filled in/);

    expect(fieldDeleteMany).not.toHaveBeenCalled();
    expect(fieldUpsert).not.toHaveBeenCalled();
  });
});
