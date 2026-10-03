import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';

/**
 * The envelope item limit comes from the organisation claim, and only a member
 * of the team may ask for it. The membership filter is applied by the database
 * query, so the stub returns a team only when the caller is listed as a member.
 */

const MEMBER_USER_ID = 7;
const TEAM_ID = 3;
const CLAIM_ITEM_COUNT = 12;

const teamFindFirst = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    team: {
      findFirst: async (...args: unknown[]) => await teamFindFirst(...args),
    },
  },
}));

const isMemberFilter = (where: unknown, userId: number) => JSON.stringify(where).includes(`"userId":${userId}`);

const { assertEnvelopeItemCountWithinLimit, getEnvelopeItemLimit } = await import('./get-envelope-item-limit');

describe('getEnvelopeItemLimit', () => {
  beforeEach(() => {
    teamFindFirst.mockReset();
    teamFindFirst.mockImplementation(({ where }: { where: { id: number } }) => {
      if (where.id !== TEAM_ID || !isMemberFilter(where, MEMBER_USER_ID)) {
        return null;
      }

      return { organisation: { organisationClaim: { envelopeItemCount: CLAIM_ITEM_COUNT } } };
    });
  });

  it("gives a team member the organisation claim's envelope item count", async () => {
    await expect(getEnvelopeItemLimit({ userId: MEMBER_USER_ID, teamId: TEAM_ID })).resolves.toBe(CLAIM_ITEM_COUNT);
  });

  it('refuses a user who does not belong to the team', async () => {
    const result = getEnvelopeItemLimit({ userId: MEMBER_USER_ID + 1, teamId: TEAM_ID });

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('assertEnvelopeItemCountWithinLimit', () => {
  it('accepts an envelope holding exactly as many items as the claim allows', () => {
    expect(() => assertEnvelopeItemCountWithinLimit({ count: 5, limit: 5 })).not.toThrow();
  });

  it('refuses an envelope holding more items than the claim allows', () => {
    expect(() => assertEnvelopeItemCountWithinLimit({ count: 6, limit: 5 })).toThrow(
      expect.objectContaining({ code: 'ENVELOPE_ITEM_LIMIT_EXCEEDED', statusCode: 400 }),
    );
  });
});
