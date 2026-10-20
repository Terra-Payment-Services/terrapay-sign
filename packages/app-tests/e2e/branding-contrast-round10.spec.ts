/**
 * Branding contrast, the signing-page guard added after the black-box pass (round 10).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after the
 * black-box pass (round 10)", without reading the implementation.
 *
 * | Criterion | Test                                                              |
 * | --------- | ----------------------------------------------------------------- |
 * | 66        | C66 the black-box cascade payload disables the stylesheet         |
 * | 67        | C67 two selectors matching one control disable the stylesheet     |
 * | 68        | C68 an ancestor background disables the stylesheet                |
 * | 69        | C69 the guard covers the signature dialog once it is opened       |
 * | 70        | C70 a legitimate dark theme keeps its stylesheet                  |
 * | 71        | C71 signed-out and signed-in signers both get the guard           |
 *
 * Every stylesheet is seeded into the organisation row, so the save-time check cannot refuse it.
 * Each carries a marker rule, `.g3-marker{font-weight:700}`: a test-owned element of that class
 * shows whether the tenant stylesheet is still applied. Controls are measured with the fixtures'
 * `readability`, which composites every ancestor background over white.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DocumentDataType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  boundaryFailures,
  type ComputedPair,
  hex,
  hslTriplet,
  near,
  openAdminSession,
  readability,
  readBodyVars,
  readControlBoundaries,
  resetBranding,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round10');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const MARKER = '.g3-marker{font-weight:700}';
const GUARD_WAIT_MS = 8_000;
const SETTLE_MS = 3_000;
const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };

type Control = { label: string; locator: (page: Page) => Locator };

const byRole = (role: 'button' | 'link' | 'tab', name: string | RegExp, scope?: string): Control => ({
  label: `${role} ${String(name)}`,
  locator: (page) =>
    (scope ? page.locator(scope) : page).getByRole(role, { name, exact: typeof name === 'string' }).first(),
});

const PAGE_CONTROLS: Control[] = [
  byRole('button', 'Reject Document'),
  byRole('button', 'Cancel'),
  byRole('button', 'Next Field'),
  byRole('link', 'Source code'),
];

const HEADER_CONTROLS: Control[] = [
  byRole('link', 'Documents'),
  byRole('link', 'Templates'),
  byRole('button', /^Search/),
  { label: 'account menu', locator: (page) => page.getByTestId('menu-switcher') },
  { label: 'inbox link', locator: (page) => page.locator('a[href="/inbox"]').first() },
];

const REJECT_DIALOG_CONTROLS: Control[] = [
  byRole('button', 'Cancel', '[role=dialog]'),
  byRole('button', 'Reject Document', '[role=dialog]'),
  byRole('button', 'Close', '[role=dialog]'),
];

const SIGNATURE_DIALOG_CONTROLS: Control[] = [
  byRole('tab', 'Draw', '[role=dialog]'),
  byRole('tab', 'Type', '[role=dialog]'),
  byRole('tab', 'Upload', '[role=dialog]'),
  byRole('button', 'Clear Signature', '[role=dialog]'),
  byRole('button', 'Cancel', '[role=dialog]'),
  byRole('button', 'Sign', '[role=dialog]'),
  byRole('button', 'Close', '[role=dialog]'),
];

type Measure = { label: string; state: 'normal' | 'hover'; ratio: number; foreground: string; worst?: string };

const readPair = async (locator: Locator): Promise<ComputedPair> =>
  await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const layers: { backgroundColor: string; backgroundImage: string; opacity: string }[] = [];

    for (let node: Element | null = element; node; node = node.parentElement) {
      const nodeStyle = getComputedStyle(node);

      layers.push({
        backgroundColor: nodeStyle.backgroundColor,
        backgroundImage: nodeStyle.backgroundImage,
        opacity: nodeStyle.opacity,
      });
    }

    return { selector: 'control', color: style.color, fill: style.fill, stroke: style.stroke, layers };
  });

/** Normal and hover contrast of every control that is present, visible and enabled. */
const measureControls = async (page: Page, controls: Control[], hover: boolean): Promise<Measure[]> => {
  const out: Measure[] = [];

  for (const control of controls) {
    const locator = control.locator(page);

    if ((await locator.count()) === 0 || !(await locator.isVisible()) || !(await locator.isEnabled())) {
      continue;
    }

    const states: Measure['state'][] = hover ? ['normal', 'hover'] : ['normal'];

    for (const state of states) {
      if (state === 'hover') {
        try {
          await locator.hover({ timeout: 2_000 });
          // Let the colour transition finish before reading.
          await page.waitForTimeout(400);
        } catch {
          continue;
        }
      }

      const result = readability(await readPair(locator));

      out.push({
        label: control.label,
        state,
        ratio: result.ratio,
        foreground: result.foreground,
        worst: result.worst,
      });
    }

    await page.mouse.move(0, 0);
  }

  return out;
};

