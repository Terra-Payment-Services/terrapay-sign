import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every Remix page loader reaches the signed-in user through
 * `validateSessionToken`. A disabled account must not come back from it as
 * authenticated, or a leaver signed in before being disabled keeps browsing.
 */

const findUnique = vi.fn();
const deleteMany = vi.fn();
const remove = vi.fn();
const update = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    session: {
      findUnique: async (...args: unknown[]) => await findUnique(...args),
      deleteMany: async (...args: unknown[]) => await deleteMany(...args),
      delete: async (...args: unknown[]) => await remove(...args),
      update: async (...args: unknown[]) => await update(...args),
    },
  },
}));

const { validateSessionToken } = await import('./session');

const sessionRow = (disabled: boolean) => ({
  id: 'hashed',
  sessionToken: 'hashed',
  userId: 7,
  createdAt: new Date(),
  updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 25),
  ipAddress: null,
  userAgent: null,
  user: {
    id: 7,
    name: 'Leaver',
    email: 'leaver@example.com',
    emailVerified: new Date(),
    avatarImageId: null,
    twoFactorEnabled: false,
    roles: ['USER'],
    signature: null,
    disabled,
  },
});

describe('validateSessionToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses the session of a disabled user and deletes it', async () => {
    findUnique.mockResolvedValue(sessionRow(true));

    const result = await validateSessionToken('token');

    expect(result).toEqual({ session: null, user: null, isAuthenticated: false });
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('accepts the session of an enabled user', async () => {
    findUnique.mockResolvedValue(sessionRow(false));

    const result = await validateSessionToken('token');

    expect(result.isAuthenticated).toBe(true);
    expect(result.user?.id).toBe(7);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
