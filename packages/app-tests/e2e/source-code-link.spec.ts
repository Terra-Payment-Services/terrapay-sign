import { expect, test } from '@playwright/test';

/**
 * AGPL section 13: everyone who uses the site, signed in or not, is offered
 * the source of the version they are using.
 */
test('[AGPL]: the sign-in page links to the published source', async ({ page }) => {
  await page.goto('/signin');

  const link = page.getByRole('contentinfo').getByRole('link', { name: 'Source code' });

  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://github.com/Terra-Payment-Services/terrapay-sign');
});
