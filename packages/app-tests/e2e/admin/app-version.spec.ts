import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * The e2e server is built without the pipeline's stamp, so it is the
 * unstamped case: the card says dev and names the upstream base, where it used
 * to show upstream's package version as if it were ours.
 */
test('[ADMIN]: the stats page names the running build, not the upstream version', async ({ page }) => {
  const { user: admin } = await seedUser({ isAdmin: true });

  await apiSignin({ page, email: admin.email, redirectPath: '/admin/stats' });

  await expect(page.getByTestId('admin-app-version')).toHaveText('dev');
  await expect(page.getByTestId('admin-app-build')).toHaveText(/^Documenso \d+\.\d+\.\d+$/);
  await expect(page.getByText(/^v2\.\d+\.\d+$/)).toHaveCount(0);
});
