/**
 * Branding contrast, behaviours added after Codex round 4.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 4", without reading the checker.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 53        | C53 a long run of interior whitespace is checked in bounded time      |
 * | 54        | C54 a stored blank token does not reach the signing page              |
 * | 55        | C55 a stylesheet of only a control character is refused               |
 *
 * C53 and C54 seed rows directly where a save cannot store the value: C53 when the save
 * refuses it, C54 always, since the request path no longer accepts blank tokens and the
 * stored-row path still serves legacy data.
 *
 * C53's budgets were 1 s each until the amendment after CI pipeline 55408; they are now relative to
 * a baseline taken in the same test: a save within the baseline save of a one-rule stylesheet plus
 * 200 ms, a load within twice the baseline load plus 100 ms.
 */
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  ALL_MODES,
  baseUrl,
  CANARY_CSS,
  DARK_DEFAULT_TRIPLETS,
  hex,
  hslTriplet,
  LIGHT_DEFAULTS,
  measureTestOwned,
  near,
  openAdminSession,
  openSigningPage,
  type Rgba,
  readability,
  readBodyVars,
  readOrganisationBranding,
  resetBranding,
  saveOrganisationSettings,
  screenshot,
  seedSigningToken,
  THRESHOLD,
  writeEvidence,
} from './fixtures/branding-contrast';
import {
  loadBudgetMs,
  measureBaselineLoad,
  measureBaselineSave,
  saveBudgetMs,
} from './fixtures/branding-server-probes';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round4');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const LONG_VALUE = `rgb(255${' '.repeat(40000)}255 255)`;

const timed = async <T>(action: () => Promise<T>) => {
  const started = Date.now();
  const result = await action();

  return { result, ms: Date.now() - started };
};

/** Three signing-page loads, each timed to the first response byte. */
const timedLoads = async (page: Page, token: string) => {
  const loads: { status?: number; ms: number }[] = [];

  for (let i = 0; i < 3; i++) {
    const { result, ms } = await timed(
      async () => await page.goto(`${baseUrl}/sign/${token}`, { waitUntil: 'commit' }),
    );

    loads.push({ status: result?.status(), ms });
  }

  return loads;
};

const reasonOf = (text: string) => {
  try {
    return String(JSON.parse(text)?.error?.json?.message ?? '');
  } catch {
    return '';
  }
};

