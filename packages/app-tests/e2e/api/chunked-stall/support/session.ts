import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { seedUser } from '@documenso/prisma/seed/users';
import { request } from '@playwright/test';

/**
 * A signed-in session for the raw-socket specs. The routes under test read the session before they read the
 * body, so an unauthenticated request can be answered 401 without the body being read at all, and then it never
 * reaches the code the deadline guards. Returns a Cookie header value for `OpenOptions.headers`.
 */
export const signInCookieHeader = async () => {
  const { user } = await seedUser();
  const baseURL = NEXT_PUBLIC_WEBAPP_URL();
  const context = await request.newContext({ baseURL });

  try {
    const { csrfToken } = await (await context.get('/api/auth/csrf')).json();
    const response = await context.post('/api/auth/email-password/authorize', {
      data: { email: user.email, password: 'password', csrfToken },
    });

    if (!response.ok()) {
      throw new Error(`sign-in failed with ${response.status()}`);
    }

    const { cookies } = await context.storageState();

    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } finally {
    await context.dispose();
  }
};
