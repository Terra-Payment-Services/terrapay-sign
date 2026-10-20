/**
 * Opaque tenant backgrounds and settled opacity (round 16).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 16: opaque tenant
 * backgrounds and settled opacity", without reading the sanitiser, the guard or its measurement.
 *
 * | Criterion | Test                                                                         |
 * | --------- | ---------------------------------------------------------------------------- |
 * | 97        | C97 Codex round 15's exposed backdrop, painted and by the oracle             |
 * | 98        | C98-<property> translucent and keyword backgrounds dropped; C98-kept controls |
 * | 99        | C99-<colour>-<dialog> the entrance animation with animations on              |
 * | 100       | earlier specs restated (round 10 C68, stylesheet-refused C6, C7, C8)        |
 * | 101       | C101-dropped, C101-gradients (round 2 rule), C101-kept-image-none            |
 *
 * `.keep` is `.keep{background-color:#fff;color:#000}`, not the spec's `.keep{background-color:#fff}`:
 * a lone white background is checked against the dark default foreground and the render check drops it
 * (`renderStoredBrandingCss('.keep{background-color:#fff}', ...)` returns `.keep{}` at d13c13290), so
 * the spec's form could never be "kept".
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { type Browser, expect, type Page, test } from '@playwright/test';

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
  admin = await openAdminSession(browser, testInfo, 'round16');
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
const GUARD_WAIT_MS = 8_000;
const SETTLE_MS = 3_000;

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

const waitForDisabled = async (page: Page) => {
  const deadline = Date.now() + GUARD_WAIT_MS;
  let weight = await markerWeight(page);

  while (weight === '700' && Date.now() < deadline) {
    await page.waitForTimeout(250);
    weight = await markerWeight(page);
  }

  return weight;
};

/**
 * The painted contrast of an element's text, from a screenshot of its box: the most common pixel is
 * taken as the background, the pixel farthest from it in luminance as the text. Decoded on a blank
 * page in the same context, which has no CSP to refuse the data URL.
 */
const paintedContrast = async (page: Page, selector: string) => {
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

    const [r, g, b] = [...counts.entries()]
      .sort((x, y) => y[1] - x[1])[0][0]
      .split(',')
      .map(Number);
    const background: Rgba = { r, g, b, a: 1 };
    let text = background;
    let best = 1;

    for (const [pr, pg, pb] of pixels) {
      const candidate: Rgba = { r: pr, g: pg, b: pb, a: 1 };
      const ratio = contrast(candidate, background);

      if (ratio > best) {
        best = ratio;
        text = candidate;
      }
    }

    return { ratio: best, background, text, pixels: pixels.length };
  } finally {
    await blank.close();
  }
};

const openReject = async (page: Page) => {
  await page.getByRole('button', { name: 'Reject Document' }).first().click();
  await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
};

