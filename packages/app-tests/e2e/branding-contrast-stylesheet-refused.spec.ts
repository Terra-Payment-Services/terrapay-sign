/**
 * Branding stylesheet pairs that hide signing-page labels are refused at save.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md alone, without the
 * contrast checker it specifies. Each test saves rules as the organisation admin through
 * `organisation.settings.update` (criterion 21 through `team.settings.update`), reads the
 * row back, opens a pending document's signing page as the recipient and measures probe
 * elements with getComputedStyle. A refused pair must come back as a `contrast` warning,
 * be absent from the stored CSS, and leave the probe at 3:1 or better; the save itself
 * still answers 200 (spec 2.4, flag F4). The canary `button { border-color: rgb(1, 2, 3) }`
 * proves the stylesheet reached the page. Evidence (submitted and stored CSS, response,
 * computed styles, screenshot) is written under the test's output directory.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 1         | C1 same-rule equal pair                                               |
 * | 2         | C2 near-equal pair                                                    |
 * | 3         | C3 #959595 on white refused, #949494 kept                             |
 * | 4         | C4 transparent foreground, paired and lone                            |
 * | 5         | C5 low alpha in four syntaxes                                         |
 * | 6         | C6 translucent background composited                                  |
 * | 7         | C7 currentColor as a background                                       |
 * | 8         | C8 CSS-wide keywords on either side                                   |
 * | 9         | C9 var() refused, no contrast regression                              |
 * | 10        | C10 !important pair                                                   |
 * | 11        | C11 escaped values and property, with the browser's reading           |
 * | 12        | C12 comments splitting values                                         |
 * | 13        | C13 uppercase                                                         |
 * | 14        | C14 every evaluable syntax at an unreadable pair                      |
 * | 15        | C15 unevaluable syntaxes in a pair                                    |
 * | 16        | C16 gradients                                                         |
 * | 17        | C17 duplicate declarations                                            |
 * | 18, 33    | C18 lone declarations against the base page, light and both darks     |
 * | 19        | C19 icons                                                             |
 * | 20        | C20 inside @media                                                     |
 * | 21        | C21 team route                                                        |
 *
 * C18's `* { color: #fff }` is already dropped by the universal-selector rule, before any
 * contrast check can see it, so that entry accepts a `selector` warning in place of a
 * `contrast` one. `.g3-c18-lone { color: #fff }` is added as the same lone white text
 * on a selector the sanitiser does accept.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { expect, test } from '@playwright/test';

import {
  type AdminSession,
  ALL_MODES,
  blocksFor,
  browserComputes,
  type CssCase,
  openAdminSession,
  readOrganisationBranding,
  resetBranding,
  runStylesheetCases,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'stylesheet-refused');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

/** A refused same-rule pair on a class probe. */
const pair = (id: string, declarations: string, extra: Partial<CssCase> = {}): CssCase => ({
  id,
  selector: `.g3-${id}`,
  css: `.g3-${id} { ${declarations} }`,
  expected: 'refused',
  ...extra,
});

