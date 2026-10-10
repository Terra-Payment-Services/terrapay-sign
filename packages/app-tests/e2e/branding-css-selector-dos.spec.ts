import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { BRANDING_CSS_MAX_LENGTH } from '@documenso/lib/constants/branding';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from './fixtures/authentication';

/**
 * GHSA-rj75-hqrm-r3gf: postcss-selector-parser below 7.1.6 parses a flat selector such as
 * `.a.a.a...` in quadratic time, so a maximum-length branding CSS value could occupy the
 * single Node event loop for many seconds. The branding CSS is sanitised inside the
 * `organisation.settings.update` request, so this drives that route as an organisation admin
 * and watches a second, unrelated endpoint while it runs.
 *
 * Bounds are relative to a baseline taken in the same test: the same route, session and
 * server, with benign CSS of the same length (a long descendant selector, `.a .a .a ...`,
 * whose words stay short so the quadratic path is not reached). Database, Redis, network
 * and parallel-worker delays hit the baseline and the pathological request alike, so the
 * test asks only how much longer the pathological input takes. The margins come from the
 * measurements on the development machine: the fixed parser took 120 ms for the request
 * and a 34 ms probe gap, the vulnerable parser 3225 ms and 3064 ms. A margin of 750 ms on
 * the request and 500 ms on the probe gap sits far above the fixed difference and far
 * below the vulnerable one. There is no absolute ceiling, since one would fail a correct
 * parser on a loaded runner.
 */
const REQUEST_MARGIN_MS = 750;
const STALL_MARGIN_MS = 500;
const PROBE_INTERVAL_MS = 100;

const DECLARATIONS = '{color:red}';

const buildPathologicalCss = () => {
  const repeats = Math.floor((BRANDING_CSS_MAX_LENGTH - DECLARATIONS.length) / 2);

  return `${'.a'.repeat(repeats)}${DECLARATIONS}`;
};

const buildBenignCss = (length: number) => {
  const repeats = Math.floor((length - DECLARATIONS.length) / 3);
  const padding = length - DECLARATIONS.length - repeats * 3;

  return `${'.a '.repeat(repeats)}${' '.repeat(padding)}${DECLARATIONS}`;
};

test('[BRANDING_CSS]: a maximum length flat selector is sanitised quickly and does not stall the server', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  const css = buildPathologicalCss();

  expect(css.length).toBeLessThanOrEqual(BRANDING_CSS_MAX_LENGTH);
  expect(css.length).toBeGreaterThan(BRANDING_CSS_MAX_LENGTH - 16);

  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await apiSignin({ page, email: user.email });

  const baseUrl = NEXT_PUBLIC_WEBAPP_URL();

  // Warm the route so the measurement excludes first-request compilation costs.
  const warmUp = await page.context().request.post(`${baseUrl}/api/trpc/organisation.settings.update`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: { organisationId: organisation.id, data: { brandingCss: '.a { color: red; }' } } }),
  });

  expect(warmUp.ok()).toBe(true);

  const updateBrandingCss = async (brandingCss: string) => {
    let stop = false;
    let worstGapMs = 0;
    let probeCount = 0;

    const probe = (async () => {
      while (!stop) {
        const probeStartedAt = Date.now();

        await request.get(`${baseUrl}/api/health`, { failOnStatusCode: false, timeout: 120_000 });

        worstGapMs = Math.max(worstGapMs, Date.now() - probeStartedAt);
        probeCount += 1;

        await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
      }
    })();

    const startedAt = Date.now();

    const response = await page.context().request.post(`${baseUrl}/api/trpc/organisation.settings.update`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ json: { organisationId: organisation.id, data: { brandingCss } } }),
      timeout: 120_000,
    });

    const requestMs = Date.now() - startedAt;

    stop = true;
    await probe;

    expect(response.ok()).toBe(true);

    return { requestMs, worstGapMs, probeCount };
  };

  const benignCss = buildBenignCss(css.length);

  expect(benignCss.length).toBe(css.length);

  const baseline = await updateBrandingCss(benignCss);
  const measured = await updateBrandingCss(css);
  const { requestMs, worstGapMs, probeCount } = measured;

  console.log(
    `[BRANDING_CSS] baseline request ${baseline.requestMs} ms, gap ${baseline.worstGapMs} ms; ` +
      `pathological request ${requestMs} ms, gap ${worstGapMs} ms`,
  );

  test.info().annotations.push({
    type: 'timing',
    description: `baseline ${baseline.requestMs} ms / ${baseline.worstGapMs} ms gap; pathological ${requestMs} ms / ${worstGapMs} ms gap over ${probeCount} probes`,
  });
  const stored = await prisma.organisationGlobalSettings.findUniqueOrThrow({
    where: { id: organisation.organisationGlobalSettingsId },
  });

  expect(stored.brandingCss).toContain('{color:red}');

  expect(requestMs).toBeLessThan(baseline.requestMs + REQUEST_MARGIN_MS);
  expect(worstGapMs).toBeLessThan(baseline.worstGapMs + STALL_MARGIN_MS);
});