const markerWeight = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.createElement('div');

    element.className = 'g3-marker';
    document.body.appendChild(element);

    const value = getComputedStyle(element).fontWeight;

    element.remove();

    return value;
  });

/** Polls until the marker stops applying, or the wait runs out; returns the last weight. */
const waitForDisabled = async (page: Page) => {
  const deadline = Date.now() + GUARD_WAIT_MS;
  let weight = await markerWeight(page);

  while (weight === '700' && Date.now() < deadline) {
    await page.waitForTimeout(250);
    weight = await markerWeight(page);
  }

  return weight;
};

/**
 * Premise: the render-time check must leave both halves of each unreadable pair in the stylesheet,
 * so only the cascade, not a stripped pair, can make a control unreadable. `needles` are the
 * declarations that must survive rendering, compared with whitespace removed.
 */
const expectSurvivesRender = (css: string, needles: string[]) => {
  const rendered = renderStoredBrandingCss(css, TOKENS).replace(/\s+/g, '');

  for (const needle of needles) {
    expect(rendered, `premise: the rendered stylesheet keeps ${needle}`).toContain(needle);
  }
};

const seedStored = async (css: string) => {
  const logo = await fs.readFile(path.join(__dirname, '../../assets/logo.png'));

  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: {
      brandingEnabled: true,
      brandingCss: css,
      brandingColors: TOKENS,
      brandingLogo: JSON.stringify({ type: DocumentDataType.BYTES_64, data: logo.toString('base64') }),
    },
  });
};

const openPage = async (page: Page, token: string) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(page.getByRole('button', { name: 'Reject Document' }).first()).toBeVisible({ timeout: 30_000 });

  return response?.status();
};

const lowest = (measures: Measure[]) => measures.filter((m) => m.ratio < BRANDING_CONTRAST_THRESHOLD);

const tokensAndLogo = async (page: Page) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: admin.teamId } });
  const vars = await readBodyVars(page, ['--primary']);

  return {
    vars,
    primaryApplies: near(hslTriplet(vars['--primary']), hex(TOKENS.primary)),
    logoVisible: await page.getByRole('img', { name: `${team.name}'s Logo` }).isVisible(),
  };
};

/** The whole-page expectations of a disabled stylesheet, for the signing page as loaded. */
const expectGuarded = async (
  page: Page,
  label: string,
  controls: Control[],
  status: number | undefined,
  evidence: Record<string, unknown>,
) => {
  const weight = await waitForDisabled(page);
  const measures = await measureControls(page, controls, true);
  const extras = await tokensAndLogo(page);

  evidence[label] = { status, markerWeight: weight, measures, ...extras };

  expect.soft(status, `${label}: the page answers 200`).toBe(200);
  expect
    .soft(weight, `${label}: the tenant stylesheet is disabled as a whole (marker rule stops applying)`)
    .not.toBe('700');
  expect.soft(lowest(measures), `${label}: every control reads at least ${BRANDING_CONTRAST_THRESHOLD}:1`).toEqual([]);
  expect
    .soft(extras.primaryApplies, `${label}: the primary token still applies (${extras.vars['--primary']})`)
    .toBe(true);
  expect.soft(extras.logoVisible, `${label}: the custom logo is still shown`).toBe(true);
};

const DISABLING_CASES = [
  {
    id: 'c66',
    needles: ['background-color:#8f8f8f', 'color:#8f8f8f'],
    title: 'C66 the black-box cascade payload disables the stylesheet',
    css: `${MARKER}\nbutton { background-color: #8f8f8f; }\nbutton { color: #8f8f8f; }`,
  },
  {
    id: 'c67',
    needles: ['background-color:#8f8f8f', 'color:#8f8f8f'],
    title: 'C67 two selectors matching one control disable the stylesheet',
    css: `${MARKER}\nbutton{color:#8f8f8f}\n[type=button]{background-color:#8f8f8f}`,
  },
  {
    id: 'c68',
    needles: ['background-color:#8f8f8f', 'color:#8f8f8f'],
    title: 'C68 an ancestor background disables the stylesheet',
    // Round 16 (C100): a tenant `transparent` background is now dropped, so the case no longer sets one.
    // The outline and ghost controls (Reject Document, Cancel) are transparent by the app's own classes
    // (packages/ui/primitives/button.tsx:18, :20), which keeps the premise: the first opaque ancestor is grey.
    css: `${MARKER}\nbody,div{background-color:#8f8f8f}\nbutton{color:#8f8f8f}`,
  },
] as const;

