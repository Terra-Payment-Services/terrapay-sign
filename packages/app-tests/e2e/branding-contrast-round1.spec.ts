/**
 * Branding contrast, behaviours added after Codex round 1.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 1", without reading the checker. Each colour pair here must be refused
 * (tokens) or dropped with a contrast warning (stylesheet) and must not reach the signing
 * page. As in the other specs, readability is measured on what the browser computes,
 * with gradients sampled along their interpolation and image layers composited.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 36        | C36 a background the browser discards is not a painted background     |
 * | 37        | C37 colour syntax CSS rejects is not a colour                         |
 * | 38, 45    | C38 gradient pairs are dropped                                        |
 * | 38        | C38 control: the oracle samples interpolation and stacked layers      |
 * | 39        | C39 tokens checked as rendered                                        |
 * | 40        | C40 a team stylesheet is checked against the inherited organisation   |
 * | 41        | C41 the admin sees the contrast reason in the organisation form       |
 * | 41        | C41 the admin sees the contrast reason in the team form               |
 * | 42        | C42 the warning names both offending colour values                    |
 *
 * Criterion 43 (C32 under a forced interleaving) lives in
 * branding-contrast-render-time.spec.ts beside C32.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { prisma } from '@documenso/prisma';
import { expect, type Page, type TestInfo, test } from '@playwright/test';

import {
  type AdminSession,
  ALL_MODES,
  baseUrl,
  blocksFor,
  browserComputes,
  contrastWarningFor,
  errorBodyHasCode,
  hex,
  hslTriplet,
  keepsDeclarationsUnchanged,
  measureTestOwned,
  near,
  openAdminSession,
  openSigningPage,
  type Rgba,
  readability,
  readBodyVars,
  readOrganisationBranding,
  resetBranding,
  runStylesheetCases,
  saveCss,
  saveOrganisationSettings,
  screenshot,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round1');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const KELVIN = 'K';
const DOTLESS_I = 'ı';
const NBSP = ' ';

test.describe('[BRANDING_CONTRAST]: Codex round 1', () => {
  test('C36 a background the browser discards is not a painted background', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c36',
      modes: ALL_MODES,
      cases: [
        {
          id: 'c36-image',
          selector: '.g3-c36-image',
          css: '.g3-c36-image { color: black; background-image: white; }',
          expected: 'refused',
        },
        {
          id: 'c36-shorthand',
          selector: '.g3-c36-shorthand',
          css: '.g3-c36-shorthand { color: black; background: white white; }',
          expected: 'refused',
        },
      ],
    });

    // The premise, from the browser: both backgrounds are discarded.
    const computed = await browserComputes(page, ['background-image: white', 'background: white white']);

    await writeEvidence(testInfo, 'c36-browser-reading', computed);

    expect
      .soft(computed['background-image: white'].backgroundImage, 'browser discards background-image: white')
      .toBe('none');
    expect
      .soft(computed['background: white white'].backgroundColor, 'browser discards background: white white')
      .toBe('rgba(0, 0, 0, 0)');
  });

  test('C37 colour syntax CSS rejects is not a colour', async ({ page }, testInfo) => {
    const kelvin = `blac${KELVIN}`;
    const dotless = `wh${DOTLESS_I}te`;
    const nbsp = `rgb(0${NBSP}0${NBSP}0)`;

    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c37',
      modes: ALL_MODES,
      cases: [
        {
          id: 'c37-kelvin',
          selector: '.g3-c37-kelvin',
          css: `.g3-c37-kelvin { color: ${kelvin}; background-color: #ffffff; }`,
          expected: 'refused',
        },
        {
          id: 'c37-dotless',
          selector: '.g3-c37-dotless',
          css: `.g3-c37-dotless { color: ${dotless}; background-color: #000000; }`,
          expected: 'refused',
        },
        {
          id: 'c37-nbsp',
          selector: '.g3-c37-nbsp',
          css: `.g3-c37-nbsp { color: ${nbsp}; background-color: #ffffff; }`,
          expected: 'refused',
        },
        // Control: ASCII case folding is real CSS, so blacK is black and readable on white.
        {
          id: 'c37-ascii',
          selector: '.g3-c37-ascii',
          css: '.g3-c37-ascii { color: blacK; background-color: #ffffff; }',
          expected: 'kept',
          keep: ['color: blacK', 'background-color: #ffffff'],
        },
      ],
    });

    // What the real browser computes for each value on its own.
    const baseline = (await browserComputes(page, ['font-weight: 400']))['font-weight: 400'].color;
    const computed = await browserComputes(page, [
      `color: ${kelvin}`,
      `color: ${dotless}`,
      `color: ${nbsp}`,
      'color: blacK',
    ]);

    await writeEvidence(testInfo, 'c37-browser-reading', { baseline, computed });

    expect.soft(computed[`color: ${kelvin}`].color, 'browser: blac + KELVIN SIGN is not a colour').toBe(baseline);
    expect.soft(computed[`color: ${dotless}`].color, 'browser: wh + DOTLESS I + te is not a colour').toBe(baseline);
    expect
      .soft(computed[`color: ${nbsp}`].color, 'browser: rgb() with U+00A0 separators is not a colour')
      .toBe(baseline);
    expect.soft(computed['color: blacK'].color, 'browser: blacK is black').toBe('rgb(0, 0, 0)');
  });

  /**
   * C38-stacked restated under round 16 (C100): its translucent `background-image` stops are dropped
   * with a `value` warning naming the property and its line, and the readable `#000` on `#fff` pair that remains is kept.
   * Catches: the whole rule dropped instead of the translucent declaration; the gradient kept in the
   * stored or rendered CSS; the drop reported as anything but a `value` warning.
   */
  test('C38 gradient pairs are dropped', async ({ page }, testInfo) => {
    const stacked = 'linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45))';

    const run = await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c38',
      cases: [
        {
          id: 'c38-interpolation',
          selector: '.g3-c38-interpolation',
          css: '.g3-c38-interpolation { color: red; background: linear-gradient(black, white); }',
          expected: 'refused',
        },
        {
          id: 'c38-stacked',
          selector: '.g3-c38-stacked',
          css: `.g3-c38-stacked { color: #000; background-color: #fff; background-image: ${stacked}, ${stacked}; }`,
          expected: 'kept',
          keep: ['color: #000', 'background-color: #fff'],
        },
      ],
    });

    const { brandingColors } = await readOrganisationBranding(admin);
    const rendered = renderStoredBrandingCss(run.storedCss, brandingColors);
    // The rule is the second line of the submitted stylesheet.
    const ruleLine = 2;

    await writeEvidence(testInfo, 'c38-stacked-round16', {
      warnings: run.save.cssWarnings,
      storedCss: run.storedCss,
      rendered,
    });

    expect
      .soft(
        run.save.cssWarnings.some(
          (warning) =>
            warning.kind === 'value' && /"background-image"/.test(warning.detail) && warning.line === ruleLine,
        ),
        'c38-stacked: a value warning names background-image on line 2',
      )
      .toBe(true);

    for (const [where, text] of [
      ['stored', run.storedCss],
      ['rendered', rendered],
    ] as const) {
      const blocks = blocksFor(text, '.g3-c38-stacked');

      expect.soft(blocks.length, `${where}: the .g3-c38-stacked rule survives`).toBeGreaterThan(0);
      expect.soft(blocks.join(';'), `${where}: no gradient survives in .g3-c38-stacked`).not.toMatch(/gradient/i);
      expect
        .soft(
          keepsDeclarationsUnchanged(text, '.g3-c38-stacked', ['color: #000', 'background-color: #fff']),
          `${where}: #000 on #fff is kept in .g3-c38-stacked`,
        )
        .toBe(true);
    }
  });

  test('C38 control: the oracle samples interpolation and stacked layers', async ({ page }, testInfo) => {
    const stacked = 'linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45))';
    const token = await seedSigningToken(admin, 'c38-oracle');

    await openSigningPage(page, token, 'light');

    const interpolation = readability(
      await measureTestOwned(page, 'g3-oracle-a', 'color: red; background: linear-gradient(black, white);'),
    );
    const layers = readability(
      await measureTestOwned(
        page,
        'g3-oracle-b',
        `color: #000; background-color: #fff; background-image: ${stacked}, ${stacked};`,
      ),
    );

    await writeEvidence(testInfo, 'c38-oracle', { interpolation, layers });

    expect(interpolation.ratio, 'red on black-to-white reaches about 1:1 somewhere').toBeLessThan(1.1);
    expect(layers.ratio, 'black on white under two 45% black layers is about 2.49:1').toBeGreaterThan(2.4);
    expect(layers.ratio).toBeLessThan(2.6);
  });

  test('C39 tokens checked as rendered', async ({ page }, testInfo) => {
    const colours = { primary: 'rgb(0,166,160)', primaryForeground: '#ffffff' };

    // (a) Refused at save: 3.02:1 as written, 2.94:1 once rendered as hsl(178 100% 33%).
    const before = await readOrganisationBranding(admin);
    const save = await saveOrganisationSettings(admin, { brandingColors: colours });
    const after = await readOrganisationBranding(admin);

    expect.soft(save.status, `refused, not saved with ${save.status}`).not.toBe(200);
    expect.soft(errorBodyHasCode(save.body, 'INVALID_BODY'), `INVALID_BODY: ${save.text.slice(0, 300)}`).toBe(true);
    expect.soft(after, 'the row is unchanged').toEqual(before);

    // (b) The same pair stored directly does not reach the signing page.
    await resetBranding(admin);
    await prisma.organisationGlobalSettings.update({
      where: { id: admin.organisationGlobalSettingsId },
      data: { brandingEnabled: true, brandingColors: colours },
    });

    const token = await seedSigningToken(admin, 'c39');
    const observed: Record<string, Record<string, string>> = {};
    const rendered = hslTriplet('178 100% 33%');

    for (const mode of ['light', 'dark-media'] as const) {
      await openSigningPage(page, token, mode);

      const vars = await readBodyVars(page, ['--primary', '--primary-foreground']);

      observed[mode] = vars;

      expect
        .soft(
          near(hslTriplet(vars['--primary']), rendered as Rgba, 4),
          `[${mode}] --primary ${vars['--primary']} is not the tenant teal`,
        )
        .toBe(false);
      expect
        .soft(
          near(hslTriplet(vars['--primary']), mode === 'light' ? hex('#213871') : (hslTriplet('223 100% 69%') as Rgba)),
          `[${mode}] --primary is the default`,
        )
        .toBe(true);

      await screenshot(page, testInfo, `c39-${mode}`);
    }

    await writeEvidence(testInfo, 'c39', { response: save.body, before, after, observed });
  });

  test('C40 a team stylesheet is checked against the inherited organisation background', async ({ page }, testInfo) => {
    await prisma.organisationGlobalSettings.update({
      where: { id: admin.organisationGlobalSettingsId },
      data: {
        brandingEnabled: true,
        brandingColors: {
          // Round 22 (754b9eda4): light text cannot read on the fixed gray-50 signing surface, so the grey
          // background is lighter (#9a9a9a, on which `p { color: #707070 }` reads 1.77:1) under black text, with
          // light card, muted, widget, popover and secondary set in both themes and a dark destructive.
          background: '#9a9a9a',
          foreground: '#000000',
          mutedForeground: '#000000',
          input: '#000000',
          destructive: '#7a1f1a',
          card: '#ffffff',
          cardForeground: '#000000',
          muted: '#eeeff0',
          widget: '#f6f7f7',
          popover: '#ffffff',
          popoverForeground: '#000000',
          primary: '#213871',
          primaryForeground: '#ffffff',
          secondary: '#eeeff0',
          secondaryForeground: '#213871',
        },
      },
    });

    // Team branding on, team colours null: the team renders the organisation's background.
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c40',
      route: 'team',
      modes: ['light', 'dark-media'],
      cases: [{ id: 'c40', selector: 'p', css: 'p { color: #707070; }', expected: 'refused', probe: 'p' }],
    });
  });

  const refuseThroughForm = async (page: Page, url: string, label: string, testInfo: TestInfo) => {
    await page.goto(url);

    const save = page.getByRole('button', { name: 'Save changes' });

    await expect(save).toBeVisible({ timeout: 30_000 });

    // Primary #ffcc00 against the default white primary foreground is 1.5:1, refused.
    const trigger = page.getByText('Primary action color.', { exact: true }).locator('xpath=following::button[1]');

    await trigger.click();

    const input = page.locator('[data-radix-popper-content-wrapper] input');

    await input.fill('ffcc00');
    await input.press('Enter');
    await page.keyboard.press('Escape');

    const swatch = trigger.locator('div').first();

    await expect(swatch, 'premise: the picker shows the new colour').toHaveCSS('background-color', 'rgb(255, 204, 0)');
    await expect(save).toBeEnabled();

    const responded = page.waitForResponse((r) => r.url().includes('settings.update'));

    await save.click();

    const response = await responded;
    const body = await response.text();
    const notifications = page.getByRole('region', { name: /Notifications/ });

    await expect(notifications.getByRole('listitem').first()).toBeVisible({ timeout: 10_000 });

    const shown = (await notifications.innerText()).replace(/\s+/g, ' ');

    await screenshot(page, testInfo, `c41-${label}`);
    await writeEvidence(testInfo, `c41-${label}`, { status: response.status(), body, shown });

    expect(response.status(), `premise: the save is refused (${body.slice(0, 200)})`).not.toBe(200);
    expect.soft(shown, `${label}: the message is not "try again later"`).not.toMatch(/try again later/i);
    expect.soft(shown, `${label}: the message gives the contrast reason`).toMatch(/contrast|\d+(\.\d+)?\s*:\s*1/i);
    await expect
      .soft(swatch, `${label}: the form keeps the colour the admin chose`)
      .toHaveCSS('background-color', 'rgb(255, 204, 0)');
    await expect.soft(save, `${label}: the form is still dirty and can be saved again`).toBeEnabled();
  };

  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  test('C41 the admin sees the contrast reason in the organisation form', async ({}, testInfo) => {
    const organisation = await prisma.organisation.findUniqueOrThrow({ where: { id: admin.organisationId } });

    await refuseThroughForm(admin.page, `${baseUrl}/o/${organisation.url}/settings/branding`, 'organisation', testInfo);
  });

  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  test('C41 the admin sees the contrast reason in the team form', async ({}, testInfo) => {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: admin.teamId } });

    await prisma.teamGlobalSettings.update({
      where: { id: admin.teamGlobalSettingsId },
      data: { brandingEnabled: true },
    });

    await refuseThroughForm(admin.page, `${baseUrl}/t/${team.url}/settings/branding`, 'team', testInfo);
  });

  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  test('C42 the warning names both offending colour values', async ({}, testInfo) => {
    const save = await saveCss(
      admin,
      [
        '.g3-c42-hex { color: #fefefe; background-color: #ffffff; }',
        '.g3-c42-mixed { color: rgb(254, 254, 254); background-color: white; }',
      ].join('\n'),
    );

    await writeEvidence(testInfo, 'c42', { response: save.body });

    const expectNames = (selector: string, values: string[]) => {
      const warning = contrastWarningFor(save.cssWarnings, selector);

      expect.soft(warning, `${selector}: a contrast warning`).toBeDefined();

      const detail = (warning?.detail ?? '').toLowerCase().replace(/\s+/g, '');

      for (const value of values) {
        expect
          .soft(detail, `${selector}: the warning names ${value}`)
          .toContain(value.toLowerCase().replace(/\s+/g, ''));
      }
    };

    expectNames('.g3-c42-hex', ['#fefefe', '#ffffff']);
    expectNames('.g3-c42-mixed', ['rgb(254, 254, 254)', 'white']);
  });
});
