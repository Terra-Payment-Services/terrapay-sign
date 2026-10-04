import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * TerraPay Sign holds one organisation and staff join it when they first sign
 * in. Only admins may create one, and only while none exists.
 * The seeded database always holds organisations, so every case here is the
 * "one already exists" case; the fresh-install case is covered by unit tests. *
 * English renders through the en catalogue, which spells these labels the
 * American way ("Create Organization"), so the selectors do too; a British
 * spelling here would make every absence check pass whatever the page shows.
 */

test.describe.configure({ mode: 'parallel' });

const callTrpc = async (page: Page, path: string, input: unknown) => {
  return await page.context().request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });
};

test('a non-admin cannot create an organisation through the API', async ({ page }) => {
  const { user } = await seedUser();
  const name = `Refused member ${user.id}`;

  await apiSignin({ page, email: user.email });

  const res = await callTrpc(page, 'organisation.create', { name });

  // Refused as a non-admin before the one-organisation rule is reached.
  expect(res.status()).toBe(401);
  expect(await prisma.organisation.findFirst({ where: { name } })).toBeNull();
});

test('an admin cannot create another organisation through the API either', async ({ page }) => {
  const { user } = await seedUser({ isAdmin: true });
  const name = `Refused admin ${user.id}`;

  await apiSignin({ page, email: user.email });

  const res = await callTrpc(page, 'organisation.create', { name });

  expect(res.status()).toBe(403);
  expect(await prisma.organisation.findFirst({ where: { name } })).toBeNull();
});

test('an admin cannot create an organisation for a user from the admin panel', async ({ page }) => {
  const { user: admin } = await seedUser({ isAdmin: true });
  const { user: owner } = await seedUser();
  const name = `Refused admin panel ${owner.id}`;

  await apiSignin({ page, email: admin.email });

  const res = await callTrpc(page, 'admin.organisation.create', { ownerUserId: owner.id, data: { name } });

  expect(res.status()).toBe(403);
  expect(await prisma.organisation.findFirst({ where: { name } })).toBeNull();
});

test('nobody is offered organisation creation once one exists', async ({ page }) => {
  const { user } = await seedUser({ isAdmin: true });

  await apiSignin({ page, email: user.email, redirectPath: '/settings/organisations?action=add-organisation' });

  await expect(page.getByRole('heading', { name: 'Organizations', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create organization' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an admin is not offered organisation creation on a user page', async ({ page }) => {
  const { user: admin } = await seedUser({ isAdmin: true });
  const { user } = await seedUser();

  await apiSignin({ page, email: admin.email, redirectPath: `/admin/users/${user.id}` });

  await expect(page.getByRole('heading', { name: 'User Organizations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Organization' })).toHaveCount(0);
});

test('the settings sidebar organisation selector offers no create entry once one exists', async ({ page }) => {
  const { user, organisation, team } = await seedUser({ isAdmin: true });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/general` });

  const sidebar = page.getByTestId('unified-settings-sidebar');

  await sidebar.getByTestId('settings-org-switcher-trigger').click();

  await expect(page.getByTestId(`settings-org-switcher-item-${organisation.url}`)).toBeVisible();
  await expect(page.getByTestId('settings-org-switcher-create')).toHaveCount(0);
});

test('the header organisation menu offers no create entry once one exists', async ({ page }) => {
  const { user, team } = await seedUser({ isAdmin: true });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

  await page.getByTestId('menu-switcher').click();

  await expect(page.getByRole('menuitem', { name: 'Account', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create Organization' })).toHaveCount(0);
});
