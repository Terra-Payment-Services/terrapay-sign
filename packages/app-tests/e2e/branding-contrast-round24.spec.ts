/**
 * The PDF label's dark pairing, and a print control with colours (round 24).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 24: the PDF label's
 * dark pairing, and a real print control", without reading the sanitiser, the guard, its measurement or
 * the token rendering.
 *
 * | Criterion | Test                                                                                  |
 * | --------- | ------------------------------------------------------------------------------------- |
 * | 127       | C127-save; C127-render "Page 1 of 1" dark with a stored #757575; C127-default,        |
 * |           | C127-defaults, C127-brand (controls)                                                  |
 * | 128       | C128-readable a print stylesheet setting colour and background on each rule           |
 * | 129       | rounds 10 to 23 and lib rerun                                                         |
 *
 * "Page 1 of 1" is `text-muted-foreground/80` (`apps/remix/app/components/general/pdf-viewer.tsx:317`) on
 * the V2 root, `bg-gray-50 dark:bg-background` (`document-signing-page-view-v2.tsx:84`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_BRAND_COLORS } from '@documenso/lib/constants/theme';
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDataType, FieldType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  contrast,
  errorBodyHasCode,
  hex,
  hslTriplet,
  near,
  openAdminSession,
  type Rgba,
  readBodyVars,
  resetBranding,
  saveOrganisationSettings,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round24');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const MARKER = '.g3-marker{font-weight:700}';
const SETTLE_MS = 3_000;
const BRAND = { primary: '#c84a44', primaryForeground: '#ffffff' };

const squash = (css: string) => css.replace(/\s+/g, '');

const logoJson = async () => {
  const logo = await fs.readFile(path.join(__dirname, '../../assets/logo.png'));

  return JSON.stringify({ type: DocumentDataType.BYTES_64, data: logo.toString('base64') });
};

/** The stored row, written directly so the save-time checks cannot refuse it first. Logo kept. */
const seedRow = async (css: string, colors: Record<string, string> | null) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: css, brandingColors: colors, brandingLogo: await logoJson() },
  });
};

const storedColors = async () =>
  (
    await prisma.organisationGlobalSettings.findUniqueOrThrow({
      where: { id: admin.organisationGlobalSettingsId },
    })
  ).brandingColors as Record<string, string> | null;

/** A pending document with one signature field for one recipient, V1 or V2. */
const seedToken = async (label: string, internalVersion: 1 | 2) => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
  const { recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: admin.teamId,
    recipients: [`g3-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.documenso.com`],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion },
  });

  return recipients[0].token;
};

const openV1 = async (page: Page, token: string) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(page.getByRole('button', { name: 'Reject Document' }).first()).toBeVisible({ timeout: 30_000 });

  return response?.status();
};

const openV2 = async (page: Page, token: string) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(page.getByText('Page 1 of 1').first()).toBeVisible({ timeout: 30_000 });

  return response?.status();
};

const installMarker = async (page: Page) =>
  await page.evaluate(() => {
    if (document.getElementById('g3-marker-probe')) {
      return;
    }

    const element = document.createElement('div');

    element.id = 'g3-marker-probe';
    element.className = 'g3-marker';
    element.hidden = true;
    document.body.appendChild(element);
  });

const markerWeight = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.getElementById('g3-marker-probe');

    return element ? getComputedStyle(element).fontWeight : 'no-marker';
  });

/** Every element carrying `data-branding-guard`, as `tag=reason`. */
const guardReasons = async (page: Page) =>
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-branding-guard]')).map(
      (element) => `${element.tagName.toLowerCase()}=${element.getAttribute('data-branding-guard')}`,
    ),
  );

/** The colour-token style elements: `.documenso-branded { --… }` with the class once. */
const tokenStyles = async (page: Page) =>
  (await page.evaluate(`Array.from(document.querySelectorAll('style'))
    .filter((s) => /^\\s*\\.documenso-branded\\s*\\{\\s*--/.test(s.textContent || ''))
    .map((s) => ({
      guard: s.getAttribute('data-branding-guard'),
      media: s.media,
      disabled: s.sheet ? s.sheet.disabled : null,
      text: (s.textContent || '').slice(0, 400),
    }))`)) as { guard: string | null; media: string; disabled: boolean | null; text: string }[];

