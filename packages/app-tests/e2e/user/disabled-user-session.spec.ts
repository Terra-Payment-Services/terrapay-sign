import { disableUser } from '@documenso/lib/server-only/user/disable-user';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

test.describe.configure({ mode: 'parallel' });

/**
 * A leaver signed in before being disabled must lose the pages they already
 * had open, not only be refused at the next sign-in.
 */

test('[USER] a signed-in user is sent to sign in once their account is disabled', async ({ page }: { page: Page }) => {
  const { user } = await seedUser();

  await apiSignin({
    page,
    email: user.email,
    password: 'password',
    redirectPath: '/settings/security/sessions',
  });

  await expect(page).toHaveURL('/settings/security/sessions');

  await disableUser({ id: user.id });

  await page.reload();

  await expect(page).toHaveURL('/signin');
});

test('[USER] a session that survives disabling is still refused', async ({ page }: { page: Page }) => {
  const { user } = await seedUser();

  await apiSignin({
    page,
    email: user.email,
    password: 'password',
    redirectPath: '/settings/security/sessions',
  });

  await expect(page).toHaveURL('/settings/security/sessions');

  // Set the flag without going through `disableUser`, so the session row is
  // left in place and only session validation stands in the way.
  await prisma.user.update({ where: { id: user.id }, data: { disabled: true } });

  await page.reload();

  await expect(page).toHaveURL('/signin');
});
