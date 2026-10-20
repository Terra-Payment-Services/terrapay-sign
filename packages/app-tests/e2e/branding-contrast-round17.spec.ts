/**
 * No tenant radii, and background opacity proven rather than assumed (round 17).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 17: no tenant
 * radii, and opacity proven not assumed", without reading the sanitiser, the guard or its measurement.
 *
 * | Criterion | Test                                                                          |
 * | --------- | ----------------------------------------------------------------------------- |
 * | 102       | C102 Codex round 16's corner radius, saved and painted                        |
 * | 102       | C102-each each radius property beside .keep, at save and render               |
 * | 102       | C102-stored a raw stored row loses its radii on the signing page              |
 * | 103       | C103 unproven background colours dropped; C103-controls hwb and lab recorded  |
 * | 104       | the radius declarations in sanitize-branding-css.test.ts restated as drops    |
 *
 * `.keep` is `.keep{background-color:#fff;color:#000}`, as in round 16. C103 departs from the spec's
 * literal "`color:#000` is kept"; see the comment above `asIfNeverWritten`.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  baseUrl,
  contrast,
  openAdminSession,
  type Rgba,
  readability,
  readComputed,
  resetBranding,
  saveOrganisationSettings,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round17');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
const MARKER = '.g3-marker{font-weight:700}';
const KEEP = '.keep{background-color:#fff;color:#000}';
const SETTLE_MS = 3_000;
const RADII = [
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
];

const squash = (css: string) => css.replace(/\s+/g, '');

const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));

const storedCss = async () =>
  squash(
    (await prisma.organisationGlobalSettings.findUniqueOrThrow({ where: { id: admin.organisationGlobalSettingsId } }))
      .brandingCss ?? '',
  );

const seedRow = async (css: string) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: css, brandingColors: TOKENS },
  });
};

/** The declarations of the first block whose selector is exactly `selector`, whitespace removed. */
const blockOf = (css: string, selector: string) => {
  const start = css.indexOf(`${squash(selector)}{`);

  if (start === -1) {
    return null;
  }

  const open = start + squash(selector).length + 1;

  return css.slice(open, css.indexOf('}', open));
};

/** The `value` warnings that name `property` and sit on `line` of the submitted stylesheet. */
const valueWarningsFor = (
  warnings: { kind: string; detail: string; line?: number }[],
  property: string,
  line: number,
) => warnings.filter((w) => w.kind === 'value' && w.detail.includes(`"${property}"`) && w.line === line);

const openSigning = async (page: Page, token: string) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(page.getByRole('button', { name: 'Reject Document' }).first()).toBeVisible({ timeout: 30_000 });

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

/**
 * The painted contrast of an element's title: the backgrounds are sampled from a screenshot of its box
 * (every colour covering at least 5% of it, the text's own colour excepted), and the text colour is the
 * element's computed colour, which must appear among the pixels. The ratio is the lowest between the
 * text and any of those backgrounds, which is what a clipped background exposes behind part of the
 * title. Decoded on a blank page in the same context, which has no CSP to refuse the data URL.
 */
