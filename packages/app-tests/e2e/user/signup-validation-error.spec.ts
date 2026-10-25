import { prisma } from '@documenso/prisma';
import { seedTestEmail } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';

import { signSignaturePad } from '../fixtures/signature';

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Issue #202, C4: the signup form still shows a server validation failure as an error. The form's own validation
 * would stop an over-long name or a weak password, so the request is rewritten in flight, after the form has let it
 * through. The server then answers 400 and the page must show the error toast, stay on /signup and not crash.
 */
const submitRewritten = async (page: Page, rewrite: Record<string, string>, password: string, email: string) => {
  const pageErrors: Error[] = [];

  page.on('pageerror', (error) => pageErrors.push(error));

  await page.route('**/api/auth/email-password/signup', async (route) => {
    const original = JSON.parse(route.request().postData() ?? '{}');

    await route.continue({ postData: JSON.stringify({ ...original, ...rewrite }) });
  });

  await page.goto('/signup');
  await page.getByLabel('Name').fill('Echo Test');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);

  await signSignaturePad(page);

  const responsePromise = page.waitForResponse('**/api/auth/email-password/signup');

  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  const response = await responsePromise;
  const text = await response.text();

  expect(response.status(), text).toBe(400);
  expect(text).not.toContain(rewrite.password ?? password);

  await expect(page.getByText('An error occurred')).toBeVisible();
  await expect(page).toHaveURL(/\/signup/);

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
  expect(await prisma.user.findFirst({ where: { email } }), 'no user created').toBeNull();
};

test('[USER] signup with a name over the limit, past client validation, shows an error', async ({ page }) => {
  await submitRewritten(page, { name: `Echo-Name-${'x'.repeat(101)}` }, 'Password123#', seedTestEmail());
});

test('[USER] signup with a weak password, past client validation, shows an error', async ({ page }) => {
  await submitRewritten(page, { password: 'Echo-Weak-password' }, 'Password123#', seedTestEmail());
});