const decodePixels = async (page: Page, png: Buffer) => {
  const blank = await page.context().newPage();

  try {
    return await blank.evaluate(async (data) => {
      const image = new Image();

      image.src = `data:image/png;base64,${data}`;
      await image.decode();

      const canvas = document.createElement('canvas');

      canvas.width = image.width;
      canvas.height = image.height;

      const context = canvas.getContext('2d');

      if (!context) {
        return [];
      }

      context.drawImage(image, 0, 0);

      const raw = context.getImageData(0, 0, image.width, image.height).data;
      const out: number[][] = [];

      for (let i = 0; i < raw.length; i += 4) {
        out.push([raw[i], raw[i + 1], raw[i + 2]]);
      }

      return out;
    }, png.toString('base64'));
  } finally {
    await blank.close();
  }
};

const ranked = (pixels: number[][]) => {
  const counts = new Map<string, number>();

  for (const p of pixels) {
    const key = p.join(',');

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()].sort((x, y) => y[1] - x[1]);
};

const toRgba = (key: string): Rgba => {
  const [r, g, b] = key.split(',').map(Number);

  return { r, g, b, a: 1 };
};

/** Round 22's reader for small text: the most common pixel is the background, the furthest pixel the text. */
const paintedDominant = async (page: Page, selector: string) => {
  const pixels = await decodePixels(page, await page.locator(selector).first().screenshot({ animations: 'disabled' }));
  const background = toRgba(ranked(pixels)[0][0]);
  let text = background;
  let best = 1;

  for (const [r, g, b] of pixels) {
    const candidate: Rgba = { r, g, b, a: 1 };
    const ratio = contrast(candidate, background);

    if (ratio > best) {
      best = ratio;
      text = candidate;
    }
  }

  return { ratio: best, background, text, pixels: pixels.length };
};

/** Opens the V2 page with a dark system preference and no theme cookie; asserts `<html>` is dark. */
const openV2Dark = async (page: Page, token: string) => {
  await page.emulateMedia({ colorScheme: 'dark' });

  const theme = await page.context().request.post(`${baseUrl}/api/theme`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ theme: null }),
  });

  expect(theme.ok(), `theme action: ${theme.status()}`).toBe(true);

  const status = await openV2(page, token);
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));

  expect(isDark, 'premise: <html> carries "dark"').toBe(true);

  return status;
};

test.describe('[BRANDING_CONTRAST]: the PDF label on the dark page', () => {
  // As in round 23: at 1x the 11px label is mostly antialiased edge, so the glyph cores are sampled at 2x.
  test.use({ deviceScaleFactor: 2 });

  /** Catches: mutedForeground on the dark background checked opaque while the label paints it at 80%. */
  test('C127-save saving { mutedForeground: "#757575" } is refused naming mutedForeground and the dark theme', async ({
    request: _request,
  }, testInfo) => {
    const save = await saveOrganisationSettings(admin, { brandingColors: { mutedForeground: '#757575' } });
    const stored = await storedColors();

    await writeEvidence(testInfo, 'c127-save', { status: save.status, text: save.text, stored });

    expect.soft(save.status, 'refused, not saved').not.toBe(200);
    expect.soft(errorBodyHasCode(save.body, 'INVALID_BODY'), `INVALID_BODY: ${save.text.slice(0, 300)}`).toBe(true);
    expect.soft(save.text, 'the warning names mutedForeground').toContain('mutedForeground');
    expect.soft(save.text, 'the warning names the dark theme').toMatch(/dark/i);
    expect.soft(stored, 'nothing is stored').toBeNull();
  });

  for (const c of [
    { id: 'render', colors: { mutedForeground: '#757575' } as Record<string, string> | null },
    { id: 'default', colors: null },
    { id: 'defaults', colors: { ...DEFAULT_BRAND_COLORS } as Record<string, string> },
    { id: 'brand', colors: BRAND },
  ]) {
    /**
     * Catches: a stored `#757575` kept at render, so "Page 1 of 1" paints 2.91:1 on the dark page and the
     * guard drops the tokens. Controls: the default theme, the shipped defaults sent explicitly
     * (C120-defaults) and the C120 brand palette read there with no guard reason.
     */
    test(`C127-${c.id} "Page 1 of 1" on the dark V2 page with ${c.colors ? (c.id === 'defaults' ? 'the shipped defaults' : JSON.stringify(c.colors)) : 'the default theme'}`, async ({
      page,
    }, testInfo) => {
      const token = await seedToken(`c127-${c.id}`, 2);

      await seedRow('', c.colors);

      const status = await openV2Dark(page, token);

      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => {
        const element = Array.from(document.querySelectorAll('p')).find(
          (el) => (el.textContent ?? '').trim() === 'Page 1 of 1' && el.getBoundingClientRect().width > 0,
        );

        element?.setAttribute('data-g3-probe', 'page-label');
      });

      const painted = await paintedDominant(page, '[data-g3-probe="page-label"]');
      const guard = await guardReasons(page);
      const vars = await readBodyVars(page, ['--muted-foreground', '--background']);

      await writeEvidence(testInfo, `c127-${c.id}`, { colors: c.colors, status, painted, guard, vars });

      expect.soft(status, 'the page answers 200').toBe(200);
      expect.soft(painted.ratio, '"Page 1 of 1" reads at least 3:1 by pixel sample').toBeGreaterThanOrEqual(3);
      expect.soft(guard, 'no guard reason on the page').toEqual([]);
    });
  }
});

