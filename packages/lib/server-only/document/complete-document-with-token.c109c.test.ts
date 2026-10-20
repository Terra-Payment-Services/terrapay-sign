import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C109c (G4 spec, "Round after Codex r9"): dictation eligibility is decided once, in the SIGNED transaction, from
 * the size of the step the signature opens, and never re-derived from that step's remaining members.
 *
 * The interleaving cannot be forced end to end: both of A's transactions and B's take the same envelope lock. So
 * this runs the real completeDocumentWithToken on an in-memory database and pauses A between its SIGNED transaction
 * and its invitation transaction (at its read of the pending recipients) while a reminded B completes in full.
 * Envelope: SEQUENTIAL, dictation allowed; A at order 1, B and C at order 2, so A's signature opens [B, C].
 */

type Row = {
  id: number;
  envelopeId: string;
  token: string;
  name: string;
  email: string;
  role: string;
  signingOrder: number;
  signingStatus: string;
  sendStatus: string;
  readStatus: string;
  sentAt: Date | null;
  signedAt: Date | null;
  expiresAt: null;
  authOptions: null;
  rejectionReason: null;
};

const db = vi.hoisted(() => ({
  envelope: null as null | Record<string, unknown>,
  recipients: [] as Row[],
  audit: [] as Array<{ type: string; data: unknown }>,
  jobs: [] as Array<{ name: string; payload: Record<string, unknown> }>,
  beforePendingRead: null as null | (() => Promise<void>),
}));

const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([key, condition]) => {
    if (key === 'envelopeId' || key === 'id' || key === 'signingStatus' || key === 'role') {
      if (condition && typeof condition === 'object' && 'not' in condition) {
        return row[key] !== (condition as { not: unknown }).not;
      }

      return row[key] === condition;
    }

    return true;
  });

vi.mock('@documenso/prisma', () => {
  const client = {
    envelope: {
      findFirst: vi.fn(async (args: { include?: { recipients?: { where?: { token?: string } } } }) => {
        const envelope = db.envelope;

        if (!envelope) {
          return null;
        }

        const token = args.include?.recipients?.where?.token;

        if (token !== undefined) {
          return { ...envelope, recipients: db.recipients.filter((row) => row.token === token).map((r) => ({ ...r })) };
        }

        // haveAllRecipientsSigned
        return db.recipients.every((row) => row.signingStatus === 'SIGNED' || row.role === 'CC') ? envelope : null;
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...db.envelope, recipients: db.recipients.map((r) => ({ ...r })) })),
      findFirstOrThrow: vi.fn(async () => ({ ...db.envelope, recipients: db.recipients.map((r) => ({ ...r })) })),
    },
    field: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    user: { findUnique: vi.fn(async () => null) },
    documentAuditLog: {
      create: vi.fn(async ({ data }: { data: { type: string; data: unknown } }) => {
        db.audit.push({ type: data.type, data: data.data });

        return data;
      }),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    recipient: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        db.recipients.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const rows = db.recipients.filter((row) => matches(row, where));

        for (const row of rows) {
          Object.assign(row, data);
        }

        return { count: rows.length };
      }),
    },
    $queryRaw: vi.fn(async () => [{ status: 'PENDING' }]),
  };

  const topLevelFindMany = client.recipient.findMany;

  return {
    prisma: {
      ...client,
      recipient: {
        ...client.recipient,
        // The only top-level recipient.findMany is the pending-recipients read between the two transactions.
        findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
          const hook = db.beforePendingRead;

          if (hook) {
            db.beforePendingRead = null;
            await hook();
          }

          return await topLevelFindMany(args);
        }),
      },
      $transaction: vi.fn(async (body: (tx: typeof client) => Promise<unknown>) => await body(client)),
    },
  };
});