test.describe('[BRANDING_CONTRAST]: Codex round 4', () => {
  test('C53 a long run of interior whitespace is checked in bounded time', async ({ page }, testInfo) => {
    const css = `p{color:black;background:${LONG_VALUE}}`;
    const colours = { primary: LONG_VALUE, primaryForeground: '#000000' };

    const baselineLoad = await measureBaselineLoad(page, await seedSigningToken(admin, 'c53-plain'));
    const baselineSaveMs = await measureBaselineSave(admin);

    // Stylesheet route.
    const cssSave = await timed(async () => await saveOrganisationSettings(admin, { brandingCss: css }));
    const cssStored = (await readOrganisationBranding(admin)).brandingCss.length > 0;

    if (!cssStored) {
      await prisma.organisationGlobalSettings.update({
        where: { id: admin.organisationGlobalSettingsId },
        data: { brandingEnabled: true, brandingCss: css },
      });
    }

    const cssToken = await seedSigningToken(admin, 'c53-css');
    const cssLoads = await timedLoads(page, cssToken);

    // Token route.
    await resetBranding(admin);

    const tokenSave = await timed(async () => await saveOrganisationSettings(admin, { brandingColors: colours }));
    const tokenStored = (await readOrganisationBranding(admin)).brandingColors !== null;

    if (!tokenStored) {
      await prisma.organisationGlobalSettings.update({
        where: { id: admin.organisationGlobalSettingsId },
        data: { brandingEnabled: true, brandingColors: colours },
      });
    }

    const tokenToken = await seedSigningToken(admin, 'c53-token');
    const tokenLoads = await timedLoads(page, tokenToken);

    await writeEvidence(testInfo, 'c53', {
      cssBytes: Buffer.byteLength(css),
      baselineLoad,
      baselineSaveMs,
      saveBudgetMs: saveBudgetMs(baselineSaveMs),
      loadBudgetMs: loadBudgetMs(baselineLoad.ms),
      stylesheet: {
        save: { status: cssSave.result.status, ms: cssSave.ms, reason: reasonOf(cssSave.result.text) },
        storedBySave: cssStored,
        loads: cssLoads,
      },
      token: {
        save: { status: tokenSave.result.status, ms: tokenSave.ms, reason: reasonOf(tokenSave.result.text) },
        storedBySave: tokenStored,
        loads: tokenLoads,
      },
    });

    for (const [route, save, loads] of [
      ['stylesheet', cssSave, cssLoads],
      ['token', tokenSave, tokenLoads],
    ] as const) {
      expect.soft(save.result.status, `${route} save is answered, not failed`).toBeLessThan(500);
      expect
        .soft(save.ms, `${route} save answers within the ${baselineSaveMs} ms baseline save plus 200 ms`)
        .toBeLessThan(saveBudgetMs(baselineSaveMs));

      for (const [index, load] of loads.entries()) {
        expect.soft(load.status, `${route} signing page load ${index + 1} is not a 500`).toBeLessThan(500);
        expect
          .soft(
            load.ms,
            `${route} signing page load ${index + 1} within twice the ${baselineLoad.ms} ms baseline plus 100 ms`,
          )
          .toBeLessThan(loadBudgetMs(baselineLoad.ms));
      }
    }
  });

  test('C54 a stored blank token does not reach the signing page', async ({ page }, testInfo) => {
    await prisma.organisationGlobalSettings.update({
      where: { id: admin.organisationGlobalSettingsId },
      data: {
        brandingEnabled: true,
        brandingColors: { background: ' ', primary: '#213871', primaryForeground: '#ffffff' },
      },
    });

    const token = await seedSigningToken(admin, 'c54');
    const observed: Record<string, unknown> = {};

    for (const mode of ALL_MODES) {
      await openSigningPage(page, token, mode);

      const vars = await readBodyVars(page, ['--background', '--foreground']);
      const text = readability(await measureTestOwned(page, `g3-c54-${mode}`, ''));
      const expected: Rgba =
        mode === 'light' ? hex(LIGHT_DEFAULTS.background) : (hslTriplet(DARK_DEFAULT_TRIPLETS.background) as Rgba);

      observed[mode] = { vars, text };

      expect
        .soft(
          near(hslTriplet(vars['--background']), expected),
          `[${mode}] --background ${vars['--background']} is the default`,
        )
        .toBe(true);
      expect
        .soft(text.ratio, `[${mode}] text ${text.foreground} on ${text.worst ?? text.backgrounds.join(' | ')}`)
        .toBeGreaterThanOrEqual(THRESHOLD);

      await screenshot(page, testInfo, `c54-${mode}`);
    }

    await writeEvidence(testInfo, 'c54', observed);
  });

  for (const [code, character] of [
    ['000B', '\u000b'],
    ['0000', '\u0000'],
  ] as const) {
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures argument before testInfo.
    test(`C55 a stylesheet of only U+${code} is refused`, async ({}, testInfo) => {
      await prisma.organisationGlobalSettings.update({
        where: { id: admin.organisationGlobalSettingsId },
        data: { brandingEnabled: true, brandingCss: CANARY_CSS },
      });

      const save = await saveOrganisationSettings(admin, { brandingCss: character });
      const stored = (await readOrganisationBranding(admin)).brandingCss;

      await writeEvidence(testInfo, `c55-${code}`, {
        status: save.status,
        reason: reasonOf(save.text),
        storedUnchanged: stored === CANARY_CSS,
      });

      expect.soft(save.status, `refused with a 4xx: ${save.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      expect.soft(save.status, 'refused with a 4xx, not a 500').toBeLessThan(500);
      expect.soft(reasonOf(save.text), 'the refusal gives a reason').not.toBe('');
      expect.soft(stored, 'nothing is stored').toBe(CANARY_CSS);
    });
  }
});
