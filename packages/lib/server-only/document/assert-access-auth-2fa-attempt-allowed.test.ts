import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The emailed access code is six digits and stays valid for five minutes, and
 * nothing counted wrong guesses, so a link holder could keep submitting codes
 * to the completion mutation until one matched.
 */

const counters = new Map<string, number>();

type UpsertArgs = {
  where: { key_action_bucket: { key: string; action: string; bucket: Date } };
  create: { count: number };
  update: { count: { increment: number } };
};

vi.mock('@documenso/prisma', () => ({
  prisma: {
    rateLimit: {
      upsert: async ({ where, create, update }: UpsertArgs) => {
        const { key, action, bucket } = where.key_action_bucket;
        const id = `${key}|${action}|${bucket.getTime()}`;
        const count = counters.has(id) ? (counters.get(id) ?? 0) + update.count.increment : create.count;

        counters.set(id, count);

        return { count };
      },
    },
  },
}));

const { assertAccessAuth2FAAttemptAllowed } = await import('./assert-access-auth-2fa-attempt-allowed');

describe('assertAccessAuth2FAAttemptAllowed', () => {
  beforeEach(() => {
    counters.clear();
  });

  it('allows five attempts and refuses the sixth', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await assertAccessAuth2FAAttemptAllowed({ recipientId: 1 });
    }

    await expect(assertAccessAuth2FAAttemptAllowed({ recipientId: 1 })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('keeps counting against a recipient once they are locked', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await assertAccessAuth2FAAttemptAllowed({ recipientId: 1 });
    }

    await expect(assertAccessAuth2FAAttemptAllowed({ recipientId: 1 })).rejects.toThrow();
    await expect(assertAccessAuth2FAAttemptAllowed({ recipientId: 1 })).rejects.toThrow();
  });

  it("does not lock one recipient for another recipient's attempts", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await assertAccessAuth2FAAttemptAllowed({ recipientId: 1 }).catch(() => undefined);
    }

    await expect(assertAccessAuth2FAAttemptAllowed({ recipientId: 2 })).resolves.toBeUndefined();
  });
});