test.describe('[BRANDING_CONTRAST]: the signing-page guard', () => {
  for (const c of DISABLING_CASES) {
    test(c.title, async ({ page }, testInfo) => {
      expectSurvivesRender(c.css, [...c.needles]);
      await seedStored(c.css);

      const token = await seedSigningToken(admin, c.id);
      const status = await openPage(page, token);
      const evidence: Record<string, unknown> = {};

      await expectGuarded(page, 'page', PAGE_CONTROLS, status, evidence);

      await page.getByRole('button', { name: 'Reject Document' }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();

      const dialog = await measureControls(page, REJECT_DIALOG_CONTROLS, false);

      evidence.rejectDialog = dialog;
      expect.soft(lowest(dialog), 'the reject dialog controls read at least 3:1').toEqual([]);

      await writeEvidence(testInfo, c.id, evidence);
    });
  }

  test('C69 the guard covers the signature dialog once it is opened', async ({ page }, testInfo) => {
    const dialogControls = '[role=dialog] button,[role=dialog] [role=tab]';
    const css = `${MARKER}\n${dialogControls}{background-color:#8f8f8f}\n${dialogControls}{color:#8f8f8f}`;

    // Two rules, not one: the render-time check strips a colour pair that sits in a single rule.
    expectSurvivesRender(css, ['background-color:#8f8f8f', 'color:#8f8f8f']);
    await seedStored(css);

    const token = await seedSigningToken(admin, 'c69');
    const status = await openPage(page, token);
    const evidence: Record<string, unknown> = {};

    // As loaded, no enumerated control is affected, so the stylesheet is left applied.
    await page.waitForTimeout(SETTLE_MS);

    const before = await markerWeight(page);

    evidence.beforeOpen = { status, markerWeight: before };
    expect.soft(before, 'premise: the stylesheet is applied before the dialog opens').toBe('700');

    await page.locator('[data-field-type=SIGNATURE]').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const weight = await waitForDisabled(page);
    const measures = await measureControls(page, SIGNATURE_DIALOG_CONTROLS, false);
    const extras = await tokensAndLogo(page);

    evidence.afterOpen = { markerWeight: weight, measures, ...extras };

    await writeEvidence(testInfo, 'c69', evidence);

    expect.soft(status, 'the page answers 200').toBe(200);
    expect.soft(weight, 'the stylesheet is disabled once the dialog is open').not.toBe('700');
    expect.soft(lowest(measures), 'the signature dialog controls read at least 3:1').toEqual([]);
    expect.soft(extras.primaryApplies, 'the primary token still applies').toBe(true);
  });

  test('C70 a legitimate dark theme keeps its stylesheet', async ({ page }, testInfo) => {
    const token = await seedSigningToken(admin, 'c70');

    // Round 20 (C113): control boundaries are measured too, against this default-theme baseline.
    await openPage(page, token);
    // The field's transparent click overlay is a control by the round 20 rule; wait for it to mount.
    await page.locator('[data-field-type=SIGNATURE] button').first().waitFor();

    const boundaryBaseline = await readControlBoundaries(page);

    await seedStored(
      `${MARKER}\nbutton{background-color:#1f2937;color:#f9fafb}\nbutton:hover{background-color:#374151;color:#f9fafb}\n[role=tab]{background-color:#1f2937;color:#f9fafb}`,
    );

    const status = await openPage(page, token);

    await page.waitForTimeout(SETTLE_MS);

    const weight = await markerWeight(page);
    const measures = await measureControls(page, PAGE_CONTROLS, true);
    const buttonBackground = await page
      .getByRole('button', { name: 'Reject Document' })
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);

    // The field's transparent click overlay is a control by the round 20 rule; wait for it to mount.
    await page.locator('[data-field-type=SIGNATURE] button').first().waitFor();

    const boundaries = boundaryFailures(await readControlBoundaries(page), boundaryBaseline);

    await writeEvidence(testInfo, 'c70', {
      status,
      markerWeight: weight,
      measures,
      buttonBackground,
      boundaryBaseline,
      boundaries,
    });

    expect.soft(status, 'the page answers 200').toBe(200);
    expect.soft(weight, 'the stylesheet is still applied').toBe('700');
    expect.soft(buttonBackground, 'the dark button background is applied').toBe('rgb(31, 41, 55)');
    expect.soft(lowest(measures), 'every control reads at least 3:1').toEqual([]);
    expect.soft(boundaries.failing, 'every control boundary reads at least 3:1, or no worse than default').toEqual([]);
    expect.soft(boundaries.margin, 'the zero-paint overlay is excluded, not passed by the margin').toEqual([]);
    expect.soft(boundaries.excluded.length, 'the field overlay is excluded as zero-paint').toBeGreaterThan(0);
  });

  test('C71 signed-out and signed-in signers both get the guard', async ({ page }, testInfo) => {
    expectSurvivesRender(DISABLING_CASES[0].css, [...DISABLING_CASES[0].needles]);
    await seedStored(DISABLING_CASES[0].css);

    const token = await seedSigningToken(admin, 'c71');
    const evidence: Record<string, unknown> = {};

    const outStatus = await openPage(page, token);

    await expectGuarded(page, 'signed out', PAGE_CONTROLS, outStatus, evidence);

    const inStatus = await openPage(admin.page, token);

    await expect(admin.page.getByTestId('menu-switcher')).toBeVisible();
    await expectGuarded(admin.page, 'signed in', [...PAGE_CONTROLS, ...HEADER_CONTROLS], inStatus, evidence);

    await writeEvidence(testInfo, 'c71', evidence);
  });
});
