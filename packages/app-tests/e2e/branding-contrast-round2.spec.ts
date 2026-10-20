/**
 * Branding contrast, behaviours added after Codex round 2.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 2", without reading the checker. The round 2 decision: gradients are no longer
 * evaluated, so a rule setting a checked text colour together with any gradient background,
 * well-formed or not, has that pair dropped with a contrast warning.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 45        | C45 a text colour with any gradient background is dropped             |
 * | 46        | C46 non-finite numeric colours are not measurable                     |
 * | 47        | C47 a large stylesheet is checked in bounded time and memory          |
 * | 48        | C48 a warning for an unevaluable pair names both values               |
 *
 * C47's memory probe is the resident set size of the process listening on the server's
 * port (`fixtures/branding-server-probes.ts`: `lsof` or `/proc`, then `ps` or `/proc`), read
 * from the test host. It needs the server on the same machine as the test, which the campaign
 * stacks and the CI job are. Its time budgets are relative to a baseline save and load taken in
 * the same test (amendment after CI pipeline 55408).
 */
import { expect, test } from '@playwright/test';

import {
  type AdminSession,
  ALL_MODES,
  baseUrl,
  browserComputes,
  type CssCase,
  openAdminSession,
  openSigningPage,
  resetBranding,
  runStylesheetCases,
  saveOrganisationSettings,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';
import {
  loadBudgetMs,
  measureBaselineLoad,
  measureBaselineSave,
  saveBudgetMs,
  serverRss,
} from './fixtures/branding-server-probes';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round2');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const NINES = '9'.repeat(400);

const MALFORMED_GRADIENTS = [
  'linear-gradient(to to,white,white)',
  'linear-gradient(90px,white,white)',
  'linear-gradient(white 1deg,white 2deg)',
  'linear-gradient(1px white,2px white)',
  'radial-gradient(to right,white,white)',
  'conic-gradient(white 1px,white 2px)',
  'linear-gradient(white,white),',
];

const gradientCase = (id: string, declaration: string): CssCase => ({
  id,
  selector: `.g3-${id}`,
  css: `.g3-${id} { color: black; ${declaration} }`,
  expected: 'refused',
});

/** Runs `action` while sampling server RSS every 25 ms; returns its duration and the peak. */
const measured = async <T>(action: () => Promise<T>) => {
  let peak = (await serverRss()).kib;
  let running = true;

  const sampler = (async () => {
    while (running) {
      peak = Math.max(peak, (await serverRss()).kib);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();

  const started = Date.now();
  const result = await action();
  const ms = Date.now() - started;

  running = false;
  await sampler;
  peak = Math.max(peak, (await serverRss()).kib);

  return { result, ms, peakKib: peak };
};

const RSS_GROWTH_BUDGET_KIB = 200 * 1024;

test.describe('[BRANDING_CONTRAST]: Codex round 2', () => {
  test('C45 a text colour with any gradient background is dropped', async ({ page }, testInfo) => {
    const cases = [
      ...MALFORMED_GRADIENTS.map((gradient, index) =>
        gradientCase(`c45-malformed-${index}`, `background: ${gradient};`),
      ),
      gradientCase('c45-image-malformed', 'background-image: linear-gradient(to to,white,white);'),
      gradientCase('c45-well-formed', 'background-image: linear-gradient(white, white);'),
    ];

    const token = await seedSigningToken(admin, 'c45-browser');

    await openSigningPage(page, token, 'light');

    const computed = await browserComputes(
      page,
      MALFORMED_GRADIENTS.map((gradient) => `background: ${gradient};`),
    );

    await writeEvidence(testInfo, 'c45-browser', computed);

    for (const [declaration, value] of Object.entries(computed)) {
      expect.soft(value.backgroundImage, `browser discards ${declaration}`).toBe('none');
    }

    await runStylesheetCases({ admin, page, testInfo, name: 'c45', cases, modes: ALL_MODES });
  });

  test('C46 non-finite numeric colours are not measurable', async ({ page }, testInfo) => {
    const colours = {
      'c46-hue-overflow': `hsl(${NINES} 100% 50%)`,
      'c46-hue-negative': `hsl(-${NINES} 100% 50%)`,
      'c46-hue-exponent': 'hsl(9e999 100% 50%)',
      'c46-channel-overflow': `rgb(${NINES} 0 0)`,
      'c46-alpha-overflow': `rgb(255 0 0 / ${NINES})`,
    };

    const token = await seedSigningToken(admin, 'c46-browser');

    await openSigningPage(page, token, 'light');

    const computed = await browserComputes(
      page,
      Object.values(colours).map((colour) => `color: ${colour};`),
    );

    await writeEvidence(testInfo, 'c46-browser', computed);

    expect(computed[`color: ${colours['c46-hue-overflow']};`].color, 'Chromium paints the hue overflow red').toBe(
      'rgb(255, 0, 0)',
    );

    const cases: CssCase[] = Object.entries(colours).map(([id, colour]) => ({
      id,
      selector: `.g3-${id}`,
      css: `.g3-${id} { color: ${colour}; background: red; }`,
      expected: 'refused',
    }));

    await runStylesheetCases({ admin, page, testInfo, name: 'c46', cases });
  });

  test('C47 a large stylesheet is checked in bounded time and memory', async ({ page }, testInfo) => {
    const css = `p{color:black;${'background-color:white;'.repeat(11000)}}`;

    expect(Buffer.byteLength(css), 'just under 256 KiB').toBeLessThan(256 * 1024);

    const token = await seedSigningToken(admin, 'c47');
    const baselineLoad = await measureBaselineLoad(page, token);
    const baselineSaveMs = await measureBaselineSave(admin);
    const before = await serverRss();
    const save = await measured(async () => await saveOrganisationSettings(admin, { brandingCss: css }));
    const loads = [];

    for (let i = 0; i < 3; i++) {
      loads.push(
        await measured(async () => (await page.goto(`${baseUrl}/sign/${token}`, { waitUntil: 'commit' }))?.status()),
      );
    }

    await writeEvidence(testInfo, 'c47', {
      bytes: Buffer.byteLength(css),
      pid: before.pid,
      baselineRssKib: before.kib,
      baselineLoad,
      baselineSaveMs,
      saveBudgetMs: saveBudgetMs(baselineSaveMs),
      loadBudgetMs: loadBudgetMs(baselineLoad.ms),
      save: { status: save.result.status, ms: save.ms, peakRssKib: save.peakKib },
      pageLoads: loads.map((l) => ({ status: l.result, ms: l.ms, peakRssKib: l.peakKib })),
      warnings: save.result.cssWarnings.slice(0, 5),
    });

    expect.soft(save.result.status, 'the save is answered, not failed').toBeLessThan(500);
    expect
      .soft(save.ms, `the save answers within the ${baselineSaveMs} ms baseline save plus 200 ms`)
      .toBeLessThan(saveBudgetMs(baselineSaveMs));

    for (const [index, load] of loads.entries()) {
      expect
        .soft(load.ms, `signing page load ${index + 1} within twice the ${baselineLoad.ms} ms baseline plus 100 ms`)
        .toBeLessThan(loadBudgetMs(baselineLoad.ms));
    }

    const peak = Math.max(save.peakKib, ...loads.map((l) => l.peakKib));

    expect
      .soft(peak - before.kib, `server RSS grows by under ${RSS_GROWTH_BUDGET_KIB / 1024} MiB`)
      .toBeLessThan(RSS_GROWTH_BUDGET_KIB);
  });

  test('C48 a warning for an unevaluable pair names both values', async ({ page }, testInfo) => {
    const run48 = await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c48',
      cases: [
        {
          id: 'c48-canvastext',
          selector: '.g3-c48-canvastext',
          css: '.g3-c48-canvastext { color: CanvasText; background: white; }',
          expected: 'refused',
        },
      ],
    });

    const warning = run48.save.cssWarnings.find((w) => w.detail.includes('.g3-c48-canvastext'));
    const detail = (warning?.detail ?? '').toLowerCase();

    expect.soft(detail, 'the warning names CanvasText').toContain('canvastext');
    expect.soft(detail, 'the warning names white').toContain('white');
  });
});
