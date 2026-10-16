import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiSignin, apiSignout } from './fixtures/authentication';

/**
 * An organisation admin's branding CSS is rendered on the recipient signing
 * page inside `.documenso-branded { ... }`, and the sanitiser is meant to stop it hiding,
 * moving or covering the page's controls. Each test saves one bypass form through the
 * settings API and then opens the signing page as the recipient, who must still see and be
 * able to click "Reject Document".
 *
 * The Reject button is a Radix dialog trigger, so `button[aria-haspopup="dialog"]` is the
 * most specific selector the page offers; every variant also targets plain `button`.
 *
 * Each CSS carries a harmless canary, `button { border-color: rgb(1, 2, 3) }`. Seeing it on
 * the Reject button proves the branding CSS reached the page, so a visible button means the
 * hostile part was neutralised rather than never rendered.
 */
const REJECT_SELECTOR = 'button[aria-haspopup="dialog"], button';
const CANARY_CSS = 'button { border-color: rgb(1, 2, 3); }';
const CANARY_COLOR = 'rgb(1, 2, 3)';

const baseUrl = NEXT_PUBLIC_WEBAPP_URL();

/**
 * Decodes CSS escapes: a backslash and 1 to 6 hex digits with one optional trailing
 * whitespace, or a backslash and any other character, which stands for that character.
 */
const decodeCssEscapes = (css: string) =>
  css.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f]))/g, (_match, hex, char) => {
    if (hex === undefined) {
      return char;
    }

    const codePoint = parseInt(hex, 16);

    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return '\uFFFD';
    }

    return String.fromCodePoint(codePoint);
  });

const saveBrandingCss = async (page: Page, organisationId: string, brandingCss: string) => {
  const response = await page.context().request.post(`${baseUrl}/api/trpc/organisation.settings.update`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: { organisationId, data: { brandingEnabled: true, brandingCss } } }),
  });

  expect(response.ok()).toBe(true);
};

const readStoredBrandingCss = async (page: Page, organisationId: string) => {
  const input = encodeURIComponent(JSON.stringify({ json: { organisationReference: organisationId } }));
  const response = await page.context().request.get(`${baseUrl}/api/trpc/organisation.get?input=${input}`);

  expect(response.ok()).toBe(true);

  const body = await response.json();
  const brandingCss: unknown = body.result.data.json.organisationGlobalSettings.brandingCss;

  expect(typeof brandingCss).toBe('string');

  return String(brandingCss);
};

/**
 * Saves the CSS as the organisation admin, signs out, and opens a pending document's signing
 * page as its recipient. Returns the stored CSS, read back before signing out.
 */
const openSigningPageWithBrandingCss = async (page: Page, brandingCss: string) => {
  const { user, team, organisation } = await seedUser({ isPersonalOrganisation: false });

  await apiSignin({ page, email: user.email });
  await saveBrandingCss(page, organisation.id, `${brandingCss}\n${CANARY_CSS}`);

  const storedCss = await readStoredBrandingCss(page, organisation.id);

  await apiSignout({ page });
  await page.context().clearCookies();

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [`branding-css-reject-${Date.now()}@test.documenso.com`],
    fields: [FieldType.SIGNATURE],
  });

  await page.goto(`${baseUrl}/sign/${recipients[0].token}`);

  return { storedCss };
};

const expectRejectButtonUsable = async (page: Page) => {
  const rejectButton = page.getByRole('button', { name: 'Reject Document' });

  await expect(rejectButton).toBeVisible({ timeout: 30_000 });
  await expect(rejectButton).toBeEnabled();

  // The canary shows the branding CSS is applied to this page.
  await expect(rejectButton).toHaveCSS('border-top-color', CANARY_COLOR);

  // A real click: Playwright refuses it if the button is covered or does not receive events.
  await rejectButton.click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByPlaceholder('Please provide a reason for rejecting this document')).toBeVisible();
};

test.describe('[BRANDING_CSS]: branding CSS cannot hide the Reject button from a signer', () => {
  test('nested rule: an ancestor rule holding a display:none rule for the button', async ({ page }) => {
    await openSigningPageWithBrandingCss(page, `div { ${REJECT_SELECTOR} { display: none; } }`);

    await expectRejectButtonUsable(page);
  });

  test('top-level declaration: display:none outside any rule', async ({ page }) => {
    await openSigningPageWithBrandingCss(page, 'display: none;');

    await expectRejectButtonUsable(page);
  });

  test('escaped property name: displ\\61y:none on the button', async ({ page }) => {
    await openSigningPageWithBrandingCss(page, `${REJECT_SELECTOR} { displ\\61y: none; }`);

    await expectRejectButtonUsable(page);
  });

  test('escaped blocked value: background \\75rl(...) used to cover the button', async ({ page }) => {
    const { storedCss } = await openSigningPageWithBrandingCss(
      page,
      `${REJECT_SELECTOR}, div { background: \\75rl(https://x.example/a.png) no-repeat; }`,
    );

    expect(decodeCssEscapes(storedCss).toLowerCase()).not.toContain('url(');

    await expectRejectButtonUsable(page);

    const backgroundImage = await page
      .getByRole('button', { name: 'Reject Document' })
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundImage);

    expect(backgroundImage).not.toContain('url(');
  });

  test('CSS saved before the fix, written straight to the database, is cleaned when rendered', async ({ page }) => {
    const { user, team, organisation } = await seedUser({ isPersonalOrganisation: false });

    // Bypass the save-time sanitiser, as CSS stored before the fix would have.
    await prisma.organisationGlobalSettings.update({
      where: { id: organisation.organisationGlobalSettingsId },
      data: {
        brandingEnabled: true,
        brandingCss: `display: none;\ndiv { ${REJECT_SELECTOR} { display: none; } }\n${CANARY_CSS}`,
      },
    });

    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: [`branding-css-legacy-${Date.now()}@test.documenso.com`],
      fields: [FieldType.SIGNATURE],
    });

    await page.goto(`${baseUrl}/sign/${recipients[0].token}`);

    await expectRejectButtonUsable(page);

    // Every <style> element carrying the branding wrapper, decoded as the browser reads it.
    const brandingStyles = await page
      .locator('style')
      .evaluateAll((elements) =>
        elements.map((element) => element.textContent ?? '').filter((text) => text.includes('documenso-branded')),
      );

    expect(brandingStyles.length).toBeGreaterThan(0);

    for (const text of brandingStyles) {
      const decoded = decodeCssEscapes(text).toLowerCase();

      expect(decoded).not.toMatch(/display\s*:\s*none/);
      expect(decoded).not.toContain('aria-haspopup');

      // Inside the one `.documenso-branded { ... }` wrapper, no rule holds another rule.
      const inner = decoded.replace(/^\s*\.documenso-branded\s*\{/, '').replace(/\}\s*$/, '');

      expect(inner).not.toMatch(/\{[^}]*\{/);
    }
  });
});
