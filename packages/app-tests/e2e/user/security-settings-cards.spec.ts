import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * Staff sign in through Entra and have no password, so an authenticator app is
 * only of use for documents that demand it as action auth, which needs cfr21.
 * The security page offers it only when it can be used, and never hides it
 * from someone who already has one turned on.
 */

test.describe.configure({ mode: 'parallel' });

const TWO_FACTOR_HEADING = 'Two factor authentication';

const signInWithoutPassword = async (page: Parameters<typeof apiSignin>[0]['page'], userId: number, email: string) => {
  await apiSignin({ page, email });

  // The session outlives the password, which is how an SSO-only user looks.
  await prisma.user.update({ where: { id: userId }, data: { password: null } });

  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Security' }).first()).toBeVisible();
};

test('an SSO-only user outside cfr21 is not offered an authenticator app', async ({ page }) => {
  const { user } = await seedUser();

  await signInWithoutPassword(page, user.id, user.email);

  await expect(page.getByText('Recent activity', { exact: true })).toBeVisible();
  await expect(page.getByText(TWO_FACTOR_HEADING, { exact: true })).toHaveCount(0);
});

test('an SSO-only user in a cfr21 organisation is offered an authenticator app', async ({ page }) => {
  const { user, organisation } = await seedUser();

  await prisma.organisationClaim.update({
    where: { id: organisation.organisationClaim.id },
    data: { flags: { ...(organisation.organisationClaim.flags as object), cfr21: true } },
  });

  await signInWithoutPassword(page, user.id, user.email);

  await expect(page.getByText(TWO_FACTOR_HEADING, { exact: true })).toBeVisible();
});

test('a user who already has an authenticator can still see it and turn it off', async ({ page }) => {
  const { user } = await seedUser();

  // Signed in before 2FA would be asked for, then the account is made SSO-only with 2FA on.
  await apiSignin({ page, email: user.email });
  await prisma.user.update({ where: { id: user.id }, data: { password: null, twoFactorEnabled: true } });

  await page.goto('/settings/security');

  await expect(page.getByText(TWO_FACTOR_HEADING, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disable 2FA' })).toBeVisible();
});

test('a password user is offered an authenticator app for sign in', async ({ page }) => {
  const { user } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: '/settings/security' });

  await expect(page.getByText(TWO_FACTOR_HEADING, { exact: true })).toBeVisible();
});

test('the passkeys card follows NEXT_PUBLIC_DISABLE_PASSKEY', async ({ page }) => {
  const { user } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: '/settings/security' });

  await expect(page.getByText('Recent activity', { exact: true })).toBeVisible();

  const passkeysCard = page.getByRole('link', { name: 'Manage passkeys' });

  if (process.env.NEXT_PUBLIC_DISABLE_PASSKEY === 'true') {
    await expect(passkeysCard).toHaveCount(0);
  } else {
    await expect(passkeysCard).toBeVisible();
  }
});
