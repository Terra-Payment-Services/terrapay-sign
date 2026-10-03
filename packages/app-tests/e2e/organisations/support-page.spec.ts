import { SUPPORT_EMAIL } from '@documenso/lib/constants/app';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

test('the support page sends people to IT support by email', async ({ page }) => {
  const { user, organisation } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/o/${organisation.url}/support` });

  const link = page.getByRole('link', { name: SUPPORT_EMAIL });

  await expect(link).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`);
  await expect(page.getByText('docs.documenso.com')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Documentation' })).toHaveCount(0);
});
