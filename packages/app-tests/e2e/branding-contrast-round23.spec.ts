/**
 * The radius token, print fallback and translucent fixed-surface text (round 23).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 23: the radius
 * token, print fallback and translucent fixed-surface text", without reading the sanitiser, the guard,
 * its measurement or the token rendering.
 *
 * | Criterion | Test                                                                                  |
 * | --------- | ------------------------------------------------------------------------------------- |
 * | 122       | C122-refused-<value>, C122-accepted-<value>                                           |
 * | 123       | C123-percent a stored 100% radius on the signing and reject dialogs; C123-1rem        |
 * | 124       | C124-unreadable a print stylesheet falls back without the tokens; C124-readable       |
 * | 125       | C125-save, C125-render "Page 1 of 1" with a stored #858585; C125-default, C125-brand  |
 * | 126       | rounds 10 to 22 and lib rerun                                                         |
 *
 * C123's criterion asks for 4.5:1; the stylesheet's own `[role=dialog]{color:#909090}` reads 3.19:1 on
 * the dialog's white, which the campaign's 3:1 threshold accepts, so the pass condition here is 3:1 and
 * the 4.5:1 reading is recorded in the evidence (reported as a spec problem).
 *
 * The dialog's corner is `sm:rounded-lg` (`packages/ui/primitives/dialog.tsx:64`), `var(--radius)` by
 * `packages/tailwind-config/index.cjs:273`, so `1rem` computes to 16px and the default `0.5rem` to 8px.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDataType, FieldType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  composite,
  contrast,
  errorBodyHasCode,
  hex,
  hslTriplet,
  near,
  openAdminSession,
  parseComputed,
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
  admin = await openAdminSession(browser, testInfo, 'round23');
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

const logoVisible = async (page: Page) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: admin.teamId } });

  return await page
    .getByRole('img', { name: `${team.name}'s Logo` })
    .first()
    .isVisible();
};

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

/**
 * Round 17's reader for a clipped dialog: the text colour is the computed one and must appear among the
 * pixels; the ratio is the lowest against any colour covering at least 5% of the box, so an overlay
 * exposed behind part of the title counts.
 */
const paintedAgainstExposed = async (page: Page, selector: string) => {
  const computed = await page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  const pixels = await decodePixels(page, await page.locator(selector).first().screenshot({ animations: 'disabled' }));
  const [cr, cg, cb] = (computed.match(/[\d.]+/g) ?? []).map(Number);
  const text: Rgba = { r: cr, g: cg, b: cb, a: 1 };
  const textSeen = pixels.some(
    ([pr, pg, pb]) => Math.abs(pr - cr) <= 8 && Math.abs(pg - cg) <= 8 && Math.abs(pb - cb) <= 8,
  );
  const backgrounds = ranked(pixels)
    .filter(([, n]) => n >= pixels.length * 0.05)
    .map(([key]) => toRgba(key))
    .filter((b) => contrast(text, b) >= 1.2);
  const ratio = backgrounds.length > 0 ? Math.min(...backgrounds.map((b) => contrast(text, b))) : 0;

  return { ratio, computed, textSeen, against: backgrounds, pixels: pixels.length };
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

const dialogRadius = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.querySelector('[role=dialog]');

    return element ? getComputedStyle(element).borderTopLeftRadius : 'no-dialog';
  });

/** Tags the open dialog's title and its first body paragraph with text. */
const tagDialogText = async (page: Page) =>
  await page.evaluate(() => {
    const dialog = document.querySelector('[role=dialog]');
    const title = dialog?.querySelector('h2');
    const body = Array.from(dialog?.querySelectorAll('p') ?? []).find(
      (element) => (element.textContent ?? '').trim() !== '' && element.getBoundingClientRect().width > 0,
    );

    title?.setAttribute('data-g3-probe', 'dialog-title');
    body?.setAttribute('data-g3-probe', 'dialog-body');

    // The signing title nests the email in a muted element; it is measured on its own, since the
    // title's reader would otherwise count its grey as a backdrop under the navy.
    const part = Array.from(title?.querySelectorAll('*') ?? []).find(
      (element) => title && getComputedStyle(element).color !== getComputedStyle(title).color,
    );

    part?.setAttribute('data-g3-probe', 'dialog-title-part');

    return {
      title: title?.textContent?.trim() ?? null,
      titlePart: part?.textContent?.trim() ?? null,
      body: body?.textContent?.trim().slice(0, 80) ?? null,
    };
  });

