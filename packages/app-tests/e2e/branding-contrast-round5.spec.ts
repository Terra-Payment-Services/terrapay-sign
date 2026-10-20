/**
 * Branding contrast, behaviours added after Codex round 5.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 5", without reading the checker.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 56        | C56 many removed declarations are handled in bounded time and memory  |
 * | 57        | C57 a very long selector is handled in bounded time and memory        |
 *
 * The probes are C47's: latency to the first response byte, and the resident set size of
 * the process listening on the server's port (`fixtures/branding-server-probes.ts`), sampled
 * every 25 ms. The time budgets are relative to a baseline save and load taken in the same test
 * (amendment after CI pipeline 55408).
 * They need the server on the same machine as the test. When the save does not store the
 * stylesheet as submitted (refused, or rewritten by the sanitiser), the raw stylesheet is
 * seeded into the organisation row so the render path is measured on it as legacy data.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';

import {
  type AdminSession,
  baseUrl,
  openAdminSession,
  readOrganisationBranding,
  resetBranding,
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
  admin = await openAdminSession(browser, testInfo, 'round5');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const RSS_BUDGET_KIB = 100 * 1024;

const serverRssKib = async () => (await serverRss()).kib;

/** Runs `action` while sampling server RSS every 25 ms; returns its duration and the peak. */
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

const reasonOf = (text: string) => {
  try {
    return String(JSON.parse(text)?.error?.json?.message ?? '');
  } catch {
    return '';
  }
};

const CASES = [
  {
    id: 'c56',
    title: 'C56 many removed declarations are handled in bounded time and memory',
    css: `p{${'x:0;'.repeat(60000)}}`,
    length: 240003,
    keeps: null,
  },
  {
    id: 'c57',
    title: 'C57 a very long selector is handled in bounded time and memory',
    css: `${'p '.repeat(120000)}{color:red}`,
    length: 240011,
    keeps: 'color:red',
  },
] as const;

test.describe('[BRANDING_CONTRAST]: Codex round 5', () => {
  for (const c of CASES) {
    test(c.title, async ({ page }, testInfo) => {
      expect(c.css.length, 'payload length').toBe(c.length);

      const token = await seedSigningToken(admin, c.id);
      const baselineLoad = await measureBaselineLoad(page, token);
      const baselineSaveMs = await measureBaselineSave(admin);
      const baseline = await serverRssKib();
      const save = await measured(async () => await saveOrganisationSettings(admin, { brandingCss: c.css }));
      const stored = (await readOrganisationBranding(admin)).brandingCss;
      // Seed the raw stylesheet whenever the save did not store it as submitted, so the
      // render path is measured on it as legacy stored CSS.
      const seeded = stored !== c.css;

      if (seeded) {
        await prisma.organisationGlobalSettings.update({
          where: { id: admin.organisationGlobalSettingsId },
          data: { brandingEnabled: true, brandingCss: c.css },
        });
      }

      const loads = [];

      for (let i = 0; i < 3; i++) {
        loads.push(
          await measured(async () => (await page.goto(`${baseUrl}/sign/${token}`, { waitUntil: 'commit' }))?.status()),
        );
      }

      const peak = Math.max(save.peakKib, ...loads.map((l) => l.peakKib));

      await writeEvidence(testInfo, c.id, {
        length: c.css.length,
        baselineRssKib: baseline,
        baselineLoad,
        baselineSaveMs,
        saveBudgetMs: saveBudgetMs(baselineSaveMs),
        loadBudgetMs: loadBudgetMs(baselineLoad.ms),
        save: {
          status: save.result.status,
          ms: save.ms,
          peakRssKib: save.peakKib,
          reason: reasonOf(save.result.text),
          warnings: save.result.cssWarnings.slice(0, 5).map((w) => ({ kind: w.kind, detail: w.detail.slice(0, 300) })),
        },
        storedLength: stored.length,
        seeded,
        pageLoads: loads.map((l) => ({ status: l.result, ms: l.ms, peakRssKib: l.peakKib })),
        rssGrowthKib: peak - baseline,
      });

      expect.soft(save.result.status, 'the save is answered, not a 500').toBeLessThan(500);
      expect
        .soft(save.ms, `the save answers within the ${baselineSaveMs} ms baseline save plus 200 ms`)
        .toBeLessThan(saveBudgetMs(baselineSaveMs));

      if (save.result.status >= 400) {
        expect.soft(reasonOf(save.result.text), 'a refused save gives a reason').not.toBe('');
      }

      if (c.keeps && save.result.status === 200 && !stored.replace(/\s+/g, '').includes(c.keeps)) {
        expect.soft(save.result.cssWarnings.length, 'a dropped rule comes with a warning').toBeGreaterThan(0);
      }

      for (const [index, load] of loads.entries()) {
        expect.soft(load.result, `signing page load ${index + 1} is not a 500`).toBeLessThan(500);
        expect
          .soft(load.ms, `signing page load ${index + 1} within twice the ${baselineLoad.ms} ms baseline plus 100 ms`)
          .toBeLessThan(loadBudgetMs(baselineLoad.ms));
      }

      expect
        .soft(peak - baseline, `server RSS grows by under ${RSS_BUDGET_KIB / 1024} MiB`)
        .toBeLessThan(RSS_BUDGET_KIB);
    });
  }
});