test.describe('[BRANDING_CONTRAST]: opaque tenant backgrounds', () => {
  /**
   * Catches: a `transparent` dialog background reaching the stored or rendered stylesheet, which
   * exposes the app's overlay (a sibling the ancestor-chain reader never paints) behind the title; the
   * drop costing the rule's other declarations; a guard that judges the title by the ancestor chain
   * (3.19:1) while the signer sees about 1.81:1. The painted ratio comes from screen pixels, not the
   * oracle, because the oracle has the same blind spot as the guard.
   */
  test('C97 the exposed dialog backdrop is dropped and the title reads as painted', async ({ page }, testInfo) => {
    const rule = '[role=dialog]{background-color:transparent;color:#909090}';
    const css = `${MARKER}\n${rule}`;
    const token = await seedSigningToken(admin, 'c97');

    // Premise: the pixel reader reads the title on a page with no tenant stylesheet.
    await openSigning(page, token);
    await openReject(page);

    const title = '[role=dialog] h2';
    const baseline = await paintedContrast(page, title);

    expect(baseline.ratio, 'premise: the pixel reader sees the default title above 3:1').toBeGreaterThanOrEqual(
      BRANDING_CONTRAST_THRESHOLD,
    );

    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await seedRow(css);

    const status = await openSigning(page, token);

    await installMarker(page);
    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const weight = await markerWeight(page);
    const painted = await paintedContrast(page, title);
    const oracle = readability(await readComputed(page, title));

    await writeEvidence(testInfo, 'c97', {
      status,
      save: { status: save.status, warnings: save.cssWarnings },
      stored,
      rendered,
      baseline,
      markerWeight: weight,
      painted,
      oracle,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(save.cssWarnings.length, 'a warning for the dropped declaration').toBeGreaterThanOrEqual(1);
    expect.soft(blockOf(stored, '[role=dialog]'), 'saved: transparent is dropped').not.toContain('transparent');
    expect.soft(blockOf(stored, '[role=dialog]'), 'saved: the colour is kept').toContain('color:#909090');
    expect.soft(blockOf(rendered, '[role=dialog]'), 'rendered: transparent is dropped').not.toContain('transparent');
    expect.soft(blockOf(rendered, '[role=dialog]'), 'rendered: the colour is kept').toContain('color:#909090');
    expect
      .soft(
        weight !== '700' || painted.ratio >= BRANDING_CONTRAST_THRESHOLD,
        `the title reads at least 3:1 as painted (${painted.ratio.toFixed(2)}:1), or the stylesheet is disabled (marker ${weight})`,
      )
      .toBe(true);
    expect
      .soft(
        weight !== '700' || oracle.ratio >= BRANDING_CONTRAST_THRESHOLD,
        `the title reads at least 3:1 by the oracle (${oracle.ratio.toFixed(2)}:1), or the stylesheet is disabled`,
      )
      .toBe(true);
  });

  const DROPPED_VALUES = [
    'transparent',
    'rgba(0,0,0,0.5)',
    'hsla(0,0%,0%,.5)',
    '#0008',
    '#00000080',
    'currentcolor',
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
  ];

  /**
   * The text colour paired in each rule makes the translucent forms pass the round 1 contrast check on
   * their own (white over half-black in both themes; mid-grey over a transparent background in both
   * themes), so a drop shows the new rule, not the contrast check. `border-color` is the declaration
   * that must stay ("the rule's other declarations are kept").
   */
  const textFor = (value: string) => (value === 'transparent' ? '#808080' : '#fff');

  for (const property of ['background-color', 'background']) {
    /**
     * Catches: a translucent or keyword background kept at save or render under either property; the
     * whole rule dropped instead of the one declaration; `.keep` lost; a drop with no warning.
     */
    test(`C98-${property} translucent and keyword values are dropped, .keep and other declarations stay`, async ({
      request: _request,
    }, testInfo) => {
      const rules = DROPPED_VALUES.map(
        (value, i) => `.d98-${i}{${property}:${value};color:${textFor(value)};border-color:rgb(1, 2, 3)}`,
      );
      const css = [KEEP, ...rules].join('\n');
      const save = await saveOrganisationSettings(admin, { brandingCss: css });
      const stored = await storedCss();
      const rendered = render(css);

      await writeEvidence(testInfo, `c98-${property}`, {
        css,
        status: save.status,
        warnings: save.cssWarnings,
        stored,
        rendered,
      });

      expect.soft(save.status, 'the save answers 200').toBe(200);
      expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
      expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);
      expect
        .soft(save.cssWarnings.length, `a warning per dropped declaration (${DROPPED_VALUES.length})`)
        .toBeGreaterThanOrEqual(DROPPED_VALUES.length);

      DROPPED_VALUES.forEach((value, i) => {
        const declaration = squash(`${property}:${value}`).toLowerCase();

        for (const [where, css2] of [
          ['saved', stored],
          ['rendered', rendered],
        ] as const) {
          const block = blockOf(css2, `.d98-${i}`);

          expect.soft(block, `${where}: .d98-${i} keeps its rule`).not.toBeNull();
          expect
            .soft((block ?? '').toLowerCase(), `${where}: ${property}:${value} is dropped`)
            .not.toContain(declaration);
          expect
            .soft(block ?? '', `${where}: border-color is kept beside ${value}`)
            .toContain('border-color:rgb(1,2,3)');
        }
      });
    });
  }

  const KEPT_VALUES: { value: string; text: string }[] = [
    { value: '#fff', text: '#000' },
    { value: '#ffffffff', text: '#000' },
    { value: 'rgb(0 0 0)', text: '#fff' },
    { value: 'rgba(0,0,0,1)', text: '#fff' },
    { value: 'hsl(0 0% 100% / 1)', text: '#000' },
  ];

  /**
   * Catches: an opacity check that refuses opaque values written with an alpha channel of 1, or the
   * space syntax, or eight-digit hex; any warning for a readable opaque pair. Expected to pass on
   * round 15 code: the control for C98.
   */
  test('C98-kept opaque backgrounds are kept with no warning', async ({ request: _request }, testInfo) => {
    const rules = ['background-color', 'background'].flatMap((property, p) =>
      KEPT_VALUES.map((k, i) => `.k98-${p}-${i}{${property}:${k.value};color:${k.text}}`),
    );
    const css = rules.join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c98-kept', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(save.cssWarnings, 'no warning').toEqual([]);

    for (const rule of rules) {
      expect.soft(stored, `saved: ${rule} is kept`).toContain(squash(rule));
      expect.soft(rendered, `rendered: ${rule} is kept`).toContain(squash(rule));
    }
  });
});

test.describe('[BRANDING_CONTRAST]: opaque gradient stops and background shorthand', () => {
  const DROPPED: { id: string; declaration: string }[] = [
    { id: 'grad-transparent', declaration: 'background:linear-gradient(transparent,transparent)' },
    { id: 'image-hex4', declaration: 'background-image:linear-gradient(#0000,#0000)' },
    { id: 'grad-half', declaration: 'background:linear-gradient(#fff,rgba(0,0,0,.5))' },
    { id: 'none', declaration: 'background:none' },
  ];

  /**
   * Catches: a translucent or keyword gradient stop kept in `background` or `background-image`; a
   * `background` shorthand that paints nothing opaque (`background:none`) kept, which resets the colour
   * to transparent and exposes what lies beneath; the whole rule dropped instead of the declaration;
   * `.keep` lost. The gradient forms are already dropped at d13c13290 by the round 2 decision (a text
   * colour with any gradient loses its pair), so on unfixed code only `background:none` is red.
   */
  test('C101-dropped translucent gradient stops and background:none are dropped', async ({
    request: _request,
  }, testInfo) => {
    const rules = DROPPED.map((d) => `.d101-${d.id}{${d.declaration};color:#808080;border-color:rgb(1, 2, 3)}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c101-dropped', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);
    expect
      .soft(save.cssWarnings.length, `a warning per dropped declaration (${DROPPED.length})`)
      .toBeGreaterThanOrEqual(DROPPED.length);

    for (const d of DROPPED) {
      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        const block = blockOf(text, `.d101-${d.id}`) ?? '';

        expect.soft(block, `${where}: ${d.declaration} is dropped`).not.toContain(squash(d.declaration));
        expect
          .soft(block, `${where}: border-color is kept beside ${d.declaration}`)
          .toContain('border-color:rgb(1,2,3)');
      }
    }
  });

  /**
   * Catches: a shorthand rule so broad that `background-image:none`, which leaves the colour alone,
   * is dropped. Control, expected green on unfixed code.
   */
  test('C101-kept-image-none background-image:none is kept with no warning', async ({
    request: _request,
  }, testInfo) => {
    const rule = '.k101-none{background-image:none;border-color:rgb(1, 2, 3)}';
    const save = await saveOrganisationSettings(admin, { brandingCss: rule });
    const stored = await storedCss();
    const rendered = render(rule);

    await writeEvidence(testInfo, 'c101-kept-image-none', {
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(save.cssWarnings, 'no warning').toEqual([]);
    expect.soft(stored, 'saved: kept').toContain(squash(rule));
    expect.soft(rendered, 'rendered: kept').toContain(squash(rule));
  });

  /**
   * C101 correction: the round 2 rule ("Gradients are not evaluated") stands, so these two opaque
   * gradients are dropped by it rather than kept; round 16 adds nothing here. Expected green on unfixed
   * code, as a guard that the round 16 change does not start keeping gradients.
   *
   * Catches: an opaque-stop check that, once it passes a gradient, also lets it past the round 2 rule.
   */
  test('C101-gradients opaque gradients are still dropped by the round 2 rule', async ({
    request: _request,
  }, testInfo) => {
    const rules = [
      { selector: '.k101-a', css: '.k101-a{background:linear-gradient(#fff,#eee);color:#000}' },
      {
        selector: '.k101-b',
        css: '.k101-b{background-image:linear-gradient(#fff,#eee);background-color:#fff;color:#000}',
      },
    ];
    const css = [KEEP, ...rules.map((r) => r.css)].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c101-gradients', {
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(save.cssWarnings.length, 'a warning for the dropped gradients').toBeGreaterThanOrEqual(1);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);

    for (const rule of rules) {
      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect
          .soft(blockOf(text, rule.selector) ?? '', `${where}: ${rule.selector} has no gradient`)
          .not.toContain('gradient');
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
// C99: animations on
// ---------------------------------------------------------------------------------------

/**
 * A context with animations enabled: no `reducedMotion` and no `__disable_animations` cookie, which
 * playwright.config.ts sets for every other test.
 */
const animatedPage = async (browser: Browser) => {
  const context = await browser.newContext({
    reducedMotion: 'no-preference',
    storageState: { cookies: [], origins: [] },
  });

  return { context, page: await context.newPage() };
};

const DIALOGS: { id: string; trigger: (page: Page) => ReturnType<Page['locator']> }[] = [
  { id: 'reject', trigger: (page) => page.getByRole('button', { name: 'Reject Document' }).first() },
  { id: 'signature', trigger: (page) => page.locator('[data-field-type=SIGNATURE]') },
];

/**
 * Opens a dialog and samples the dialog's and the close button's computed opacity every frame for
 * 400 ms, so the test can show an entrance animation ran.
 */
const openAndSample = async (page: Page, dialog: (typeof DIALOGS)[number]) => {
  await dialog.trigger(page).click();

  // A string, not a function: the test bundler names inner functions with a `__name` helper the page lacks.
  const samples = (await page.evaluate(`new Promise((resolve) => {
    let minDialog = 1;
    let animations = 0;
    const started = performance.now();
    requestAnimationFrame(function tick() {
      const element = document.querySelector('[role=dialog]');
      if (element) {
        minDialog = Math.min(minDialog, Number(getComputedStyle(element).opacity));
        animations = Math.max(animations, element.getAnimations({ subtree: true }).length);
      }
      if (performance.now() - started < 400) {
        requestAnimationFrame(tick);
      } else {
        resolve({ minDialog, animations });
      }
    });
  })`)) as { minDialog: number; animations: number };

  await expect(page.getByRole('dialog')).toBeVisible();

  return samples;
};

const closeDialog = async (page: Page) => {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(500);
};

test.describe('[BRANDING_CONTRAST]: settled opacity, animations on', () => {
  for (const dialog of DIALOGS) {
    /**
     * Catches: a guard that judges the close icon mid-entrance, when the dialog's animation (from
     * opacity 0.9) times the button's 0.7 dips a 3.42:1 icon below 3:1, and so disables a readable
     * stylesheet. The test runs with animations on, which every other test turns off.
     */
    test(`C99-595959-${dialog.id} a readable close icon stays applied through three entrance animations`, async ({
      browser,
    }, testInfo) => {
      const css = `${MARKER}\n[data-testid=btn-dialog-close]{background-color:#fff;color:#595959}`;

      expect(render(css), 'premise: the rule survives the render check').toContain('color:#595959');
      await seedRow(css);

      const token = await seedSigningToken(admin, `c99-595959-${dialog.id}`);
      const { context, page } = await animatedPage(browser);
      const runs: unknown[] = [];

      try {
        await openSigning(page, token);
        await installMarker(page);

        const environment = await page.evaluate(() => ({
          reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
          cookie: document.cookie.includes('__disable_animations'),
        }));

        expect(environment, 'premise: animations are enabled in this context').toEqual({
          reduced: false,
          cookie: false,
        });

        for (let run = 0; run < 3; run++) {
          const samples = await openAndSample(page, dialog);

          await page.waitForTimeout(SETTLE_MS);

          const weight = await markerWeight(page);

          runs.push({ run, samples, markerWeight: weight });
          expect.soft(samples.minDialog, `premise: run ${run + 1} saw the entrance animation`).toBeLessThan(1);
          expect.soft(weight, `run ${run + 1}: the stylesheet stays applied`).toBe('700');
          await closeDialog(page);
        }
      } finally {
        await writeEvidence(testInfo, `c99-595959-${dialog.id}`, { environment: 'animations on', runs });
        await context.close();
      }
    });

    /**
     * Catches: a guard that, to survive the entrance animation, stops judging the close icon at all, so
     * an icon unreadable once settled (2.14:1) keeps its stylesheet. Each run is a fresh page load,
     * since a disable lasts for the page.
     */
    test(`C99-909090-${dialog.id} an unreadable close icon is disabled after each entrance animation`, async ({
      browser,
    }, testInfo) => {
      const css = `${MARKER}\n[data-testid=btn-dialog-close]{background-color:#fff;color:#909090}`;

      expect(render(css), 'premise: the rule survives the render check').toContain('color:#909090');
      await seedRow(css);

      const token = await seedSigningToken(admin, `c99-909090-${dialog.id}`);
      const { context, page } = await animatedPage(browser);
      const runs: unknown[] = [];

      try {
        for (let run = 0; run < 3; run++) {
          await openSigning(page, token);
          await installMarker(page);

          const before = await markerWeight(page);
          const samples = await openAndSample(page, dialog);
          const weight = await waitForDisabled(page);

          runs.push({ run, before, samples, markerWeight: weight });
          expect.soft(before, `premise: run ${run + 1} starts applied`).toBe('700');
          expect.soft(samples.minDialog, `premise: run ${run + 1} saw the entrance animation`).toBeLessThan(1);
          expect.soft(weight, `run ${run + 1}: the stylesheet is disabled`).not.toBe('700');
        }
      } finally {
        await writeEvidence(testInfo, `c99-909090-${dialog.id}`, { environment: 'animations on', runs });
        await context.close();
      }
    });
  }
});