/** A test-owned `.card` holding a paragraph, for the print stylesheet to paint. */
const addPrintCard = async (page: Page) =>
  await page.evaluate(() => {
    const card = document.createElement('div');
    const text = document.createElement('p');

    card.className = 'card';
    card.id = 'g3-print-card';
    text.textContent = 'G3 print probe';
    card.appendChild(text);
    document.body.appendChild(card);
  });

test.describe('[BRANDING_CONTRAST]: a print control with colours', () => {
  const CSS = `${MARKER}\n@media print { .card { background-color:#ffffff; color:#000000 } }`;

  /**
   * Catches: the readable print rules emptied by the per-rule contrast policy, so the control proves only
   * that the stylesheet stays applied; and the print copy disabled, or the tokens dropped, at print.
   */
  test('C128-readable a print stylesheet setting colour and background on the rule keeps both', async ({
    page,
  }, testInfo) => {
    const rendered = renderStoredBrandingCss(CSS, BRAND);
    const token = await seedToken('c128', 1);

    await seedRow(CSS, BRAND);
    await openV1(page, token);
    await installMarker(page);
    await addPrintCard(page);
    await page.waitForTimeout(SETTLE_MS);

    const screen = { weight: await markerWeight(page), guard: await guardReasons(page) };

    expect(screen.weight, 'premise: the stylesheet is applied on screen').toBe('700');

    // Chromium's order, as in C124: `beforeprint` first, then the print media.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(SETTLE_MS);

    const weight = await markerWeight(page);
    const guard = await guardReasons(page);
    const styles = await tokenStyles(page);
    const vars = await readBodyVars(page, ['--primary']);
    const primaryApplies = near(hslTriplet(vars['--primary']), hex(BRAND.primary), 3);
    const card = await page.evaluate(() => {
      const element = document.getElementById('g3-print-card');
      const text = element?.querySelector('p');

      return element && text
        ? {
            color: getComputedStyle(element).color,
            textColor: getComputedStyle(text).color,
            background: getComputedStyle(element).backgroundColor,
          }
        : null;
    });

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });

    await writeEvidence(testInfo, 'c128-readable', {
      css: CSS,
      rendered,
      screen,
      print: { weight, guard, styles, vars, primaryApplies, card },
    });

    expect
      .soft(squash(rendered), 'the stored stylesheet renders its print declarations')
      .toContain(squash('@media print { .card { background-color:#ffffff; color:#000000 } }'));
    expect.soft(card?.color, "the card's text colour at print is the tenant's").toBe('rgb(0, 0, 0)');
    expect.soft(card?.textColor, "the card's paragraph inherits it").toBe('rgb(0, 0, 0)');
    expect.soft(card?.background, "the card's background at print is the tenant's").toBe('rgb(255, 255, 255)');
    expect.soft(weight, 'the stylesheet stays applied at print').toBe('700');
    expect.soft(guard, 'no guard reason on the page').toEqual([]);
    expect
      .soft(
        styles.map((s) => s.guard),
        'no token style element carries data-branding-guard="tokens"',
      )
      .not.toContain('tokens');
    expect.soft(primaryApplies, `the primary token still applies (${vars['--primary']})`).toBe(true);
  });
});
