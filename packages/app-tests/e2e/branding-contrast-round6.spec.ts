/**
 * Branding contrast, behaviours added after Codex round 6.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 6", without reading the checker.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 58        | C58 many attribute selectors are bounded at save and render           |
 * | 59        | C59 a stylesheet of comments is bounded at save and render            |
 * | 60        | C60 legitimate selector lists are kept and applied (amended round 14) |
 *
 * C58 and C59 use C47's probes: latency to the first response byte, taken from the test
 * host against a server on the same machine, and the RSS of the process listening on the
 * server's port (`fixtures/branding-server-probes.ts`). The budgets are relative to baselines
 * taken in the same test (amendment after CI pipeline 55408): the render budget is twice a
 * baseline of loads of the same signing page with no stylesheet plus 100 ms, and the save budget
 * the baseline save of a one-rule stylesheet plus 200 ms. When the save does not store the stylesheet as submitted, the raw
 * stylesheet is seeded into the organisation row as legacy data.
 */
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  baseUrl,
  openAdminSession,
  openSigningPage,
  readOrganisationBranding,
  resetBranding,
  type SaveResult,
  saveOrganisationSettings,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';
import { loadBudgetMs, measureBaselineSave, saveBudgetMs, serverRss } from './fixtures/branding-server-probes';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round6');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const RSS_BUDGET_KIB = 50 * 1024;

const serverRssKib = async () => (await serverRss()).kib;

