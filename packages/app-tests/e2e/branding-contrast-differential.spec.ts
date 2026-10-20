/**
 * The contrast checker reads colours the way the browser does.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md alone.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 27        | C27 two-sided sweep against #ffffff                                   |
 * | 27        | C27 two-sided sweep against #000000                                   |
 * | 28        | C28 the browser reading of every refused form in 11, 12 and 15        |
 *
 * C27 holds its own table, from the CSS Color Module Level 4 named-colour list (section
 * 6.1) and the evaluable syntaxes of criteria 14 and 24, and never asks the server what a
 * value means. One save stores one rule per entry against a fixed background. For each
 * entry the table's contrast decides the outcome: at least 3:1 must be kept (no contrast
 * warning, rule still in the stored CSS, and the browser's computed `color` equal to the
 * table value); below 3:1 must be refused (contrast warning, rule gone). Entries the
 * spec calls unevaluable (`currentColor` in `color`, `transparent`) must be refused on
 * both sides. A checker that refuses every name, or keeps a value it misreads, fails.
 *
 * C28 asserts nothing about the values; it records what Chromium computes for each
 * refused form through a test-owned <style>, as evidence that refusing them was safe.
 */
import { expect, test } from '@playwright/test';

import {
  type AdminSession,
  addProbes,
  browserComputes,
  type CssCase,
  composite,
  contrast,
  contrastWarningFor,
  expectCanary,
  hex,
  keepsCheckedDeclaration,
  keepsDeclarationsUnchanged,
  openAdminSession,
  openSigningPage,
  parseComputed,
  type Rgba,
  readability,
  readComputed,
  readOrganisationBranding,
  resetBranding,
  saveCss,
  screenshot,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'differential');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

// CSS Color Module Level 4, section 6.1, "Named Colors".
const NAMED: Record<string, string> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
};

type Entry = { value: string; colour: Rgba | null };

/** Syntaxes from criteria 14 and 24, at black and at white, each with the colour it denotes. */
const SYNTAXES: Entry[] = ['0', 'f'].flatMap((d) => {
  const n = d === '0' ? 0 : 255;
  const pct = d === '0' ? '0%' : '100%';
  const c = { r: n, g: n, b: n, a: 1 };

  return [
    { value: `#${d}${d}${d}`, colour: c },
    { value: `#${d.repeat(6)}`, colour: c },
    { value: `#${d}${d}${d}f`, colour: c },
    { value: `#${d.repeat(6)}ff`, colour: c },
    { value: `rgb(${n},${n},${n})`, colour: c },
    { value: `rgb(${n} ${n} ${n})`, colour: c },
    { value: `rgba(${n},${n},${n},1)`, colour: c },
    { value: `hsl(0,0%,${pct})`, colour: c },
    { value: `hsl(0deg 0% ${pct})`, colour: c },
    { value: `rgb(${n} ${n} ${n} / 0.5)`, colour: { ...c, a: 0.5 } },
  ];
});

const ENTRIES: Entry[] = [
  ...Object.entries(NAMED).map(([value, code]) => ({ value, colour: hex(code) })),
  { value: 'RebeccaPurple', colour: hex(NAMED.rebeccapurple) },
  { value: 'NAVY', colour: hex(NAMED.navy) },
  ...SYNTAXES,
  // Unevaluable in `color`: refused whatever the background.
  { value: 'transparent', colour: null },
  { value: 'currentColor', colour: null },
];

