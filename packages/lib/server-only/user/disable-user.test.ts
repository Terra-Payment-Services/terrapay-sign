import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Disabling an account must end access already granted, not only refuse new
 * sign-ins. A browser signed in before the account was disabled holds a
 * session row, and that row has to go in the same transaction as the flag.
 */

const findFirst = vi.fn();
const sessionDeleteMany = vi.fn();
const userUpdate = vi.fn();

const tx = {
  user: { update: async (...args: unknown[]) => await userUpdate(...args) },
  apiToken: { updateMany: vi.fn() },
  webhook: { updateMany: vi.fn() },
  verificationToken: { updateMany: vi.fn() },
  passwordResetToken: { updateMany: vi.fn() },
  passkey: { deleteMany: vi.fn() },
  session: { deleteMany: async (...args: unknown[]) => await sessionDeleteMany(...args) },
};

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirst: async (...args: unknown[]) => await findFirst(...args) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => await callback(tx),
  },
}));

const { disableUser } = await import('./disable-user');

describe('disableUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    findFirst.mockResolvedValue({ id: 7 });
  });

  it('deletes every session the user holds, inside the transaction that disables them', async () => {
    await disableUser({ id: 7 });

    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 7 }, data: { disabled: true } });
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
  });
});
