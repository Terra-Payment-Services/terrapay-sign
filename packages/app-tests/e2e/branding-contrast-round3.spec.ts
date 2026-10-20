/**
 * Branding contrast, behaviours added after Codex round 3.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 3", without reading the checker.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 49        | C49 control characters are not CSS whitespace                         |
 * | 50        | C50 star and underscore property hacks are not painted backgrounds    |
 * | 51        | C51 the final of two near-identical backgrounds is the one judged     |
 * | 52        | C52 deeply nested media rules are refused, never a 500                |
 *
 * C49 and C50 accept either outcome the spec allows: the save refused with a 4xx (nothing
 * stored), or a 200 with each pair dropped and a contrast warning. Either way the signing
 * page must read at least 3:1 in both dark modes. C52 seeds the nested stylesheet straight
 * into the organisation row, because a correct save refuses it and no other route stores it.
 */
import { prisma } from '@documenso/prisma';
import { expect, type Page, type TestInfo, test } from '@playwright/test';

import {
  type AdminSession,
  ALL_MODES,
  addProbes,
  baseUrl,
  browserComputes,
  CANARY_CSS,
  type CssCase,
  contrastWarningFor,
  keepsCheckedDeclaration,
  type Mode,
  openAdminSession,
  openSigningPage,
  readability,
  readComputed,
  readOrganisationBranding,
  resetBranding,
  runStylesheetCases,
  saveOrganisationSettings,
  saveTeamSettings,
  screenshot,
  seedSigningToken,
  THRESHOLD,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round3');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const DARK_MODES: Mode[] = ['dark-media', 'dark-cookie'];

/**
 * Saves `cases` as one stylesheet and accepts either a 4xx refusal with nothing stored or a
 * 200 with every pair dropped under a contrast warning. Then measures every probe on the
 * signing page in `modes`.
 */
const refusedOrDropped = async (page: Page, testInfo: TestInfo, name: string, cases: CssCase[], modes: Mode[]) => {
  const css = cases.map((c) => c.css).join('\n');
  const save = await saveOrganisationSettings(admin, { brandingCss: `${css}\n${CANARY_CSS}` });
  const storedCss = (await readOrganisationBranding(admin)).brandingCss;
  const token = await seedSigningToken(admin, name);
  const measurements: Record<string, Record<string, ReturnType<typeof readability>>> = {};

  for (const mode of modes) {
    await openSigningPage(page, token, mode);

    const selectors = await addProbes(page, cases);

    measurements[mode] = {};

    for (const c of cases) {
      measurements[mode][c.id] = readability(await readComputed(page, selectors[c.id]));
    }

    await screenshot(page, testInfo, `${name}-${mode}`);
  }

  await writeEvidence(testInfo, name, {
    submittedCss: css,
    status: save.status,
    response: save.body ?? save.text.slice(0, 2000),
    storedCss,
    measurements,
  });

  expect.soft(save.status, `${name}: the save is answered, not failed: ${save.text.slice(0, 200)}`).toBeLessThan(500);

  if (save.status === 200) {
    for (const c of cases) {
      expect.soft(contrastWarningFor(save.cssWarnings, c.selector), `${c.id}: a contrast warning`).toBeDefined();
      expect
        .soft(keepsCheckedDeclaration(storedCss, c.selector), `${c.id}: stored CSS has no checked colour`)
        .toBe(false);
    }
  } else {
    expect.soft(storedCss, `${name}: a refused save stores nothing`).toBe('');
  }

  for (const mode of modes) {
    for (const c of cases) {
      const r = measurements[mode][c.id];

      expect
        .soft(r.ratio, `${c.id} [${mode}]: computed ${r.foreground} on ${r.worst ?? r.backgrounds.join(' | ')}`)
        .toBeGreaterThanOrEqual(THRESHOLD);
    }
  }
};

const CONTROLS: [string, string][] = [
  ['0b', '\u000b'],
  ['00', '\u0000'],
  ['01', '\u0001'],
  ['08', '\u0008'],
  ['0e', '\u000e'],
  ['1f', '\u001f'],
];

test.describe('[BRANDING_CONTRAST]: Codex round 3', () => {
  for (const [code, character] of CONTROLS) {
    test(`C49 control character U+00${code.toUpperCase()} is not CSS whitespace`, async ({ page }, testInfo) => {
      await refusedOrDropped(
        page,
        testInfo,
        `c49-${code}`,
        [
          {
            id: `c49-${code}-value`,
            selector: `.g3-c49-${code}-value`,
            css: `.g3-c49-${code}-value { color: black; background:${character}white; }`,
            expected: 'refused',
          },
          {
            id: `c49-${code}-between`,
            selector: `.g3-c49-${code}-between`,
            css: `.g3-c49-${code}-between { color: black; background: none${character}white; }`,
            expected: 'refused',
          },
        ],
        DARK_MODES,
      );
    });
  }

  test('C50 star and underscore property hacks are not painted backgrounds', async ({ page }, testInfo) => {
    const token = await seedSigningToken(admin, 'c50-browser');

    await openSigningPage(page, token, 'dark-media');

    const computed = await browserComputes(page, ['*background: white;', '_background: white;']);

    await writeEvidence(testInfo, 'c50-browser', computed);

    for (const [declaration, value] of Object.entries(computed)) {
      expect.soft(value.backgroundColor, `Chromium ignores ${declaration}`).toBe('rgba(0, 0, 0, 0)');
    }

    await refusedOrDropped(
      page,
      testInfo,
      'c50',
      [
        {
          id: 'c50-star',
          selector: '.g3-c50-star',
          css: '.g3-c50-star { color: black; *background: white; }',
          expected: 'refused',
        },
        {
          id: 'c50-underscore',
          selector: '.g3-c50-underscore',
          css: '.g3-c50-underscore { color: black; _background: white; }',
          expected: 'refused',
        },
      ],
      DARK_MODES,
    );
  });

  test('C51 the final of two near-identical backgrounds is the one judged', async ({ page }, testInfo) => {
    const token = await seedSigningToken(admin, 'c51-browser');

    await openSigningPage(page, token, 'light');

    const computed = await browserComputes(page, ['background: rgb(89.1 89.1 89.1); background: rgb(88.9 88.9 88.9);']);

    await writeEvidence(testInfo, 'c51-browser', computed);

    await runStylesheetCases({
      admin,
      page,
      testInfo,
      name: 'c51',
      cases: [
        {
          id: 'c51-final',
          selector: '.g3-c51-final',
          css: '.g3-c51-final { color: black; background: rgb(89.1 89.1 89.1); background: rgb(88.9 88.9 88.9); }',
          expected: 'refused',
        },
      ],
      modes: ['light'],
    });
  });

  test('C52 deeply nested media rules are refused, never a 500', async ({ page }, testInfo) => {
    const css = `${'@media all{'.repeat(12000)}p{color:black;background:white}${'}'.repeat(12000)}`;

    const organisation = await saveOrganisationSettings(admin, { brandingCss: css });
    const team = await saveTeamSettings(admin, { brandingCss: css });

    // A correct save stores nothing, so the render path is reached by seeding the row.
    await prisma.organisationGlobalSettings.update({
      where: { id: admin.organisationGlobalSettingsId },
      data: { brandingEnabled: true, brandingCss: css },
    });

    const token = await seedSigningToken(admin, 'c52');
    const loads: Record<string, number | undefined> = {};

    for (const mode of ALL_MODES) {
      await page.emulateMedia({ colorScheme: mode === 'dark-media' ? 'dark' : 'light' });
      await page.context().request.post(`${baseUrl}/api/theme`, {
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ theme: mode === 'dark-cookie' ? 'dark' : null }),
      });

      loads[mode] = (await page.goto(`${baseUrl}/sign/${token}`))?.status();
    }

    const reasonOf = (text: string) => {
      try {
        return String(JSON.parse(text)?.error?.json?.message ?? '');
      } catch {
        return '';
      }
    };

    await writeEvidence(testInfo, 'c52', {
      bytes: Buffer.byteLength(css),
      organisationSave: { status: organisation.status, reason: reasonOf(organisation.text) },
      teamSave: { status: team.status, reason: reasonOf(team.text) },
      seededSigningPageStatus: loads,
    });

    for (const [route, save] of [
      ['organisation', organisation],
      ['team', team],
    ] as const) {
      expect.soft(save.status, `${route} save answers 4xx: ${save.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      expect.soft(save.status, `${route} save answers 4xx, not 500`).toBeLessThan(500);
      expect.soft(reasonOf(save.text), `${route} save gives a reason`).not.toBe('');
    }

    for (const mode of ALL_MODES) {
      expect.soft(loads[mode], `signing page with the seeded row [${mode}] is not a 500`).toBeLessThan(500);
    }
  });
});