const sweep = async (
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  background: string,
) => {
  const side = background === '#ffffff' ? 'w' : 'b';
  const base = hex(background);

  const cases = ENTRIES.map((entry, position) => {
    // Zero-padded so no selector is a prefix of another.
    const index = String(position).padStart(3, '0');

    const ratio = entry.colour === null ? 0 : contrast(composite(entry.colour, base), base);

    return {
      entry,
      ratio,
      case: {
        id: `sw-${side}-${index}`,
        selector: `.g3-sw-${side}-${index}`,
        css: `.g3-sw-${side}-${index} { color: ${entry.value}; background-color: ${background}; }`,
        expected: ratio >= 3 ? 'kept' : 'refused',
      } as CssCase,
    };
  });

  const save = await saveCss(admin, cases.map((c) => c.case.css).join('\n'));
  const stored = await readOrganisationBranding(admin);
  const token = await seedSigningToken(admin, `c27-${side}`);

  await openSigningPage(page, token, 'light');
  await expectCanary(page);

  const selectors = await addProbes(
    page,
    cases.map((c) => c.case),
  );

  const results = [];

  for (const c of cases) {
    const computed = await readComputed(page, selectors[c.case.id]);
    const warning = contrastWarningFor(save.cssWarnings, c.case.selector);
    const kept = keepsCheckedDeclaration(stored.brandingCss, c.case.selector);

    results.push({
      value: c.entry.value,
      tableRatio: c.ratio,
      expected: c.case.expected,
      kept,
      warning,
      computed: computed.color,
    });

    if (c.case.expected === 'kept') {
      expect
        .soft(warning, `${c.entry.value} on ${background} (${c.ratio.toFixed(2)}): no contrast warning`)
        .toBeUndefined();
      expect
        .soft(
          keepsDeclarationsUnchanged(stored.brandingCss, c.case.selector, [`color: ${c.entry.value}`]),
          `${c.entry.value} on ${background} (${c.ratio.toFixed(2)}): kept in the stored CSS`,
        )
        .toBe(true);

      const actual = parseComputed(computed.color);
      const want = c.entry.colour as Rgba;
      const same =
        actual !== null &&
        Math.abs(actual.r - want.r) <= 1 &&
        Math.abs(actual.g - want.g) <= 1 &&
        Math.abs(actual.b - want.b) <= 1 &&
        Math.abs(actual.a - want.a) <= 0.01;

      expect
        .soft(same, `${c.entry.value}: the browser computes ${computed.color}, the table says ${JSON.stringify(want)}`)
        .toBe(true);
      expect
        .soft(readability(computed).ratio, `${c.entry.value} on ${background}: readable in the browser`)
        .toBeGreaterThanOrEqual(3);
    } else {
      expect.soft(warning, `${c.entry.value} on ${background} (${c.ratio.toFixed(2)}): contrast warning`).toBeDefined();
      expect
        .soft(kept, `${c.entry.value} on ${background} (${c.ratio.toFixed(2)}): gone from the stored CSS`)
        .toBe(false);
    }
  }

  await screenshot(page, testInfo, `c27-${side}`);
  await writeEvidence(testInfo, `c27-${side}`, {
    response: save.body,
    storedCss: stored.brandingCss,
    summary: {
      entries: results.length,
      expectedKept: results.filter((r) => r.expected === 'kept').length,
      expectedRefused: results.filter((r) => r.expected === 'refused').length,
      actuallyKept: results.filter((r) => r.kept).length,
    },
    results,
  });
};

test.describe('[BRANDING_CONTRAST]: the checker and the browser agree on colours', () => {
  test('C27 two-sided sweep against #ffffff', async ({ page }, testInfo) => {
    await sweep(page, testInfo, '#ffffff');
  });

  test('C27 two-sided sweep against #000000', async ({ page }, testInfo) => {
    await sweep(page, testInfo, '#000000');
  });

  test('C28 the browser reading of every refused form in 11, 12 and 15', async ({ page }, testInfo) => {
    const forms = [
      // Criterion 11
      'color: r\\65 d',
      'color: \\23 fff',
      'color: rgb(\\31 0, 0, 0)',
      'c\\6flor: #fff',
      // Criterion 12
      'color: #f/**/ff',
      'color: re/**/d',
      'background-color: #fff/**/',
      // Criterion 15
      'color: oklch(1 0 0)',
      'color: lab(100 0 0)',
      'color: lch(100 0 0)',
      'color: hwb(0 100% 0%)',
      'color: color(srgb 1 1 1)',
      'color: color-mix(in srgb, white, white)',
      'color: Canvas',
      'color: CanvasText',
      'color: rgb(none 0 0)',
    ];

    const token = await seedSigningToken(admin, 'c28');
    const evidence: Record<string, unknown> = {};

    for (const mode of ['light', 'dark-media'] as const) {
      await openSigningPage(page, token, mode);
      evidence[mode] = {
        baseline: await browserComputes(page, ['font-weight: 400']),
        forms: await browserComputes(page, forms),
      };
    }

    await writeEvidence(testInfo, 'c28-browser-readings', evidence);

    expect(Object.keys((evidence.light as { forms: object }).forms)).toHaveLength(forms.length);
  });
});
