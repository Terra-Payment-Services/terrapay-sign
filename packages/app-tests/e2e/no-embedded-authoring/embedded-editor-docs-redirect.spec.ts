/**
 * The old embedded-editor documentation URLs redirect to a page saying this fork does not
 * support embedded authoring (criterion 9, failure mode F2 for the docs site).
 *
 * Written from the specification alone, without reading the implementation.
 *
 * The documentation is a separate Next.js app (apps/docs) that the e2e_local job does not start,
 * so these tests run only when E2E_DOCS_URL points at a running docs server, for example
 * `PORT=3102 npm run dev -w @documenso/docs` and `E2E_DOCS_URL=http://localhost:3102`. Without
 * it they are skipped, and the skip is reported rather than counted as a pass.
 */
import { expect, test } from '@playwright/test';

const DOCS_URL = process.env.E2E_DOCS_URL?.trim();

/**
 * The editor overview URL may itself become the page that says embedded authoring is not
 * supported, so it is held only to the message. Every other old URL must redirect away.
 */
const EDITOR_OVERVIEW_URL = '/docs/developers/embedding/editor';

const OLD_EMBEDDED_EDITOR_URLS = [
  '/docs/developers/embedding/editor/v1',
  '/docs/developers/embedding/editor/v2',
  '/docs/developers/embedding/authoring',
  '/developers/embedding/authoring',
  '/developers/embedded-authoring',
];

const NOT_SUPPORTED = /(does not|doesn't|do not) support embedded authoring|embedded authoring is not supported/i;

test.describe('Old embedded editor documentation URLs', () => {
  test.skip(!DOCS_URL, 'needs a running docs app in E2E_DOCS_URL');

  test(`${EDITOR_OVERVIEW_URL} says embedded authoring is not supported`, async ({ page }) => {
    test.setTimeout(120_000);

    const response = await page.goto(`${DOCS_URL}${EDITOR_OVERVIEW_URL}`, { timeout: 90_000 });

    expect(response?.status()).toBe(200);

    await expect(page.locator('body')).toContainText(NOT_SUPPORTED);
  });

  for (const oldPath of OLD_EMBEDDED_EDITOR_URLS) {
    test(`${oldPath} redirects to a page saying embedded authoring is not supported`, async ({ page }) => {
      test.setTimeout(120_000);

      const response = await page.goto(`${DOCS_URL}${oldPath}`, { timeout: 90_000 });

      expect(response?.status(), oldPath).toBe(200);
      expect(response?.request().redirectedFrom(), `${oldPath} should be redirected`).not.toBeNull();
      expect(new URL(page.url()).pathname).not.toBe(oldPath);

      await expect(page.locator('body')).toContainText(NOT_SUPPORTED);
    });
  }
});