const measured = async <T>(action: () => Promise<T>) => {
  let peak = await serverRssKib();
  let running = true;

  const sampler = (async () => {
    while (running) {
      peak = Math.max(peak, await serverRssKib());
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();

  const started = Date.now();
  const result = await action();
  const ms = Date.now() - started;

  running = false;
  await sampler;

  return { result, ms, peakKib: Math.max(peak, await serverRssKib()) };
};

const loadOnce = async (page: Page, token: string) =>
  await measured(async () => (await page.goto(`${baseUrl}/sign/${token}`, { waitUntil: 'commit' }))?.status());

const reasonOf = (text: string) => {
  try {
    return String(JSON.parse(text)?.error?.json?.message ?? '');
  } catch {
    return '';
  }
};

const selectorWarnings = (save: SaveResult) =>
  save.cssWarnings.filter((w) => /selector/i.test(`${w.kind} ${w.detail}`));

const BOUNDED = [
  {
    id: 'c58',
    title: 'C58 many attribute selectors are bounded at save and render',
    css: `${'[a]'.repeat(320)}{font-weight:700}`.repeat(265),
  },
  {
    id: 'c59',
    title: 'C59 a stylesheet of comments is bounded at save and render',
    css: '/**/'.repeat(65000),
  },
] as const;

test.describe('[BRANDING_CONTRAST]: Codex round 6', () => {
  for (const c of BOUNDED) {
    test(c.title, async ({ page }, testInfo) => {
      const token = await seedSigningToken(admin, c.id);

      // Baseline: the same signing page with no stylesheet; the first load warms it.
      const plain = [];

      for (let i = 0; i < 3; i++) {
        plain.push(await loadOnce(page, token));
      }

      const baselineMs = Math.min(plain[1].ms, plain[2].ms);
      const baselineSaveMs = await measureBaselineSave(admin);

      const save = await measured(async () => await saveOrganisationSettings(admin, { brandingCss: c.css }));
      const stored = (await readOrganisationBranding(admin)).brandingCss;
      const seeded = stored !== c.css;

      if (seeded) {
        await prisma.organisationGlobalSettings.update({
          where: { id: admin.organisationGlobalSettingsId },
          data: { brandingEnabled: true, brandingCss: c.css },
        });
      }

      const rssBefore = await serverRssKib();
      const loads = [];

      for (let i = 0; i < 5; i++) {
        loads.push(await loadOnce(page, token));
      }

      const rssGrowth = Math.max(...loads.map((l) => l.peakKib)) - rssBefore;

      await writeEvidence(testInfo, c.id, {
        length: c.css.length,
        plainLoads: plain.map((l) => ({ status: l.result, ms: l.ms })),
        baselineMs,
        baselineSaveMs,
        saveBudgetMs: saveBudgetMs(baselineSaveMs),
        loadBudgetMs: loadBudgetMs(baselineMs),
        save: {
          status: save.result.status,
          ms: save.ms,
          reason: reasonOf(save.result.text),
          warningCount: save.result.cssWarnings.length,
          firstWarnings: save.result.cssWarnings.slice(0, 3),
        },
        storedLength: stored.length,
        seeded,
        rssBeforeLoadsKib: rssBefore,
        loads: loads.map((l) => ({ status: l.result, ms: l.ms, peakRssKib: l.peakKib })),
        rssGrowthKib: rssGrowth,
      });

      const refusedWithReason =
        save.result.status >= 400 && save.result.status < 500 && reasonOf(save.result.text) !== '';

      expect.soft(save.result.status, 'the save is answered, not a 500').toBeLessThan(500);
      expect
        .soft(
          save.ms < saveBudgetMs(baselineSaveMs) || refusedWithReason,
          `the save answers within the ${baselineSaveMs} ms baseline save plus 200 ms (took ${save.ms}) or is refused with a reason`,
        )
        .toBe(true);

      for (const index of [1, 2]) {
        expect.soft(loads[index].result, `load ${index + 1} is not a 500`).toBeLessThan(500);
        expect
          .soft(loads[index].ms, `load ${index + 1} within twice the ${baselineMs} ms baseline plus 100 ms`)
          .toBeLessThan(loadBudgetMs(baselineMs));
      }

      expect
        .soft(rssGrowth, `server RSS grows by under ${RSS_BUDGET_KIB / 1024} MiB across five loads`)
        .toBeLessThan(RSS_BUDGET_KIB);
    });
  }

  test('C60 legitimate selector lists are kept and applied', async ({ page }, testInfo) => {
    const list = Array.from({ length: 17 }, (_, i) => `.t${i} tr:nth-child(2n + 1)`).join(', ');
    const rules = {
      'nth-child list': `${list}{font-weight:700}`,
      'quoted attribute': 'a[title="a + b ~ c"]{font-weight:700}',
      'escaped separator': '.a\\+b{font-weight:700}',
    };

    const results: Record<string, unknown> = {};

    for (const [name, css] of Object.entries(rules)) {
      await resetBranding(admin);

      const save = await saveOrganisationSettings(admin, { brandingCss: css });
      const stored = (await readOrganisationBranding(admin)).brandingCss;
      const token = await seedSigningToken(admin, `c60-${name.replace(/\s+/g, '-')}`);

      await openSigningPage(page, token, 'light');

      const applied = await page.evaluate(() => {
        const host = document.createElement('div');

        host.innerHTML =
          '<table class="t0"><tbody><tr><td>t0</td></tr></tbody></table>' +
          '<table class="t16"><tbody><tr><td>t16</td></tr></tbody></table>' +
          '<a title="a + b ~ c">quoted</a>' +
          '<span class="a+b">escaped</span>';
        document.body.appendChild(host);

        // No named helper here: the bundler would wrap it in a __name call the page lacks.
        const out = Object.fromEntries(
          Object.entries({ t0: '.t0 td', t16: '.t16 td', quoted: 'a', escaped: 'span' }).map(([key, selector]) => {
            const element = host.querySelector(selector);

            return [key, element ? getComputedStyle(element).fontWeight : 'missing'];
          }),
        );

        host.remove();

        return out;
      });

      results[name] = {
        status: save.status,
        reason: reasonOf(save.text),
        warnings: save.cssWarnings,
        stored,
        applied,
      };

      expect.soft(save.status, `${name}: saves 200`).toBe(200);

      // Round 14 (C86, C87): `(`, `)`, `\` and any colon but `::placeholder` drop the rule, so the
      // nth-child list and the escaped separator are now dropped with a selector warning and do not apply.
      if (name === 'nth-child list') {
        expect.soft(selectorWarnings(save).length, `${name}: a selector warning (round 14)`).toBeGreaterThanOrEqual(1);
        expect.soft(applied.t0, `${name}: not applied to .t0 rows (round 14)`).not.toBe('700');
        expect.soft(applied.t16, `${name}: not applied to .t16 rows (round 14)`).not.toBe('700');
      } else if (name === 'quoted attribute') {
        expect.soft(selectorWarnings(save), `${name}: no selector warning`).toEqual([]);
        expect.soft(applied.quoted, `${name}: applied`).toBe('700');
      } else {
        expect.soft(selectorWarnings(save).length, `${name}: a selector warning (round 14)`).toBeGreaterThanOrEqual(1);
        expect.soft(applied.escaped, `${name}: not applied (round 14)`).not.toBe('700');
      }
    }

    await writeEvidence(testInfo, 'c60', results);
  });
});
