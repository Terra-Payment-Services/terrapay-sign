/**
 * Branding contrast, behaviours added after Ram's decision of 18 October 2026 (Q35) and
 * Codex round 7.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 7", without reading the implementation.
 *
 * | Criterion | Test                                                                       |
 * | --------- | -------------------------------------------------------------------------- |
 * | 61        | C61 the 32 KiB limit is refused with a length message, on both routes      |
 * | 62        | C62 a selector budget breach is refused, not saved with every rule removed |
 * | 63        | C63 comments do not count toward the selector budget                       |
 * | 64        | C64 a stored row over the limit renders without CSS, tokens and logo stay  |
 * | 65        | C65 the round 7 payloads are bounded at save and render                    |
 *
 * C62 sizes its payloads from the budget constants in packages/lib so they follow the
 * implementation's values. The budgets themselves are assumed to stay at or above the
 * current 20,000 selector characters and 2,000 simple selectors.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_BRANDING_SELECTOR_CHARACTERS,
  MAX_BRANDING_SIMPLE_SELECTORS,
} from '@documenso/lib/utils/branding-css-budget';
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { DocumentDataType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  CANARY_COLOR,
  CANARY_CSS,
  hex,
  hslTriplet,
  near,
  openAdminSession,
  openSigningPage,
  readBodyVars,
  readOrganisationBranding,
  resetBranding,
  type SaveResult,
  saveOrganisationSettings,
  saveTeamSettings,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';
import { loadBudgetMs, measureBaselineSave, saveBudgetMs } from './fixtures/branding-server-probes';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round7');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

/** The new request limit, in characters (Q35). */
const LIMIT = 32 * 1024;

const reasonOf = (text: string) => {
  try {
    return String(JSON.parse(text)?.error?.json?.message ?? '');
  } catch {
    return '';
  }
};

const isRefused = (save: SaveResult) => save.status >= 400 && save.status < 500;

const readTeamCss = async () =>
  (
    await prisma.teamGlobalSettings.findUniqueOrThrow({
      where: { id: admin.teamGlobalSettingsId },
    })
  ).brandingCss ?? '';

/** Ordinary rules, `length` characters exactly: each rule is 20 characters, the rest is padding. */
const ordinaryCss = (length: number) => {
  const rule = '.r{font-weight:700}\n';
  const repeats = Math.floor(length / rule.length);

  return rule.repeat(repeats) + ' '.repeat(length - repeats * rule.length);
};

const KEEP = '.g3-keep{font-weight:700}';