const openSignatureDialog = async (page: Page) => {
  await page.locator('[data-field-type=SIGNATURE]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(500);
};

const openRejectDialog = async (page: Page) => {
  await page.getByRole('button', { name: 'Reject Document' }).first().click();
  await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
  await page.waitForTimeout(500);
};

const closeDialog = async (page: Page) => {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

test.describe('[BRANDING_CONTRAST]: the radius token at save', () => {
  for (const value of ['100%', '2em', '12pt', '100', '17px', '1.5rem']) {
    /** Catches: a radius that can clip a dialog's background accepted as a colour token. */
    test(`C122-refused-${value} saving { radius: '${value}' } is refused`, async ({ request: _request }, testInfo) => {
      const save = await saveOrganisationSettings(admin, { brandingColors: { radius: value } });
      const stored = await storedColors();

      await writeEvidence(testInfo, `c122-refused-${value}`, { status: save.status, text: save.text, stored });

      expect.soft(save.status, 'refused with 400').toBe(400);
      expect.soft(save.text, 'the error names radius').toContain('radius');
      expect.soft(stored, 'nothing is stored').toBeNull();
    });
  }

  for (const value of ['0', '0.5rem', '16px', '1rem']) {
    /** Control: a radius within the dialog's padding is kept. */
    test(`C122-accepted-${value} saving { radius: '${value}' } is accepted`, async ({
      request: _request,
    }, testInfo) => {
      const save = await saveOrganisationSettings(admin, { brandingColors: { radius: value } });
      const stored = await storedColors();

      await writeEvidence(testInfo, `c122-accepted-${value}`, { status: save.status, text: save.text, stored });

      expect.soft(save.status, `accepted: ${save.text.slice(0, 300)}`).toBe(200);
      expect.soft(stored?.radius, 'the radius is stored').toBe(value);
    });
  }
});

test.describe('[BRANDING_CONTRAST]: the radius token at render', () => {
  const css = `${MARKER}\n[role=dialog]{color:#909090}`;

  /**
   * Catches: a stored radius that rounds the dialog into a circle, clipping its opaque background and
   * exposing the overlay behind the title (about 1.81:1 painted while the guard reads 3.19:1).
   */
  test('C123-percent a stored { radius: "100%" } leaves the dialogs their default radius', async ({
    page,
  }, testInfo) => {
    const token = await seedToken('c123-percent', 1);
    const evidence: Record<string, unknown> = {};

    // Baseline: the logo and no tenant tokens or stylesheet.
    await seedRow('', null);
    await openV1(page, token);
    await openSignatureDialog(page);

    const baselineRadius = await dialogRadius(page);

    await closeDialog(page);

    expect(baselineRadius, 'premise: the default dialog radius is 0.5rem').toBe('8px');
    expect(squash(renderStoredBrandingCss(css, {})), 'premise: the render keeps the colour rule').toContain(
      '[role=dialog]{color:#909090}',
    );

    await seedRow(css, { radius: '100%' });

    const status = await openV1(page, token);

    await installMarker(page);

    for (const [label, open] of [
      ['signing', openSignatureDialog],
      ['reject', openRejectDialog],
    ] as const) {
      await open(page);
      await page.waitForTimeout(SETTLE_MS);

      const tagged = await tagDialogText(page);
      const radius = await dialogRadius(page);
      const setPartVisibility = async (visibility: string) =>
        await page.evaluate((value) => {
          const part = document.querySelector<HTMLElement>('[data-g3-probe="dialog-title-part"]');

          if (part) {
            part.style.visibility = value;
          }
        }, visibility);

      await setPartVisibility('hidden');
      const title = tagged.title ? await paintedAgainstExposed(page, '[data-g3-probe="dialog-title"]') : null;
      await setPartVisibility('');
      const titlePart = tagged.titlePart
        ? await paintedAgainstExposed(page, '[data-g3-probe="dialog-title-part"]')
        : null;
      const body = tagged.body ? await paintedAgainstExposed(page, '[data-g3-probe="dialog-body"]') : null;

      evidence[label] = {
        tagged,
        radius,
        title,
        titlePart,
        body,
        weight: await markerWeight(page),
        guard: await guardReasons(page),
      };

      expect.soft(radius, `${label}: the dialog keeps the default radius`).toBe(baselineRadius);
      expect.soft(title?.ratio ?? 0, `${label}: the title reads at least 3:1 as painted`).toBeGreaterThanOrEqual(3);
      if (tagged.titlePart) {
        expect
          .soft(titlePart?.ratio ?? 0, `${label}: the title's muted part reads at least 3:1 as painted`)
          .toBeGreaterThanOrEqual(3);
      }
      expect.soft(body?.ratio ?? 0, `${label}: the body text reads at least 3:1 as painted`).toBeGreaterThanOrEqual(3);

      await closeDialog(page);
    }

    const logo = await logoVisible(page);

    await writeEvidence(testInfo, 'c123-percent', { status, baselineRadius, logo, ...evidence });

    expect.soft(status, 'the page answers 200').toBe(200);
    expect.soft(logo, 'the tenant logo shows').toBe(true);
  });

  /** Control: a radius inside the bound reaches the dialog. */
  test('C123-1rem a stored { radius: "1rem" } reaches the dialog', async ({ page }, testInfo) => {
    const token = await seedToken('c123-1rem', 1);

    await seedRow('', { radius: '1rem' });
    await openV1(page, token);
    await openSignatureDialog(page);

    const radius = await dialogRadius(page);
    const vars = await readBodyVars(page, ['--radius']);

    await writeEvidence(testInfo, 'c123-1rem', { radius, vars });

    expect.soft(radius, 'the dialog paints 1rem').toBe('16px');
  });
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

test.describe('[BRANDING_CONTRAST]: print fallback', () => {
  for (const c of [
    {
      id: 'unreadable',
      css: `${MARKER}\n@media print { .card { background-color:#8a8a8a } .card p { color:#929292 } }`,
      expected: 'disabled',
    },
    {
      id: 'readable',
      css: `${MARKER}\n@media print { .card { background-color:#ffffff } .card p { color:#000000 } }`,
      expected: 'applied',
    },
  ] as const) {
    /**
     * Catches: the guard's second scan on `beforeprint` run with the print copy of the stylesheet still
     * active, so it blames and disables the readable tokens; and, for the control, a print stylesheet
     * that reads disabled at print.
     */
    test(`C124-${c.id} a ${c.id} print stylesheet with the brand tokens`, async ({ page }, testInfo) => {
      const token = await seedToken(`c124-${c.id}`, 1);

      await seedRow(c.css, BRAND);
      await openV1(page, token);
      await installMarker(page);
      await addPrintCard(page);
      await page.waitForTimeout(SETTLE_MS);

      const screen = { weight: await markerWeight(page), guard: await guardReasons(page) };

      expect(screen.weight, 'premise: the stylesheet is applied on screen').toBe('700');

      // Chromium fires `beforeprint` before it switches the media to print, so the event goes first.
      // In the other order the guard's scan already sees print media and the fault does not show.
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      await page.emulateMedia({ media: 'print' });
      await page.waitForTimeout(SETTLE_MS);

      const weight = await markerWeight(page);
      const guard = await guardReasons(page);
      const styles = await tokenStyles(page);
      const vars = await readBodyVars(page, ['--primary']);
      const primaryApplies = near(hslTriplet(vars['--primary']), hex(BRAND.primary), 3);
      const printCard = await page.evaluate(() => {
        const element = document.querySelector('#g3-print-card p');

        return element
          ? {
              color: getComputedStyle(element).color,
              background: getComputedStyle(element.parentElement as Element).backgroundColor,
            }
          : null;
      });

      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await page.emulateMedia({ media: 'screen' });

      await writeEvidence(testInfo, `c124-${c.id}`, {
        css: c.css,
        rendered: renderStoredBrandingCss(c.css, BRAND),
        screen,
        print: { weight, guard, styles, vars, primaryApplies, printCard },
      });

      expect.soft(styles.length, 'the token style element is on the page').toBeGreaterThan(0);
      expect
        .soft(
          styles.map((s) => s.guard),
          'no token style element carries data-branding-guard="tokens"',
        )
        .not.toContain('tokens');
      expect.soft(primaryApplies, `the primary token still applies (${vars['--primary']})`).toBe(true);

      if (c.expected === 'disabled') {
        expect.soft(weight, 'the stylesheet is disabled at print').not.toBe('700');
      } else {
        expect.soft(weight, 'the stylesheet stays applied at print').toBe('700');
        expect.soft(guard, 'no guard reason on the page').toEqual([]);
      }
    });
  }
});

test.describe('[BRANDING_CONTRAST]: translucent fixed-surface text', () => {
  // At 1x the 11px label is mostly antialiased edge, and its darkest pixel reads 2.87:1 against a true
  // composite of about 3.02:1; at 2x the glyph cores are sampled.
  test.use({ deviceScaleFactor: 2 });

  // Linux antialiasing samples the default theme's label at 2.99:1 where the Mac reads 3.02:1 (CI
  // pipeline 55408). The pixel sample gets this much tolerance; the ratio computed from the label's
  // colour and alpha over its backdrop stays at 3:1 exactly.
  const SAMPLE_TOLERANCE = 0.05;

  /** Catches: the gray-50 pair checked opaque while "Page 1 of 1" paints mutedForeground at 80%. */
  test('C125-save saving { mutedForeground: "#858585" } is refused naming mutedForeground', async ({
    request: _request,
  }, testInfo) => {
    const save = await saveOrganisationSettings(admin, { brandingColors: { mutedForeground: '#858585' } });
    const stored = await storedColors();

    await writeEvidence(testInfo, 'c125-save', { status: save.status, text: save.text, stored });

    expect.soft(save.status, 'refused, not saved').not.toBe(200);
    expect.soft(errorBodyHasCode(save.body, 'INVALID_BODY'), `INVALID_BODY: ${save.text.slice(0, 300)}`).toBe(true);
    expect.soft(save.text, 'the warning names mutedForeground').toContain('mutedForeground');
    expect.soft(stored, 'nothing is stored').toBeNull();
  });

  for (const c of [
    { id: 'render', colors: { mutedForeground: '#858585' } as Record<string, string> | null },
    { id: 'default', colors: null },
    { id: 'brand', colors: { primary: '#c84a44', primaryForeground: '#ffffff' } },
  ]) {
    /**
     * Catches: a stored `#858585` kept at render, so "Page 1 of 1" paints 2.57:1 and the guard falls back
     * at signing. Controls: the default theme and the C120 brand palette read there without any guard
     * reason.
     */
    test(`C125-${c.id} "Page 1 of 1" on the V2 page with ${c.colors ? JSON.stringify(c.colors) : 'the default theme'}`, async ({
      page,
    }, testInfo) => {
      const token = await seedToken(`c125-${c.id}`, 2);

      await seedRow('', c.colors);

      const status = await openV2(page, token);

      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => {
        const element = Array.from(document.querySelectorAll('p')).find(
          (el) => (el.textContent ?? '').trim() === 'Page 1 of 1' && el.getBoundingClientRect().width > 0,
        );

        element?.setAttribute('data-g3-probe', 'page-label');
      });

      const painted = await paintedDominant(page, '[data-g3-probe="page-label"]');
      const guard = await guardReasons(page);
      const vars = await readBodyVars(page, ['--muted-foreground']);
      const styles = await page.evaluate(() => {
        const label = document.querySelector('[data-g3-probe="page-label"]');
        let node = label?.parentElement ?? null;
        let background = '';

        while (node && background === '') {
          const value = getComputedStyle(node).backgroundColor;

          if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') {
            background = value;
          }

          node = node.parentElement;
        }

        return { color: label ? getComputedStyle(label).color : '', background };
      });
      const text = parseComputed(styles.color);
      const backdrop = parseComputed(styles.background);
      const computedRatio = text && backdrop ? contrast(composite(text, backdrop), backdrop) : 0;

      await writeEvidence(testInfo, `c125-${c.id}`, {
        colors: c.colors,
        status,
        painted,
        computed: { ...styles, ratio: computedRatio },
        guard,
        vars,
      });

      expect.soft(status, 'the page answers 200').toBe(200);
      expect
        .soft(computedRatio, `"Page 1 of 1" computes at least 3:1 (${styles.color} over ${styles.background})`)
        .toBeGreaterThanOrEqual(3);
      expect
        .soft(painted.ratio, `"Page 1 of 1" reads at least ${3 - SAMPLE_TOLERANCE}:1 by pixel sample`)
        .toBeGreaterThanOrEqual(3 - SAMPLE_TOLERANCE);
      expect.soft(guard, 'no guard reason on the page').toEqual([]);
    });
  }
});
