import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C40, the helper. The exported prisma client reads from replicas when NEXT_PRIVATE_DATABASE_REPLICA_URLS is set, so
 * a null from `recipient.findFirst` can be replica lag. A rejection that has committed on the primary must still be
 * reported.
 *
 * Failure modes this file pins:
 *  1. Replica shows no REJECTED recipient, the primary has one: the helper must answer true. Answering false lets
 *     every invitation path (signing email handler, resend, send) mail a recipient after a rejection.
 *  2. Neither the replica nor the primary shows a rejection: the helper must answer false, or no invitation is ever
 *     sent. Reading only the primary, or always answering true, would both pass failure mode 1 and break this.
 *  3. The helper must not trade correctness for a throw: it answers a boolean in both lag cases.
 *
 * The primary is exposed as `prisma.$primary()`, the read-replicas extension's own accessor.
 */

const replicaFindFirst = vi.fn();
const primaryFindFirst = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: { findFirst: async (...args: unknown[]) => await replicaFindFirst(...args) },
    $primary: () => ({ recipient: { findFirst: async (...args: unknown[]) => await primaryFindFirst(...args) } }),
  },
}));

const { hasEnvelopeRejection } = await import('./has-envelope-rejection');

describe('hasEnvelopeRejection replica lag (C40)', () => {
  beforeEach(() => {
    replicaFindFirst.mockReset();
    primaryFindFirst.mockReset();
  });

  it('reports a rejection that the replica does not show yet and the primary has', async () => {
    replicaFindFirst.mockResolvedValue(null);
    primaryFindFirst.mockResolvedValue({ id: 5 });

    expect(await hasEnvelopeRejection('envelope_1')).toBe(true);
  });

  it('reports no rejection when neither the replica nor the primary has one', async () => {
    replicaFindFirst.mockResolvedValue(null);
    primaryFindFirst.mockResolvedValue(null);

    expect(await hasEnvelopeRejection('envelope_1')).toBe(false);
  });
});
