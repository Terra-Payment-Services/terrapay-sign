/**
 * Readable branding pairs are still accepted and rendered.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md alone. These are the
 * other side of the refusal specs: a checker that refuses too much fails here. Every
 * test in this file is expected to pass on the unfixed build as well, since nothing is
 * refused today; they guard against the fix over-reaching.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 24, 33    | C24 readable stylesheet pairs kept, light and both darks              |
 * | 25        | C25 shipped defaults and a readable primary pair accepted, rendered   |
 * | 26        | C26 rules with no checked property untouched                          |
 * | 35        | C35 cross-rule residual accepted, contrast recorded                   |
 *
 * C35 records known behaviour rather than a goal: the sanitiser cannot see which element
 * a background sits behind, so two lone rules each readable against the page can meet on
 * one element (spec section 4). The spec's own example needs a tenant `foreground` of
 * white with a light page, which the token check refuses, so the test uses colours that
 * pass every lone check in both themes: `#8a8a8a` as a card background and `#707070`
 * text inside it, 1.4:1 against each other.
 */
import { DEFAULT_BRAND_COLORS } from '@documenso/lib/constants/theme';
import { expect, test } from '@playwright/test';

import {
  type AdminSession,
  ALL_MODES,
  contrastWarningFor,
  expectCanary,
  hex,
  hslTriplet,
  keepsDeclarationsUnchanged,
  near,
  openAdminSession,
  openSigningPage,
  readability,
  readBodyVars,
  readComputed,
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
  admin = await openAdminSession(browser, testInfo, 'accepted');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

test.describe('[BRANDING_CONTRAST]: readable branding is accepted', () => {
  test('C24 readable stylesheet pairs kept, light and both darks (criterion 33)', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c24',
      modes: ALL_MODES,
      cases: [
        {
          id: 'c24-threshold',
          selector: '.g3-c24-threshold',
          css: '.g3-c24-threshold { color: #949494; background-color: #ffffff; }',
          expected: 'kept',
          keep: ['color: #949494', 'background-color: #ffffff'],
        },
        {
          id: 'c24-navy',
          selector: '.g3-c24-navy',
          css: '.g3-c24-navy { color: #ffffff; background-color: #213871; }',
          expected: 'kept',
          keep: ['color: #ffffff', 'background-color: #213871'],
        },
        {
          id: 'c24-half-alpha',
          selector: '.g3-c24-half-alpha',
          css: '.g3-c24-half-alpha { color: rgb(0 0 0 / 0.5); background-color: #ffffff; }',
          expected: 'kept',
          keep: ['color: rgb(0 0 0 / 0.5)', 'background-color: #ffffff'],
        },
        {
          id: 'c24-names',
          selector: '.g3-c24-names',
          css: '.g3-c24-names { color: red; background-color: white; }',
          expected: 'kept',
          keep: ['color: red', 'background-color: white'],
        },
        {
          id: 'c24-gradient',
          selector: '.g3-c24-gradient',
          css: '.g3-c24-gradient { color: #fff; background: linear-gradient(#000, #213871); }',
          // Codex round 2 decision (C45): a text colour with any gradient background is
          // dropped with a warning, readable or not.
          expected: 'refused',
        },
        {
          id: 'c24-stroke-current',
          selector: 'svg.g3-c24-stroke-current',
          css: 'svg.g3-c24-stroke-current { stroke: currentColor; }',
          expected: 'kept',
          probe: 'stroke-icon',
          keep: ['stroke: currentcolor'],
        },
        {
          id: 'c24-fill-none',
          selector: 'svg.g3-c24-fill-none',
          css: 'svg.g3-c24-fill-none { fill: none; }',
          expected: 'kept',
          probe: 'stroke-icon',
          keep: ['fill: none'],
        },
        {
          id: 'c24-button',
          selector: 'button',
          css: 'button { color: #fff; background-color: #213871; }',
          expected: 'kept',
          probe: 'reject',
          keep: ['color: #fff', 'background-color: #213871'],
        },
      ],
    });
  });

  test('C25 shipped defaults and a readable primary pair accepted and rendered', async ({ page }, testInfo) => {
    const defaults = { ...DEFAULT_BRAND_COLORS };
    const primaryPair = { primary: '#c84a44', primaryForeground: '#ffffff' };
    const results: Record<string, unknown> = {};

    for (const [label, colours] of Object.entries({ defaults, primaryPair })) {
      await resetBranding(admin);

      const save = await saveOrganisationSettings(admin, { brandingColors: colours });

      expect.soft(save.status, `${label}: accepted with 200: ${save.text.slice(0, 300)}`).toBe(200);

      const stored = await readOrganisationBranding(admin);

      expect.soft(stored.brandingColors, `${label}: stored as sent`).toEqual(colours);

      const token = await seedSigningToken(admin, `c25-${label}`);

      await openSigningPage(page, token, 'light');

      const vars = await readBodyVars(page, ['--primary', '--primary-foreground', '--foreground']);

      expect
        .soft(near(hslTriplet(vars['--primary']), hex(colours.primary)), `${label}: --primary ${vars['--primary']}`)
        .toBe(true);

      await screenshot(page, testInfo, `c25-${label}`);

      results[label] = { response: save.body, stored, vars };
    }

    await writeEvidence(testInfo, 'c25', results);
  });

  test('C26 rules with no checked property untouched', async ({ page }, testInfo) => {
    const save = await saveCss(admin, 'h1 { font-weight: 700; }');
    const stored = await readOrganisationBranding(admin);

    await writeEvidence(testInfo, 'c26', { response: save.body, storedCss: stored.brandingCss });

    expect
      .soft(
        save.cssWarnings.filter((w) => w.kind === 'contrast'),
        'no contrast warning',
      )
      .toEqual([]);
    expect.soft(keepsDeclarationsUnchanged(stored.brandingCss, 'button', ['border-color: rgb(1, 2, 3)'])).toBe(true);
    expect.soft(keepsDeclarationsUnchanged(stored.brandingCss, 'h1', ['font-weight: 700'])).toBe(true);

    const token = await seedSigningToken(admin, 'c26');

    await openSigningPage(page, token, 'light');
    await expectCanary(page);
  });

  test('C35 cross-rule residual accepted, contrast recorded', async ({ page }, testInfo) => {
    const css = '.g3-c35-card { background-color: #8a8a8a; }\n.g3-c35-card .g3-c35-text { color: #707070; }';
    const save = await saveCss(admin, css);
    const stored = await readOrganisationBranding(admin);

    expect.soft(contrastWarningFor(save.cssWarnings, '.g3-c35-card'), 'card rule accepted').toBeUndefined();
    expect
      .soft(keepsDeclarationsUnchanged(stored.brandingCss, '.g3-c35-card', ['background-color: #8a8a8a']))
      .toBe(true);
    expect
      .soft(keepsDeclarationsUnchanged(stored.brandingCss, '.g3-c35-card .g3-c35-text', ['color: #707070']))
      .toBe(true);

    const token = await seedSigningToken(admin, 'c35');

    await openSigningPage(page, token, 'light');
    await expectCanary(page);

    await page.evaluate(() => {
      const card = document.createElement('div');
      const text = document.createElement('div');

      card.className = 'g3-c35-card';
      text.className = 'g3-c35-text';
      text.textContent = 'Label';
      card.appendChild(text);
      document.body.appendChild(card);
    });

    const computed = await readComputed(page, '.g3-c35-text');
    const measured = readability(computed);

    await screenshot(page, testInfo, 'c35');
    await writeEvidence(testInfo, 'c35', { response: save.body, storedCss: stored.brandingCss, computed, measured });

    // The residual: accepted at save, and unreadable where the two rules meet.
    expect.soft(measured.ratio, 'the cross-rule pair renders below 3:1, as FORK.md records').toBeLessThan(3);
  });
});
