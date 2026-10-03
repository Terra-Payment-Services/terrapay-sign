import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * Sign in creates no personal organisation, so a new user belongs to nothing
 * until someone adds them to a team. They still have to be able to sign what
 * is sent to them.
 */
test('a user with no organisation lands on the inbox and sees what was sent to them', async ({ page }) => {
  const sender = await seedUser();
  const { user } = await seedUser();

  await prisma.organisation.deleteMany({ where: { ownerUserId: user.id } });

  await seedPendingDocument(sender.user, sender.team.id, [user], {
    createDocumentOptions: { title: 'Sent to someone with no organisation' },
  });

  await apiSignin({ page, email: user.email, redirectPath: '/' });

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { name: 'Personal Inbox' })).toBeVisible();
  await expect(page.getByText('Sent to someone with no organisation')).toBeVisible();
});