test.describe('[BRANDING_CONTRAST]: unreadable stylesheet pairs are refused at save', () => {
  test('C1 same-rule equal pair', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c1',
      cases: [pair('c1', 'color: #ffffff; background-color: #ffffff;')],
    });
  });

  test('C2 near-equal pair', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c2',
      cases: [pair('c2', 'color: #fefefe; background-color: #ffffff;')],
    });
  });

  test('C3 #959595 on white refused, #949494 kept', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c3',
      cases: [
        pair('c3-refuse', 'color: #959595; background-color: #ffffff;'),
        {
          ...pair('c3-keep', 'color: #949494; background-color: #ffffff;'),
          expected: 'kept',
          keep: ['color: #949494', 'background-color: #ffffff'],
        },
      ],
    });
  });

  test('C4 transparent foreground, paired and lone', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c4',
      cases: [pair('c4-pair', 'color: transparent; background-color: #fff;'), pair('c4-lone', 'color: transparent;')],
    });
  });

  test('C5 low alpha in four syntaxes', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c5',
      cases: [
        pair('c5-rgba', 'color: rgba(0, 0, 0, 0.1); background-color: #ffffff;'),
        pair('c5-rgb-slash', 'color: rgb(0 0 0 / 0.4); background-color: #ffffff;'),
        pair('c5-hex8', 'color: #0000001a; background-color: #ffffff;'),
        pair('c5-hsl', 'color: hsl(0 0% 0% / 10%); background-color: #ffffff;'),
      ],
    });
  });

  test('C6 translucent background composited', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c6',
      // Round 16 (C100): a translucent or keyword tenant background is now dropped by the opaque-background
      // rule rather than paired by the contrast check, so the warning need not be `contrast`. The case
      // still asserts that no checked colour survives and that the probe reads at least 3:1.
      cases: [pair('c6', 'color: #fff; background-color: rgba(255, 255, 255, 0.9);', { contrastWarning: false })],
    });
  });

  test('C7 currentColor as a background', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c7',
      // Round 16 (C100): a translucent or keyword tenant background is now dropped by the opaque-background
      // rule rather than paired by the contrast check, so the warning need not be `contrast`. The case
      // still asserts that no checked colour survives and that the probe reads at least 3:1.
      cases: [
        {
          id: 'c7-button',
          selector: 'button',
          css: 'button { color: #213871; background-color: currentColor; }',
          expected: 'refused',
          probe: 'reject',
          contrastWarning: false,
        },
        pair('c7-lone', 'background: currentcolor;', { contrastWarning: false }),
      ],
    });
  });

  test('C8 CSS-wide keywords on either side', async ({ page }, testInfo) => {
    const keywords = ['inherit', 'initial', 'unset', 'revert', 'revert-layer'];

    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c8',
      cases: [
        ...keywords.map((keyword) => pair(`c8-color-${keyword}`, `color: ${keyword}; background-color: #ffffff;`)),
        // Round 16 (C100): the inherit background is dropped by the opaque-background rule; see C6.
        pair('c8-bg-inherit', 'color: #ffffff; background-color: inherit;', { contrastWarning: false }),
      ],
    });
  });

  test('C9 var() refused, no contrast regression', async ({ page }, testInfo) => {
    // The existing function allowlist refuses var(); this confirms the declaration is gone
    // and the probe readable. It does not require a contrast warning, since var() is
    // dropped before any pair exists.
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c9',
      cases: [
        pair('c9-var', 'color: var(--background);', { contrastWarning: false }),
        pair('c9-var-fallback', 'color: var(--x, #fff);', { contrastWarning: false }),
      ],
    });
  });

  test('C10 !important pair', async ({ page }, testInfo) => {
    const run = await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c10',
      cases: [pair('c10', 'color: #fff !important; background-color: #fff;')],
    });

    expect.soft(run.storedCss.toLowerCase(), 'stored CSS has no !important').not.toContain('!important');
  });

  test('C11 escaped values and property, with the browser reading', async ({ page }, testInfo) => {
    const declarations = {
      'c11-ident': 'color: r\\65 d; background-color: red;',
      'c11-hash': 'color: \\23 fff;',
      'c11-number': 'color: rgb(\\31 0, 0, 0); background-color: #000;',
      'c11-property': 'c\\6flor: #fff; background: #fff;',
    };

    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c11',
      cases: Object.entries(declarations).map(([id, declaration]) => pair(id, declaration)),
    });

    // What the browser makes of each escaped form on its own, through a test-owned
    // <style>, so the evidence shows which reading a naive decoder would get wrong.
    const forms = ['color: r\\65 d', 'color: \\23 fff', 'color: rgb(\\31 0, 0, 0)', 'c\\6flor: #fff'];
    const computed = await browserComputes(page, forms);
    const inherited = await browserComputes(page, ['font-weight: 400']);

    await writeEvidence(testInfo, 'c11-browser-reading', { computed, inherited });

    expect.soft(computed['color: r\\65 d'].color, 'browser: r\\65 d is the ident red').toBe('rgb(255, 0, 0)');
    expect.soft(computed['c\\6flor: #fff'].color, 'browser: c\\6flor is the property color').toBe('rgb(255, 255, 255)');
    expect
      .soft(computed['color: \\23 fff'].color, 'browser: \\23 fff is an ident, not a hash, so it is ignored')
      .toBe(inherited['font-weight: 400'].color);
    expect
      .soft(computed['color: rgb(\\31 0, 0, 0)'].color, 'browser: \\31 0 is an ident, so the rgb() is invalid')
      .toBe(inherited['font-weight: 400'].color);
  });

  test('C12 comments splitting values', async ({ page }, testInfo) => {
    // The first two are already refused by the existing comment rule, so no contrast
    // warning is required for them; the third is a trailing comment PostCSS strips and
    // must be refused as an equal pair.
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c12',
      cases: [
        pair('c12-hex', 'color: #f/**/ff;', { contrastWarning: false }),
        pair('c12-name', 'color: re/**/d;', { contrastWarning: false }),
        pair('c12-trailing', 'color: #fff; background-color: #fff/**/;'),
      ],
    });
  });

  test('C13 uppercase', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c13',
      cases: [
        pair('c13-upper', 'COLOR: #FFF; BACKGROUND-COLOR: WHITE;'),
        pair('c13-transparent', 'color: TRANSPARENT;'),
        pair('c13-mixed', 'Color: RGB(255, 255, 255); background-color: #fff;'),
      ],
    });
  });

  test('C14 every evaluable syntax at an unreadable pair', async ({ page }, testInfo) => {
    const values = [
      '#fff',
      '#ffffff',
      '#ffff',
      '#ffffffff',
      'rgb(255,255,255)',
      'rgb(255 255 255)',
      'rgba(255,255,255,1)',
      'hsl(0,0%,100%)',
      'hsl(0deg 0% 100%)',
      'white',
    ];

    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c14',
      cases: values.map((value, index) => pair(`c14-${index}`, `color: ${value}; background-color: #fff;`)),
    });
  });

  test('C15 unevaluable syntaxes in a pair', async ({ page }, testInfo) => {
    const values = [
      'oklch(1 0 0)',
      'lab(100 0 0)',
      'lch(100 0 0)',
      'hwb(0 100% 0%)',
      'color(srgb 1 1 1)',
      'color-mix(in srgb, white, white)',
      'Canvas',
      'CanvasText',
      'rgb(none 0 0)',
    ];

    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c15',
      cases: values.map((value, index) => pair(`c15-${index}`, `color: ${value}; background-color: #fff;`)),
    });
  });

  /**
   * Round 16 (C100): c16-transparent's translucent `background-image` stops are dropped with a `value`
   * warning naming the property and its line, and no gradient survives in the stored or rendered CSS. The lone
   * `color: #fff` that remains is white on the white page and is still refused.
   */
  test('C16 gradients', async ({ page }, testInfo) => {
    const run = await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c16',
      cases: [
        pair('c16-stop', 'color: #fff; background: linear-gradient(#fff, #000);'),
        pair('c16-transparent', 'color: #fff; background-image: linear-gradient(transparent, transparent);'),
      ],
    });

    const { brandingColors } = await readOrganisationBranding(admin);
    const rendered = renderStoredBrandingCss(run.storedCss, brandingColors);
    // The rule is the second line of the submitted stylesheet.
    const ruleLine = 2;

    await writeEvidence(testInfo, 'c16-transparent-round16', {
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
        'c16-transparent: a value warning names background-image on line 2',
      )
      .toBe(true);

    for (const [where, text] of [
      ['stored', run.storedCss],
      ['rendered', rendered],
    ] as const) {
      expect
        .soft(blocksFor(text, '.g3-c16-transparent').join(';'), `${where}: no gradient survives in .g3-c16-transparent`)
        .not.toMatch(/gradient/i);
    }
  });

  test('C17 duplicate declarations', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c17',
      cases: [pair('c17', 'color: #000; color: #fff; background-color: #fff;')],
    });
  });

  test('C18 lone declarations against the base page, light and both darks (criterion 33)', async ({
    page,
  }, testInfo) => {
    // Type selectors reach every element of that type, so each rule is saved and
    // measured on its own.
    const groups: CssCase[][] = [
      [
        {
          id: 'c18-star',
          selector: '*',
          css: '* { color: #fff; }',
          expected: 'refused',
          probe: 'div',
          className: 'g3-c18-star',
          contrastWarning: false,
        },
      ],
      [pair('c18-lone', 'color: #fff;')],
      [{ id: 'c18-label', selector: 'label', css: 'label { color: #000; }', expected: 'refused', probe: 'label' }],
      [
        {
          id: 'c18-div',
          selector: 'div',
          css: 'div { background-color: #213871; }',
          expected: 'refused',
          probe: 'div',
          className: 'g3-c18-div',
        },
      ],
    ];

    for (const [index, cases] of groups.entries()) {
      await resetBranding(admin);

      const run = await runStylesheetCases({ admin, page, testInfo, name: `c18-${index}`, cases, modes: ALL_MODES });

      if (cases[0].id === 'c18-star') {
        const warned = run.save.cssWarnings.some((w) => w.kind === 'contrast' || w.kind === 'selector');

        expect.soft(warned, 'c18-star: the universal rule is refused with a warning').toBe(true);
      }
    }
  });

  test('C19 icons', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c19',
      cases: [
        {
          ...pair('c19-stroke', 'stroke: #fff;'),
          selector: 'svg.g3-c19-stroke',
          css: 'svg.g3-c19-stroke { stroke: #fff; }',
          probe: 'stroke-icon',
        },
        {
          ...pair('c19-none', 'stroke: none;'),
          selector: 'svg.g3-c19-none',
          css: 'svg.g3-c19-none { stroke: none; }',
          probe: 'stroke-icon',
        },
        {
          ...pair('c19-fill', ''),
          selector: 'svg.g3-c19-fill',
          css: 'svg.g3-c19-fill { fill: transparent; background-color: #fff; }',
          probe: 'fill-icon',
        },
      ],
    });
  });

  test('C20 inside @media', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c20',
      cases: [
        {
          ...pair('c20', ''),
          css: '@media (min-width: 0) { .g3-c20 { color: #ffffff; background-color: #ffffff; } }',
        },
      ],
    });
  });

  test('C21 team route', async ({ page }, testInfo) => {
    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c21',
      route: 'team',
      cases: [pair('c21', 'color: #ffffff; background-color: #ffffff;')],
    });
  });
});
