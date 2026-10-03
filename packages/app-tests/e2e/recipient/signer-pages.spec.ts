import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument, seedTeamDocumentWithMeta } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';
import { openDropdownMenu } from '../fixtures/generic';

/**
 * What an external signer sees on the TerraPay Sign signing pages. These pages
 * once carried Documenso branding, a public "share your signing card" link
 * that published the signer's name and signature image, and a marketing line
 * on the cancelled-document page.
 */

test('[SIGNER_PAGES]: the signing tab is titled for TerraPay Sign', async ({ page }) => {
  const { user, team } = await seedUser();
  const document = await seedPendingDocument(user, team.id, ['signer-title@test.documenso.com']);

  await page.goto(`/sign/${document.recipients[0].token}`);

  await expect(page).toHaveTitle('Sign Document - TerraPay Sign');
});

test('[SIGNER_PAGES]: the completed page offers no share link', async ({ page }) => {
  const { user, team } = await seedUser();
  const document = await seedCompletedDocument(user, team.id, ['signer-complete@test.documenso.com']);

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Share/ })).toHaveCount(0);
});

test('[SIGNER_PAGES]: the cancelled page carries no marketing line', async ({ page }) => {
  const { user, team } = await seedUser();
  const document = await seedPendingDocument(user, team.id, ['signer-cancelled@test.documenso.com']);

  await prisma.envelope.update({ where: { id: document.id }, data: { deletedAt: new Date() } });

  await page.goto(`/sign/${document.recipients[0].token}`);

  await expect(page.getByText('Document Cancelled')).toBeVisible();
  await expect(page.getByText(/slick signing links/)).toHaveCount(0);
  await expect(page.getByText(/Ask your administrator/)).toHaveCount(0);
});

test('[SIGNER_PAGES]: the share-card image route no longer exists', async ({ page }) => {
  const response = await page.request.get('/share/some-share-slug/opengraph', { maxRedirects: 0 });

  expect(response.status()).toBe(404);
});

test('[SIGNER_PAGES]: a non-QR share slug redirects even for link-preview bots', async ({ page }) => {
  const response = await page.request.get('/share/some-share-slug', {
    maxRedirects: 0,
    headers: { 'User-Agent': 'facebookexternalhit/1.1' },
  });

  expect(response.status()).toBe(302);
});

test('[SIGNER_PAGES]: the signature disclosure names TerraPay, not Documenso', async ({ page }) => {
  await page.goto('/articles/signature-disclosure');

  const article = page.locator('article');

  await expect(article.getByRole('heading', { name: 'Electronic Signature Disclosure' })).toBeVisible();
  await expect(article).toContainText('Thank you for using TerraPay Sign');
  await expect(article).toContainText('service provided by TerraPay,');
  await expect(article).not.toContainText('Documenso');
});

test('[SIGNER_PAGES]: the signature canvas has an accessible name and points to the Type tab', async ({ page }) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email });

  const document = await seedTeamDocumentWithMeta(team);

  await page.goto(`/sign/${document.recipients[0].token}`);

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Draw' }).click();

  const canvas = page.getByRole('img', { name: 'Draw your signature here' });

  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAccessibleDescription(/use the Type tab/);
  await expect(page.getByRole('tab', { name: 'Type' })).toBeVisible();
});

test('[SIGNER_PAGES]: the staff document menu offers no signing-card share', async ({ page }) => {
  const { user, team } = await seedUser();
  await seedCompletedDocument(user, team.id, ['signer-menu@test.documenso.com'], {
    createDocumentOptions: { title: 'Signer menu document' },
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

  await openDropdownMenu(
    page,
    page.locator('tr', { hasText: 'Signer menu document' }).getByTestId('document-table-action-btn'),
  );

  await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Share Signing Card' })).toHaveCount(0);
});