vi.mock('../../jobs/client', () => ({
  jobs: {
    triggerJob: vi.fn(async (job: { name: string; payload: Record<string, unknown> }) => {
      db.jobs.push(job);
    }),
  },
}));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: vi.fn((value: unknown) => value),
  ZWebhookDocumentSchema: { parse: (value: unknown) => value },
}));
vi.mock('../recipient/get-is-recipient-turn', () => ({ getIsRecipientsTurnToSign: vi.fn(async () => true) }));
vi.mock('../recipient/assert-recipients-turn', () => ({ assertRecipientsTurn: vi.fn(async () => undefined) }));
vi.mock('../recipient/lock-envelope-for-recipient-action', () => ({
  lockEnvelopeForRecipientAction: vi.fn(async () => undefined),
}));
vi.mock('./assert-recipient-access-authorized', () => ({
  assertRecipientAccessAuthorized: vi.fn(async () => undefined),
}));
vi.mock('../../universal/upload/get-file.server', () => ({ getFileServerSide: vi.fn(async () => new Uint8Array()) }));
vi.mock('../pdf/normalize-pdf', () => ({ assertLegacyEnvelopeAcceptsPdf: vi.fn(async () => undefined) }));

const { completeDocumentWithToken } = await import('./complete-document-with-token');

const recipient = (id: number, key: string, signingOrder: number, sendStatus: string): Row => ({
  id,
  envelopeId: 'envelope_c109c',
  token: `tok-${key}`,
  name: `Signer ${key}`,
  email: `${key}@terrapay.example`,
  role: 'SIGNER',
  signingOrder,
  signingStatus: 'NOT_SIGNED',
  sendStatus,
  readStatus: 'OPENED',
  sentAt: sendStatus === 'SENT' ? new Date(Date.now() - 60_000) : null,
  signedAt: null,
  expiresAt: null,
  authOptions: null,
  rejectionReason: null,
});

const seed = (internalVersion: 1 | 2) => {
  db.envelope = {
    id: 'envelope_c109c',
    secondaryId: 'document_109',
    type: 'DOCUMENT',
    status: 'PENDING',
    internalVersion,
    signatureLevel: 'SES',
    userId: 1,
    teamId: 1,
    authOptions: null,
    documentMeta: { signingOrder: 'SEQUENTIAL', allowDictateNextSigner: true },
    envelopeItems: [{ documentData: { type: 'BYTES_64', id: 'data_1', data: '', initialData: '' } }],
  };
  // A is in its turn; B was reminded before its turn (SENT); C was not.
  db.recipients = [recipient(1, 'a', 1, 'SENT'), recipient(2, 'b', 2, 'SENT'), recipient(3, 'c', 2, 'NOT_SENT')];
  db.audit = [];
  db.jobs = [];
  db.beforePendingRead = null;
};

const complete = async (key: string, nextSigner?: { name: string; email: string }) =>
  await completeDocumentWithToken({ token: `tok-${key}`, id: { type: 'documentId', id: 109 }, nextSigner });

const DICTATED = { name: 'Dictated By A', email: 'dictated@terrapay.example' };

describe('C109c dictation eligibility is fixed by the step the signature opens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    1, 2,
  ] as const)('V%s: A opens [B, C] and B completes before A invites: A renames nobody, C keeps its name and is invited once', async (version) => {
    seed(version);

    // B completes in full in the gap between A's SIGNED transaction and A's invitation transaction.
    db.beforePendingRead = async () => {
      await complete('b');
    };

    await complete('a', DICTATED);

    const c = db.recipients.find((row) => row.id === 3);
    const invitations = db.jobs.filter((job) => job.name === 'send.signing.requested.email');

    expect(db.recipients.find((row) => row.id === 2)?.signingStatus, 'premise: B completed').toBe('SIGNED');
    expect({ name: c?.name, email: c?.email }, 'C keeps its own name and email').toEqual({
      name: 'Signer c',
      email: 'c@terrapay.example',
    });
    expect(
      db.audit.filter((row) => row.type === 'RECIPIENT_UPDATED'),
      'no dictation audit entry',
    ).toHaveLength(0);
    expect(
      invitations.map((job) => job.payload.recipientId),
      'one turn invitation, to C (B signed before A invited)',
    ).toEqual([3]);
  });
});
