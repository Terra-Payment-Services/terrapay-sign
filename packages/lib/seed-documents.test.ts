import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `seedDocuments` lives in `@documenso/prisma/seed`, which has no test runner
 * of its own, so its test sits here where CI runs vitest.
 *
 * The e2e specs call `await seedDocuments([...])` and then query the API as if
 * the documents existed. For a long time the helper returned before any of
 * them had been written, and the specs passed only when the writes happened
 * to win the race against the request. On a loaded runner they lost, and a
 * team member was shown two of three documents, or none.
 */

const written: string[] = [];

const slowly = async <T>(value: T, ms: number) =>
  await new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    documentData: { create: async () => await slowly({ id: 'data' }, 5) },
    documentMeta: { create: async () => await slowly({ id: 'meta' }, 5) },
    envelope: {
      create: async ({ data }: { data: { title: string } }) => {
        const envelope = await slowly({ ...data, id: `envelope-${data.title}`, envelopeItems: [{ id: 'item' }] }, 20);

        written.push(data.title);

        return envelope;
      },
      findFirstOrThrow: async () => await slowly({}, 5),
    },
    recipient: { create: async () => await slowly({}, 5) },
  },
}));

vi.mock('@documenso/lib/server-only/envelope/increment-id', () => ({
  incrementDocumentId: async () => await slowly({ formattedDocumentId: 'document_1' }, 5),
}));

vi.mock('@documenso/lib/server-only/envelope/create-envelope', () => ({ createEnvelope: vi.fn() }));
vi.mock('@documenso/prisma/seed/teams', () => ({ seedTeam: vi.fn() }));
vi.mock('@documenso/prisma/seed/users', () => ({ seedUser: vi.fn() }));

const { seedDocuments } = await import('@documenso/prisma/seed/documents');

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const sender = { id: 1, email: 'owner@example.com', name: 'Owner' } as Parameters<
  typeof seedDocuments
>[0][number]['sender'];

describe('seedDocuments', () => {
  beforeEach(() => {
    written.length = 0;
  });

  it('has written every document by the time it resolves', async () => {
    await seedDocuments([
      { sender, teamId: 1, recipients: [], type: 'DRAFT', documentOptions: { title: 'Draft' } },
      { sender, teamId: 1, recipients: ['a@example.com'], type: 'PENDING', documentOptions: { title: 'Pending' } },
      { sender, teamId: 1, recipients: ['b@example.com'], type: 'COMPLETED', documentOptions: { title: 'Completed' } },
    ]);

    expect(written.sort()).toEqual(['Completed', 'Draft', 'Pending']);
  });

  it('rejects a status it has no seeder for rather than seeding nothing', async () => {
    await expect(
      seedDocuments([{ sender, teamId: 1, recipients: [], type: 'REJECTED', documentOptions: { title: 'Rejected' } }]),
    ).rejects.toThrow();
  });
});