const paintedContrast = async (page: Page, selector: string) => {
  const computed = await page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  const png = await page.locator(selector).first().screenshot({ animations: 'disabled' });
  const blank = await page.context().newPage();

  try {
    const pixels = await blank.evaluate(async (data) => {
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
    const counts = new Map<string, number>();

    for (const p of pixels) {
      const key = p.join(',');

      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    const toRgba = (key: string): Rgba => {
      const [r, g, b] = key.split(',').map(Number);

      return { r, g, b, a: 1 };
    };
    const [cr, cg, cb] = (computed.match(/[\d.]+/g) ?? []).map(Number);
    const text: Rgba = { r: cr, g: cg, b: cb, a: 1 };
    const textSeen = pixels.some(
      ([pr, pg, pb]) => Math.abs(pr - cr) <= 8 && Math.abs(pg - cg) <= 8 && Math.abs(pb - cb) <= 8,
    );
    const backgrounds = ranked
      .filter(([, n]) => n >= pixels.length * 0.05)
      .map(([key]) => toRgba(key))
      .filter((b) => contrast(text, b) >= 1.2);
    const ratio = Math.min(...backgrounds.map((b) => contrast(text, b)));

    return { ratio, text, computed, textSeen, against: backgrounds, pixels: pixels.length };
  } finally {
    await blank.close();
  }
};

const dialogRadius = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.querySelector('[role=dialog]');

    return element ? getComputedStyle(element).borderTopLeftRadius : 'no-dialog';
  });

const openReject = async (page: Page) => {
  await page.getByRole('button', { name: 'Reject Document' }).first().click();
  await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
};

test.describe('[BRANDING_CONTRAST]: no tenant radii', () => {
  /**
   * Catches: a corner radius that clips the dialog's opaque background and exposes the overlay behind
   * part of the title (about 1.81:1 against #909090) while the guard's ancestor-chain reader reports
   * 3.19:1; the drop costing `color:#909090` or the close-button rule. The painted ratio comes from
   * screen pixels, as Codex measured it, because the oracle shares the guard's blind spot.
   */
  test('C102 the dialog corner radius is dropped and the title reads as painted', async ({ page }, testInfo) => {
    const dialog = '[role=dialog]{border-top-left-radius:100%;color:#909090}';
    const close = '[data-testid=btn-dialog-close]{background-color:#fff;color:#000}';
    const css = `${MARKER}\n${dialog}\n${close}`;
    const token = await seedSigningToken(admin, 'c102');
    const title = '[role=dialog] h2';

    // Premise: the pixel reader sees the default title above 3:1 with no tenant stylesheet.
    await openSigning(page, token);
    await openReject(page);

    const baseline = await paintedContrast(page, title);
    const baselineRadius = await dialogRadius(page);

    expect(baseline.textSeen, 'premise: the title colour is among the painted pixels').toBe(true);
    expect(baseline.ratio, 'premise: the default title reads above 3:1 as painted').toBeGreaterThanOrEqual(
      BRANDING_CONTRAST_THRESHOLD,
    );

    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    // The raw payload as a stored row, so the page shows what the render makes of it.
    await seedRow(css);

    const status = await openSigning(page, token);

    await installMarker(page);
    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const weight = await markerWeight(page);
    const painted = await paintedContrast(page, title);
    const oracle = readability(await readComputed(page, title));
    const radius = await dialogRadius(page);

    await writeEvidence(testInfo, 'c102', {
      status,
      save: { status: save.status, warnings: save.cssWarnings },
      stored,
      rendered,
      baseline,
      markerWeight: weight,
      painted,
      oracle,
      baselineRadius,
      radius,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect
      .soft(
        save.cssWarnings.filter((w) => w.kind === 'property' && w.detail.includes('border-top-left-radius')),
        'a property warning names border-top-left-radius',
      )
      .toHaveLength(1);

    for (const [where, text] of [
      ['saved', stored],
      ['rendered', rendered],
    ] as const) {
      expect.soft(text, `${where}: no radius survives`).not.toContain('radius');
      expect.soft(blockOf(text, '[role=dialog]'), `${where}: the colour is kept`).toBe('color:#909090');
      expect.soft(text, `${where}: the close-button rule is kept`).toContain(squash(close));
    }

    expect.soft(painted.textSeen, 'the title colour is among the painted pixels').toBe(true);
    expect.soft(radius, 'the dialog paints its own corner radius, not the tenant one').toBe(baselineRadius);
    expect
      .soft(
        weight !== '700' || painted.ratio >= BRANDING_CONTRAST_THRESHOLD,
        `the title reads at least 3:1 as painted (${painted.ratio.toFixed(2)}:1), or the stylesheet is disabled (marker ${weight})`,
      )
      .toBe(true);
  });

  /**
   * Catches: any one of the five radius properties kept at save or render; the drop without the
   * `property` warning; the whole rule or `.keep` lost with it.
   */
  test('C102-each every radius property is dropped beside .keep', async ({ request: _request }, testInfo) => {
    const rules = RADII.map((property, i) => `.r102-${i}{${property}:100%;border-color:rgb(1, 2, 3)}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c102-each', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);

    RADII.forEach((property, i) => {
      expect
        .soft(
          save.cssWarnings.filter((w) => w.kind === 'property' && w.detail.includes(property) && w.line === i + 2),
          `a property warning names ${property} on line ${i + 2}`,
        )
        .toHaveLength(1);

      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        const block = blockOf(text, `.r102-${i}`);

        expect.soft(block, `${where}: ${property} is dropped, border-color kept`).toBe('border-color:rgb(1,2,3)');
      }
    });
  });

  /**
   * Catches: a row stored before round 17 keeping its radii on the signing page because only the save
   * path drops them. Reads the tenant stylesheet the page carries and the computed radius of a probe.
   */
  test('C102-stored a raw stored row loses its radii on the signing page', async ({ page }, testInfo) => {
    const rules = RADII.map((property, i) => `.r102s-${i}{${property}:50%;border-color:rgb(1, 2, 3)}`);
    const css = [KEEP, ...rules].join('\n');
    const token = await seedSigningToken(admin, 'c102-stored');

    await seedRow(css);
    await openSigning(page, token);
    // The tenant <style> can arrive after the Reject button does; one run in round 19's controls read
    // the page before it.
    await expect
      .poll(
        async () =>
          await page.evaluate(() =>
            [...document.querySelectorAll('style')].some((s) => s.textContent?.includes('.keep')),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    const found = await page.evaluate((count) => {
      const sheets = [...document.querySelectorAll('style')]
        .map((s) => s.textContent ?? '')
        .filter((text) => text.includes('.keep'));
      const radii: string[] = [];

      for (let i = 0; i < count; i++) {
        const probe = document.createElement('div');

        probe.className = `r102s-${i}`;
        probe.style.width = '40px';
        probe.style.height = '40px';
        document.querySelector('.documenso-branded')?.appendChild(probe);
        const style = getComputedStyle(probe);

        radii.push(
          [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomLeftRadius,
            style.borderBottomRightRadius,
          ].join(' '),
        );
      }

      return { sheets, radii, branded: Boolean(document.querySelector('.documenso-branded')) };
    }, RADII.length);

    await writeEvidence(testInfo, 'c102-stored', { css, rendered: render(css), found });

    expect(found.branded, 'premise: the page has the branded wrapper').toBe(true);
    expect(found.sheets.length, 'premise: the tenant stylesheet is on the page').toBeGreaterThan(0);
    expect.soft(found.sheets.join('\n'), 'the page stylesheet carries no radius').not.toContain('radius');

    for (const [i, value] of found.radii.entries()) {
      expect.soft(value, `${RADII[i]}: the probe paints square corners`).toBe('0px 0px 0px 0px');
    }
  });
});

test.describe('[BRANDING_CONTRAST]: background opacity proven, not assumed', () => {
  const UNPROVEN = [
    'color-mix(in srgb,white 10%,black 10%)',
    'rgb(from #fff r g b / 0.5)',
    'hwb(0 0% 0% / 0.5)',
    'lab(50 0 0 / 0.5)',
    'Canvas',
    '#fffff',
    'rgb(0 0 0 / none)',
  ];

  /**
   * The spec's form, `.x{background-color:<v>;color:#000;border-color:red}`, is judged "as if the
   * declaration were never written", and a lone `color:#000` fails the dark themes, so the render check
   * drops it there too (`renderStoredBrandingCss('.x{color:#000;border-color:red}', ...)` returns
   * `.x{border-color:red}` at d48303cce). Each black rule is therefore held to whatever its
   * background-free twin renders to, and a grey twin (`color:#909090`, which survives alone in every
   * theme) carries the spec's "`color` and `border-color` are kept" literally.
   */
  const asIfNeverWritten = (selector: string, text: string) =>
    blockOf(render(`${selector}{color:${text};border-color:red}`), selector);

  /**
   * Catches: an unreadable colour treated as opaque, which passes the round 16 gate and lets the
   * contrast check remove the whole rule's colours with it; a drop with no `value` warning, or one that
   * names neither the property nor the line.
   */
  test('C103 unproven background colours are dropped and the rest of the rule is kept', async ({
    request: _request,
  }, testInfo) => {
    const rules = [
      ...UNPROVEN.map((value, i) => `.u103-${i}{background-color:${value};color:#000;border-color:red}`),
      ...UNPROVEN.map((value, i) => `.g103-${i}{background-color:${value};color:#909090;border-color:red}`),
    ];
    const css = rules.join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c103', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
      asIfNeverWritten: UNPROVEN.map((_, i) => asIfNeverWritten(`.u103-${i}`, '#000')),
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);

    UNPROVEN.forEach((value, i) => {
      const black = asIfNeverWritten(`.u103-${i}`, '#000');

      for (const line of [i + 1, i + 1 + UNPROVEN.length]) {
        expect
          .soft(
            valueWarningsFor(save.cssWarnings, 'background-color', line),
            `${value}: a value warning on line ${line}`,
          )
          .toHaveLength(1);
      }

      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect
          .soft(blockOf(text, `.u103-${i}`), `${where}: ${value} dropped, the rest judged as if it were never written`)
          .toBe(black);
        expect
          .soft(blockOf(text, `.u103-${i}`) ?? '', `${where}: ${value} keeps border-color`)
          .toContain('border-color:red');
        expect
          .soft(blockOf(text, `.g103-${i}`), `${where}: ${value} dropped, color:#909090 and border-color kept`)
          .toBe('color:#909090;border-color:red');
      }
    });
  });

  /**
   * Control: `hwb(0 0% 0%)` (red, 5.25:1 under black) and `lab(100 0 0)` (white) are opaque. If the
   * parser reads them they are kept whole with no warning; if it cannot, the background is dropped with
   * a `value` warning and the rest judged as if it were never written. The evidence records which.
   */
  test('C103-controls opaque hwb and lab are kept, or dropped alone, and recorded', async ({
    request: _request,
  }, testInfo) => {
    const CONTROLS = ['hwb(0 0% 0%)', 'lab(100 0 0)'];
    const rules = CONTROLS.map((value, i) => `.c103-${i}{background-color:${value};color:#000;border-color:red}`);
    const css = rules.join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);
    const outcome = CONTROLS.map((value, i) => {
      const block = blockOf(stored, `.c103-${i}`);

      return {
        value,
        block,
        outcome: block === squash(`background-color:${value};color:#000;border-color:red`) ? 'kept' : 'dropped',
        warnings: save.cssWarnings.filter((w) => w.line === i + 1),
      };
    });

    await writeEvidence(testInfo, 'c103-controls', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
      outcome,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);

    CONTROLS.forEach((value, i) => {
      const kept = squash(`background-color:${value};color:#000;border-color:red`);
      const alone = asIfNeverWritten(`.c103-${i}`, '#000');

      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect
          .soft([kept, alone], `${where}: ${value} is kept whole or dropped alone`)
          .toContain(blockOf(text, `.c103-${i}`));
      }

      if (outcome[i].outcome === 'kept') {
        expect.soft(outcome[i].warnings, `${value} kept: no warning`).toEqual([]);
      } else {
        expect
          .soft(valueWarningsFor(save.cssWarnings, 'background-color', i + 1), `${value} dropped: a value warning`)
          .toHaveLength(1);
      }
    });
  });
});
