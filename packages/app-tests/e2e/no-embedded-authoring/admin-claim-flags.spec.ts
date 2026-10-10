/**
 * The admin claim form offers no embed-authoring flags; the embed-signing flags remain
 * (criterion 8, failure mode F5).
 *
 * Written from the specification alone, without reading the implementation.
 *
 * On this fork the claim templates page (/admin/claims) is already gone (see
 * e2e/admin/hidden-pages.spec.ts), so the claim form an admin can reach is the "Manage
 * subscription" section of an organisation in the admin panel.
 */
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

test('[ADMIN]: the organisation claim form offers embed signing flags and no embed authoring flags', async ({
  page,
}) => {
  const { user: admin } = await seedUser({ isAdmin: true });
  const { organisation } = await seedUser({ isPersonalOrganisation: false });

  await apiSignin({ page, email: admin.email, redirectPath: `/admin/organisations/${organisation.id}` });

  await expect(page.getByRole('heading', { name: 'Feature Flags' })).toBeVisible();

  // The form is the right one and still carries the signing flags.
  await expect(page.getByRole('checkbox', { name: 'Embed signing', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'White label for embed signing', exact: true })).toBeVisible();

  // Neither authoring flag is offered, enabled or disabled.
  await expect(page.getByRole('checkbox', { name: /authoring/i })).toHaveCount(0);
  await expect(page.getByText(/embed authoring/i)).toHaveCount(0);
});