test.describe('[BRANDING_CONTRAST]: 32 KiB limit and Codex round 7', () => {
  test('C61 the 32 KiB limit is refused with a length message on both routes', async ({
    request: _request,
  }, testInfo) => {
    const evidence: Record<string, unknown> = {};

    for (const route of ['organisation', 'team'] as const) {
      const save = route === 'organisation' ? saveOrganisationSettings : saveTeamSettings;
      const readCss = async () =>
        route === 'organisation' ? (await readOrganisationBranding(admin)).brandingCss : await readTeamCss();

      const first = await save(admin, { brandingCss: KEEP });

      expect(first.status, `${route}: the sentinel saves: ${first.text.slice(0, 200)}`).toBe(200);

      const before = await readCss();
      const over = await save(admin, { brandingCss: ordinaryCss(LIMIT + 1) });
      const after = await readCss();
      const reason = reasonOf(over.text);
      const edge = await save(admin, { brandingCss: ordinaryCss(LIMIT) });
      const edgeStored = await readCss();

      evidence[route] = {
        sentinelStored: before,
        over: { status: over.status, reason },
        storedAfterOver: after,
        edge: { status: edge.status, storedLength: edgeStored.length },
      };

      expect.soft(over.status, `${route}: ${LIMIT + 1} characters answers 400`).toBe(400);
      expect.soft(`${reason} ${over.text}`, `${route}: the message names the length limit`).toMatch(/32,?768|32 ?KiB/i);
      expect.soft(reason, `${route}: the message says what is too long`).toMatch(/character|length|long/i);
      expect.soft(after, `${route}: stored branding is unchanged by the refused save`).toBe(before);
      expect.soft(edge.status, `${route}: ${LIMIT} characters of ordinary CSS saves`).toBe(200);
      expect.soft(edgeStored, `${route}: the ${LIMIT}-character stylesheet is stored`).toContain('.r{font-weight:700}');
    }

    await writeEvidence(testInfo, 'c61', evidence);
  });

  const OVER_BUDGET = [
    {
      id: 'selector-characters',
      title: 'prelude characters',
      // Class names of 900 characters stay under the per-selector limit; the total passes the budget.
      css: Array.from(
        { length: Math.floor(MAX_BRANDING_SELECTOR_CHARACTERS / 901) + 2 },
        (_, i) => `.${String.fromCharCode(97 + (i % 26))}${'a'.repeat(899)}{font-weight:700}`,
      ).join('\n'),
    },
    {
      id: 'simple-selectors',
      title: 'simple selectors',
      // 100 attribute selectors per rule keep every rule small; the total passes the budget.
      css: Array.from(
        { length: Math.floor(MAX_BRANDING_SIMPLE_SELECTORS / 100) + 2 },
        () => `${'[a]'.repeat(100)}{font-weight:700}`,
      ).join('\n'),
    },
  ];

  for (const c of OVER_BUDGET) {
    test(`C62 a stylesheet over the ${c.title} budget is refused and branding is unchanged`, async ({
      request: _request,
    }, testInfo) => {
      expect(c.css.length, 'premise: the payload fits under 32 KiB').toBeLessThanOrEqual(LIMIT);

      const first = await saveOrganisationSettings(admin, {
        brandingCss: KEEP,
      });

      expect(first.status, `the sentinel saves: ${first.text.slice(0, 200)}`).toBe(200);

      const before = await readOrganisationBranding(admin);
      const save = await saveOrganisationSettings(admin, {
        brandingCss: c.css,
      });
      const after = await readOrganisationBranding(admin);
      const reason = reasonOf(save.text);

      await writeEvidence(testInfo, `c62-${c.id}`, {
        length: c.css.length,
        status: save.status,
        reason,
        warningCount: save.cssWarnings.length,
        storedBefore: before.brandingCss,
        storedAfter: after.brandingCss,
      });

      expect.soft(isRefused(save), `answers 4xx, not ${save.status}`).toBe(true);
      expect.soft(reason, 'the refusal carries a reason').not.toBe('');
      expect.soft(after.brandingCss, 'stored branding is unchanged').toBe(before.brandingCss);
    });
  }

  test('C63 comments do not count toward the selector budget', async ({ page }, testInfo) => {
    const header = `/*${'license text '.repeat(1700)}*/`;
    const css = `${header}.g3-c63{font-weight:700}`;

    expect(css.length, 'premise: the payload fits under 32 KiB').toBeLessThanOrEqual(LIMIT);
    expect(header.length, 'premise: the header alone passes the selector character budget').toBeGreaterThan(
      MAX_BRANDING_SELECTOR_CHARACTERS,
    );

    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = (await readOrganisationBranding(admin)).brandingCss;
    const token = await seedSigningToken(admin, 'c63');

    await openSigningPage(page, token, 'light');

    const weight = await page.evaluate(() => {
      const element = document.createElement('div');

      element.className = 'g3-c63';
      document.body.appendChild(element);

      const value = getComputedStyle(element).fontWeight;

      element.remove();

      return value;
    });

    await writeEvidence(testInfo, 'c63', {
      length: css.length,
      status: save.status,
      reason: reasonOf(save.text),
      warnings: save.cssWarnings,
      storedLength: stored.length,
      weight,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(save.cssWarnings, 'no warning').toEqual([]);
    expect.soft(stored, 'the rule is stored').toContain('.g3-c63');
    expect.soft(weight, 'the rule applies on the signing page').toBe('700');
  });

  test('C64 a stored row over the limit renders without CSS, tokens and logo still apply', async ({
    page,
  }, testInfo) => {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: admin.teamId },
    });
    const logo = await fs.readFile(path.join(__dirname, '../../assets/logo.png'));
    // The long comment trails the rules, so no selector budget is breached: only the length is over.
    const css = `.g3-c64{font-weight:700}\n${CANARY_CSS}\n/*${'x'.repeat(LIMIT)}*/`;

    expect(css.length, 'premise: the stored row is longer than the limit').toBeGreaterThan(LIMIT);

    await prisma.organisationGlobalSettings.update({
      where: { id: admin.organisationGlobalSettingsId },
      data: {
        brandingEnabled: true,
        brandingCss: css,
        // Round 22: dark card, widget, muted, popover and secondary, a light primary, and a mid-grey
        // foreground (#767676, readable on black and on the fixed gray-50 surface), so every pair reads.
        brandingColors: {
          background: '#000000',
          foreground: '#767676',
          card: '#000000',
          cardForeground: '#ffffff',
          widget: '#000000',
          muted: '#000000',
          popover: '#000000',
          popoverForeground: '#ffffff',
          secondary: '#000000',
          secondaryForeground: '#ffffff',
          primary: '#8fb4ff',
          primaryForeground: '#0b1020',
        },
        brandingLogo: JSON.stringify({
          type: DocumentDataType.BYTES_64,
          data: logo.toString('base64'),
        }),
      },
    });

    const token = await seedSigningToken(admin, 'c64');
    const response = await page.goto(`${baseUrl}/sign/${token}`);

    await expect(page.getByRole('button', { name: 'Reject Document' })).toBeVisible({ timeout: 30_000 });

    const probe = await page.evaluate(() => {
      const element = document.createElement('div');

      element.className = 'g3-c64';
      document.body.appendChild(element);

      const value = getComputedStyle(element).fontWeight;

      element.remove();

      return value;
    });
    const rejectBorder = await page
      .getByRole('button', { name: 'Reject Document' })
      .evaluate((element) => getComputedStyle(element).borderTopColor);
    const vars = await readBodyVars(page, ['--background', '--foreground']);
    const logoVisible = await page.getByRole('img', { name: `${team.name}'s Logo` }).isVisible();

    await writeEvidence(testInfo, 'c64', {
      rowLength: css.length,
      status: response?.status(),
      probe,
      rejectBorder,
      vars,
      logoVisible,
    });

    expect.soft(response?.status(), 'the page answers 200').toBe(200);
    expect.soft(probe, 'the over-limit stylesheet is not applied (class rule)').not.toBe('700');
    expect.soft(rejectBorder, 'the over-limit stylesheet is not applied (canary)').not.toBe(CANARY_COLOR);
    expect
      .soft(near(hslTriplet(vars['--background']), hex('#000000')), `background token applies: ${vars['--background']}`)
      .toBe(true);
    expect
      .soft(near(hslTriplet(vars['--foreground']), hex('#767676')), `foreground token applies: ${vars['--foreground']}`)
      .toBe(true);
    expect.soft(logoVisible, 'the custom logo is shown').toBe(true);
  });

  // Each payload is scaled to just under 32 KiB.
  const repeatTo = (unit: string, head: string) => head + unit.repeat(Math.floor((LIMIT - head.length) / unit.length));

  const BOUNDED = [
    {
      id: 'c65-escaped-crlf',
      title: 'an escaped CRLF inside a string',
      css: repeatTo(`${'[a]'.repeat(320)}{font-weight:700}`, 'p{font-family:"a\\\r\nb"}'),
    },
    {
      id: 'c65-semicolon-in-brackets',
      title: "a ';' inside brackets",
      css: repeatTo(`${'[a]'.repeat(320)}[b=;]{font-weight:700}`, ''),
    },
    {
      id: 'c65-declaration-value',
      title: 'a very long declaration value',
      css: `p{font-family:${'a '.repeat(16000)}f0}`,
    },
  ];

  for (const c of BOUNDED) {
    test(`C65 ${c.title} is bounded at save and render`, async ({ page }, testInfo) => {
      expect(c.css.length, 'premise: just under 32 KiB').toBeLessThanOrEqual(LIMIT);
      expect(c.css.length, 'premise: just under 32 KiB').toBeGreaterThan(LIMIT - 1500);

      const token = await seedSigningToken(admin, c.id);
      const plain = [];

      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const status = (await page.goto(`${baseUrl}/sign/${token}`, { waitUntil: 'commit' }))?.status();

        plain.push({ status, ms: Date.now() - started });
      }

      const baselineMs = Math.min(plain[1].ms, plain[2].ms);
      // Relative budgets (amendment after CI pipeline 55408): the save against a one-rule baseline save,
      // the loads against twice the plain loads above.
      const baselineSaveMs = await measureBaselineSave(admin);
      const started = Date.now();
      const save = await saveOrganisationSettings(admin, {
        brandingCss: c.css,
      });
      const saveMs = Date.now() - started;
      const stored = (await readOrganisationBranding(admin)).brandingCss;
      const seeded = stored !== c.css;

      if (seeded) {
        await prisma.organisationGlobalSettings.update({
          where: { id: admin.organisationGlobalSettingsId },
          data: { brandingEnabled: true, brandingCss: c.css },
        });
      }

      const loads = [];

      for (let i = 0; i < 5; i++) {
        const loadStarted = Date.now();
        const status = (await page.goto(`${baseUrl}/sign/${token}`, { waitUntil: 'commit' }))?.status();

        loads.push({ status, ms: Date.now() - loadStarted });
      }

      await writeEvidence(testInfo, c.id, {
        length: c.css.length,
        plain,
        baselineMs,
        baselineSaveMs,
        saveBudgetMs: saveBudgetMs(baselineSaveMs),
        loadBudgetMs: loadBudgetMs(baselineMs),
        save: {
          status: save.status,
          ms: saveMs,
          reason: reasonOf(save.text),
          warnings: save.cssWarnings.slice(0, 3),
        },
        storedLength: stored.length,
        seeded,
        loads,
      });

      expect.soft(save.status, 'the save is answered, not a 500').toBeLessThan(500);
      expect
        .soft(
          saveMs < saveBudgetMs(baselineSaveMs) || (isRefused(save) && reasonOf(save.text) !== ''),
          `the save answers within the ${baselineSaveMs} ms baseline save plus 200 ms (took ${saveMs}) or is refused with a reason`,
        )
        .toBe(true);

      loads.forEach((load, index) => {
        expect.soft(load.status, `load ${index + 1} is not a 500`).toBeLessThan(500);
        expect
          .soft(load.ms, `load ${index + 1} within twice the ${baselineMs} ms baseline plus 100 ms`)
          .toBeLessThan(loadBudgetMs(baselineMs));
      });
    });
  }
});
