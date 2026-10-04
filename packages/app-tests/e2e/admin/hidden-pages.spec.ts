import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * Billing plans, per-plan email transports and the sign-up blocklist do
 * nothing on an instance that has no billing, sends through one Graph mailbox
 * and admits staff only through Entra, so the admin area no longer offers them.
 */
test('[ADMIN]: claims, email transports and the blocklist are gone, the banner stays', async ({ page }) => {
  const { user: admin } = await seedUser({ isAdmin: true });

  await apiSignin({ page, email: admin.email, redirectPath: '/admin/site-settings' });

  await expect(page.getByRole('heading', { name: 'Site Banner' })).toBeVisible();
  await expect(page.getByText('Email Blocklist')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Site Settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Claims' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Email Transports' })).toHaveCount(0);

  for (const path of ['/admin/claims', '/admin/email-transports']) {
    const response = await page.goto(path);

    expect(response?.status()).toBe(404);
  }
});
