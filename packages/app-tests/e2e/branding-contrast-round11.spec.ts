/**
 * Branding contrast, the guard must measure what the signer sees (Codex round 10).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 10", without reading the implementation.
 *
 * | Criterion | Test                                                                 |
 * | --------- | -------------------------------------------------------------------- |
 * | 72        | C72 labels and icons inside a readable control                       |
 * | 73        | C73 textarea and typed-signature input text                          |
 * | 74        | C74 placeholder text                                                 |
 * | 75        | C75 a media query that starts to match after load                    |
 * | 76        | C76 print media                                                      |
 * | 77        | C77 a dark theme that styles inputs and placeholders stays applied   |
 * | 78        | C78 a background on an SVG child is not painted and does not count   |
 * | 79        | C79 hover and focus on one element change another element's colour  |
 *
 * Every stylesheet is seeded into the organisation row and carries the marker rule
 * `.g3-marker{font-weight:700}`; a test-owned element of that class shows whether the tenant
 * stylesheet is still applied. `expectSurvivesRender` first checks that the render-time check
 * leaves both halves of each unreadable pair in place. The page-wide measurement is `measureText`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDataType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  boundaryFailures,
  type ComputedPair,
  type ControlBoundary,
  openAdminSession,
  readability,
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
  admin = await openAdminSession(browser, testInfo, 'round11');
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
const GREY_PAIR = ['background-color:#8f8f8f', 'color:#8f8f8f'];

type Measured = { label: string; kind: string; ratio: number; foreground: string; worst?: string };

type Raw = { label: string; kind: 'color' | 'fill' | 'stroke' | 'placeholder'; pair: ComputedPair };

/**
 * Every visible, enabled element the signer reads: elements with their own text, inputs and
 * textareas with a value, placeholders of empty ones, and SVG paint inside controls.
 */
const measureText = async (page: Page): Promise<Measured[]> => {
  const raw = await page.evaluate(() => {
    const out: {
      label: string;
      kind: string;
      pair: {
        selector: string;
        color: string;
        fill: string;
        stroke: string;
        layers: { backgroundColor: string; backgroundImage: string; opacity?: string }[];
      };
    }[] = [];
    const all = Array.from(document.body.querySelectorAll('*'));

    for (const el of all) {
      const style = getComputedStyle(el);
      const svgRoot = (el as SVGElement).ownerSVGElement ?? el;
      const rect = svgRoot.getBoundingClientRect();

      if (
        style.display === 'none' ||
        style.visibility !== 'visible' ||
        Number(style.opacity) === 0 ||
        rect.width === 0 ||
        rect.height === 0 ||
        (el.closest('[disabled],[hidden]') ?? (svgRoot === el ? el.closest('[aria-hidden=true]') : null)) ||
        ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)
      ) {
        continue;
      }

      const layers: { backgroundColor: string; backgroundImage: string; opacity: string }[] = [];

      for (let node: Element | null = el; node; node = node.parentElement) {
        // The browser paints no background for the children of an <svg>, only for the <svg> box itself.
        if (node instanceof SVGElement && node.tagName.toLowerCase() !== 'svg') {
          continue;
        }

        const nodeStyle = getComputedStyle(node);

        layers.push({
          backgroundColor: nodeStyle.backgroundColor,
          backgroundImage: nodeStyle.backgroundImage,
          opacity: nodeStyle.opacity,
        });
      }

      const tag = el.tagName.toLowerCase();
      const label = `${tag}${el.getAttribute('data-field-type') ? `[${el.getAttribute('data-field-type')}]` : ''} ${(el.textContent ?? '').trim().slice(0, 24)}`;
      const base = { selector: tag, color: style.color, fill: style.fill, stroke: style.stroke, layers };
      const isEditable = tag === 'input' || tag === 'textarea';
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
      const value = isEditable ? (el as HTMLInputElement).value : '';
      const type = isEditable ? ((el as HTMLInputElement).type ?? '') : '';
      const hasTextType = !['checkbox', 'radio', 'hidden', 'file', 'button', 'submit'].includes(type);

      if (ownText || (isEditable && hasTextType && value !== '')) {
        out.push({ label, kind: 'color', pair: base });
      }

      if (isEditable && hasTextType && value === '' && (el as HTMLInputElement).placeholder) {
        const placeholder = getComputedStyle(el, '::placeholder');

        out.push({
          label: `${label} ::placeholder`,
          kind: 'placeholder',
          pair: {
            ...base,
            color: placeholder.color,
            layers: [{ backgroundColor: placeholder.backgroundColor, backgroundImage: 'none' }, ...layers],
          },
        });
      }

      if (svgRoot !== el && el.closest('button,a,[role=button],[role=tab]')) {
        if (style.stroke !== 'none') {
          out.push({ label: `${label} svg stroke`, kind: 'stroke', pair: base });
        }

        if (style.fill !== 'none') {
          out.push({ label: `${label} svg fill`, kind: 'fill', pair: base });
        }
      }
    }

    return out;
  });

  return (raw as Raw[]).map((item) => {
    const field = item.kind === 'placeholder' ? 'color' : (item.kind as 'color' | 'fill' | 'stroke');
    const result = readability(item.pair, field);

    return {
      label: item.label,
      kind: item.kind,
      ratio: result.ratio,
      foreground: result.foreground,
      worst: result.worst,
    };
  });
};

/**
 * Baseline ratios by element, from the same page state with no tenant stylesheet. The default theme has
 * a few low-contrast elements of its own (placeholders, muted icons), and those are not the tenant's.
 */
type Baseline = Map<string, number>;

const BASELINE_MARGIN = 0.3;

const toBaseline = (measures: Measured[], into: Baseline = new Map()) => {
  for (const m of measures) {
    const key = `${m.kind} ${m.label}`;

    into.set(key, Math.min(into.get(key) ?? Infinity, m.ratio));
  }

  return into;
};

/** Elements under the threshold that are worse than they are by default. */
const lowest = (measures: Measured[], baseline: Baseline = new Map()) =>
  measures.filter((m) => {
    const was = baseline.get(`${m.kind} ${m.label}`);

    return m.ratio < BRANDING_CONTRAST_THRESHOLD && (was === undefined || m.ratio < was - BASELINE_MARGIN);
  });

/**
 * A hidden element carrying the marker class, added once and only read afterwards. Adding and removing
 * an element on every poll is a DOM mutation, which could itself trigger a guard that re-measures on
 * mutations and so hide a guard that does not re-measure on media changes.
 */
const installMarker = async (page: Page) =>
  await page.evaluate(() => {
    if (document.getElementById('g3-marker-probe')) {
      return;
    }

    const element = document.createElement('div');

    element.id = 'g3-marker-probe';
    element.className = 'g3-marker';
    element.hidden = true;
    document.body.appendChild(element);
  });

const markerWeight = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.getElementById('g3-marker-probe');

    return element ? getComputedStyle(element).fontWeight : 'no-marker';
  });

const waitForDisabled = async (page: Page) => {
  const deadline = Date.now() + GUARD_WAIT_MS;
  let weight = await markerWeight(page);

  while (weight === '700' && Date.now() < deadline) {
    await page.waitForTimeout(250);
    weight = await markerWeight(page);
  }

  return weight;
};

/** Runs `scenario` on a second page with no tenant stylesheet and records every measurement it takes. */
const baselineOf = async (
  page: Page,
  scenario: (second: Page, snap: () => Promise<void>) => Promise<void>,
): Promise<Baseline> => {
  const baseline: Baseline = new Map();
  const second = await page.context().newPage();

  // Round 22: the baseline is the default theme, with neither the stylesheet nor the tokens; logo kept.
  await seedStored('', null);

  try {
    await scenario(second, async () => {
      toBaseline(await measureText(second), baseline);
    });
  } finally {
    await second.close();
  }

  return baseline;
};

const expectSurvivesRender = (css: string, needles: string[]) => {
  const rendered = renderStoredBrandingCss(css, TOKENS).replace(/\s+/g, '');

  for (const needle of needles) {
    expect(rendered, `premise: the rendered stylesheet keeps ${needle}`).toContain(needle);
  }
};

const seedStored = async (css: string, colours: typeof TOKENS | null = TOKENS) => {
  const logo = await fs.readFile(path.join(__dirname, '../../assets/logo.png'));

  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: {
      brandingEnabled: true,
      brandingCss: css,
      brandingColors: colours,
      brandingLogo: JSON.stringify({ type: DocumentDataType.BYTES_64, data: logo.toString('base64') }),
    },
  });
};

/**
 * Waits until the page's entrance animations have finished: every running Web Animation, and the
 * signature pad's hint, whose path fades in from opacity 0 over 0.6 s and draws over 2 s
 * (`signature-pad-dialog.tsx`). A baseline snapped while the hint was still invisible lacked it, so the
 * settled hint read as a regression (C75b, CI pipeline 55422).
 */
const waitForEntrance = async (page: Page) =>
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            document.getAnimations().every((animation) => animation.playState !== 'running') &&
            Array.from(document.querySelectorAll('[data-branding-decorative] path')).every(
              (path) => getComputedStyle(path).opacity === '1',
            ),
        ),
      { message: 'the entrance animations finish', timeout: 15_000 },
    )
    .toBe(true);

const openPage = async (page: Page, token: string, width = 1280) => {
  await page.setViewportSize({ width, height: 900 });

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(page.getByRole('button', { name: 'Reject Document' }).first()).toBeVisible({ timeout: 30_000 });
  await waitForEntrance(page);
  await installMarker(page);

  return response?.status();
};

const openReject = async (page: Page, reason: string | null) => {
  await page.getByRole('button', { name: 'Reject Document' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  if (reason !== null) {
    await page.getByRole('dialog').locator('textarea').fill(reason);
  }
};

const openTypeTab = async (page: Page, name: string | null) => {
  await page.locator('[data-field-type=SIGNATURE]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('tab', { name: 'Type' }).click();

  const input = page.getByRole('dialog').locator('input[type=text], input:not([type])').first();

  await expect(input).toBeVisible();

  if (name !== null) {
    await input.fill(name);
  }
};

/** The guard disabled the stylesheet, or every measured element reads at least the threshold. */
const expectGuardedOrReadable = async (
  page: Page,
  id: string,
  status: number | undefined,
  evidence: Record<string, unknown>,
  baseline: Baseline,
) => {
  const weight = await waitForDisabled(page);
  const measures = await measureText(page);
  const failing = lowest(measures, baseline);

  evidence[id] = { status, markerWeight: weight, measured: measures.length, failing, measures };

  expect.soft(status, `${id}: the page answers 200`).toBe(200);
  expect.soft(measures.length, `${id}: the measurement found elements`).toBeGreaterThan(0);
  expect
    .soft(
      weight !== '700' || failing.length === 0,
      `${id}: the stylesheet is disabled (marker ${weight}) or every element reads ${BRANDING_CONTRAST_THRESHOLD}:1; failing: ${JSON.stringify(failing.slice(0, 4))}`,
    )
    .toBe(true);
};

type Case = {
  id: string;
  title: string;
  css: string;
  needles: string[];
  steps?: (page: Page) => Promise<void>;
};

const sig = '[data-field-type=SIGNATURE]';
const both = (selector: string) => `${selector}{background-color:#8f8f8f}\n${selector}{color:#8f8f8f}`;

const CASES: Case[] = [
  {
    id: 'c72a',
    title: 'C72a the label inside a readable signature field',
    css: `${MARKER}\n${sig}{background-color:#8f8f8f;color:#000}\n${sig} p{color:#8f8f8f}`,
    needles: ['background-color:#8f8f8f', 'p{color:#8f8f8f'],
  },
  {
    id: 'c72b',
    title: 'C72b the close icon of a dialog',
    css: `${MARKER}\n[role=dialog] button{background-color:#8f8f8f;color:#000}\n[role=dialog] button svg{stroke:#8f8f8f}`,
    needles: ['background-color:#8f8f8f', 'svg{stroke:#8f8f8f'],
    steps: async (page) => await openReject(page, null),
  },
  {
    id: 'c78',
    title: 'C78 an SVG child background that the browser never paints',
    css: `${MARKER}\nbutton svg{background-color:#fff;color:#000}\nbutton svg path{background-color:#000;stroke:#fff}`,
    needles: ['background-color:#fff', 'background-color:#000', 'stroke:#fff'],
    steps: async (page) => await openReject(page, null),
  },
  {
    id: 'c73a',
    title: 'C73a the rejection-reason textarea',
    css: `${MARKER}\n${both('textarea')}`,
    needles: GREY_PAIR,
    steps: async (page) => await openReject(page, 'Not my document'),
  },
  {
    id: 'c73b',
    title: 'C73b the typed-signature input',
    css: `${MARKER}\n${both('input')}`,
    needles: GREY_PAIR,
    steps: async (page) => await openTypeTab(page, 'Jane Signer'),
  },
  {
    id: 'c74a',
    title: 'C74a the typed-signature placeholder',
    css: `${MARKER}\n${both('input::placeholder,textarea::placeholder')}`,
    needles: GREY_PAIR,
    steps: async (page) => await openTypeTab(page, ''),
  },
  {
    id: 'c74b',
    title: 'C74b the rejection-reason placeholder',
    css: `${MARKER}\n${both('input::placeholder,textarea::placeholder')}`,
    needles: GREY_PAIR,
    steps: async (page) => await openReject(page, null),
  },
];

test.describe('[BRANDING_CONTRAST]: the guard measures what the signer sees', () => {
  for (const c of CASES) {
    test(`${c.title} is guarded`, async ({ page }, testInfo) => {
      expectSurvivesRender(c.css, c.needles);

      const token = await seedSigningToken(admin, c.id);
      const baseline = await baselineOf(page, async (second, snap) => {
        await openPage(second, token);
        await c.steps?.(second);
        await snap();
      });

      await seedStored(c.css);

      const status = await openPage(page, token);
      const evidence: Record<string, unknown> = {};

      await c.steps?.(page);
      await expectGuardedOrReadable(page, c.id, status, evidence, baseline);
      await writeEvidence(testInfo, c.id, evidence);
    });
  }

  test('C75 a media query that starts to match after load', async ({ page }, testInfo) => {
    const css = `${MARKER}\n@media(min-width:900px){button{background-color:#8f8f8f}\nbutton{color:#8f8f8f}}`;
    const evidence: Record<string, unknown> = {};

    expectSurvivesRender(css, GREY_PAIR);

    const token = await seedSigningToken(admin, 'c75');
    const baseline = await baselineOf(page, async (second, snap) => {
      await openPage(second, token, 800);
      await snap();
      await second.setViewportSize({ width: 1000, height: 900 });
      await snap();
    });

    await seedStored(css);

    const status = await openPage(page, token, 800);

    await page.waitForTimeout(SETTLE_MS);

    const narrow = await measureText(page);

    evidence.narrow = { markerWeight: await markerWeight(page), failing: lowest(narrow, baseline) };
    expect.soft(await markerWeight(page), 'premise: the stylesheet is applied at 800 px').toBe('700');
    expect.soft(lowest(narrow, baseline), 'premise: nothing is unreadable at 800 px').toEqual([]);

    await page.setViewportSize({ width: 1000, height: 900 });
    await expectGuardedOrReadable(page, 'wide', status, evidence, baseline);
    await writeEvidence(testInfo, 'c75', evidence);
  });

  test('C75b a media query that starts to match without a resize', async ({ page }, testInfo) => {
    const css = `${MARKER}\n@media(prefers-color-scheme:dark){button{background-color:#8f8f8f}\nbutton{color:#8f8f8f}}`;
    const evidence: Record<string, unknown> = {};

    expectSurvivesRender(css, GREY_PAIR);

    const token = await seedSigningToken(admin, 'c75b');
    const baseline = await baselineOf(page, async (second, snap) => {
      await second.emulateMedia({ colorScheme: 'light' });
      await openPage(second, token);
      await snap();
      await second.emulateMedia({ colorScheme: 'dark' });
      await snap();
    });

    await seedStored(css);
    await page.emulateMedia({ colorScheme: 'light' });

    const status = await openPage(page, token);

    await page.waitForTimeout(SETTLE_MS);

    const light = await measureText(page);

    evidence.light = { markerWeight: await markerWeight(page), failing: lowest(light, baseline) };
    expect.soft(await markerWeight(page), 'premise: the stylesheet is applied under a light preference').toBe('700');
    expect.soft(lowest(light, baseline), 'premise: nothing is unreadable under a light preference').toEqual([]);

    // Changes the media match without a resize event or any DOM change.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectGuardedOrReadable(page, 'dark', status, evidence, baseline);
    await writeEvidence(testInfo, 'c75b', evidence);
  });

  test('C76 print media', async ({ page }, testInfo) => {
    const css = `${MARKER}\n@media print{button{background-color:#8f8f8f}\nbutton{color:#8f8f8f}}`;
    const evidence: Record<string, unknown> = {};

    expectSurvivesRender(css, GREY_PAIR);

    const token = await seedSigningToken(admin, 'c76');
    const baseline = await baselineOf(page, async (second, snap) => {
      await openPage(second, token);
      await snap();
      await second.emulateMedia({ media: 'print' });
      await snap();
    });

    await seedStored(css);

    const status = await openPage(page, token);

    await page.waitForTimeout(SETTLE_MS);

    const screen = await measureText(page);

    evidence.screen = { markerWeight: await markerWeight(page), failing: lowest(screen, baseline) };
    expect.soft(await markerWeight(page), 'premise: the stylesheet is applied on screen').toBe('700');
    expect.soft(lowest(screen, baseline), 'premise: nothing is unreadable on screen').toEqual([]);

    await page.emulateMedia({ media: 'print' });
    await expectGuardedOrReadable(page, 'print', status, evidence, baseline);
    await writeEvidence(testInfo, 'c76', evidence);
  });

  const close = (page: Page) => page.getByRole('dialog').getByRole('button', { name: 'Close' });
  const reasonField = (page: Page) => page.getByRole('dialog').locator('textarea');
  // The placeholder rule keeps the empty textarea's placeholder readable, so the guard has no other reason to act.
  const greyBackground =
    '[role=dialog] textarea{background-color:#8f8f8f}\n[role=dialog] textarea::placeholder{background-color:#8f8f8f;color:#000}';

  const CROSS: {
    id: string;
    title: string;
    css: string;
    setup: (page: Page) => Promise<void>;
    trigger: (page: Page) => Promise<void>;
  }[] = [
    {
      id: 'c79a',
      title: 'C79a hovering the close button changes the textarea text',
      css: `${MARKER}\n${greyBackground}\n[role=dialog]:has(button:hover) textarea{color:#8f8f8f}`,
      setup: async (page) => {
        await openReject(page, 'Not my document');
        await expect(reasonField(page)).toHaveValue('Not my document');
      },
      trigger: async (page) => await close(page).hover(),
    },
    {
      id: 'c79b',
      title: 'C79b focusing the close button changes the textarea text',
      css: `${MARKER}\n${greyBackground}\n[role=dialog]:has(button:focus) textarea{color:#8f8f8f}`,
      setup: async (page) => {
        await openReject(page, 'Not my document');
        await expect(reasonField(page)).toHaveValue('Not my document');
      },
      trigger: async (page) => await close(page).focus(),
    },
    {
      id: 'c79c',
      title: 'C79c leaving hover changes the textarea text',
      css: `${MARKER}\n${greyBackground}\n[role=dialog]:not(:has(button:hover)):has(textarea:not(:placeholder-shown)) textarea{color:#8f8f8f}`,
      setup: async (page) => {
        await openReject(page, null);
        await close(page).hover();
        await reasonField(page).fill('Not my document');
        await expect(reasonField(page)).toHaveValue('Not my document');
      },
      trigger: async (page) => await page.mouse.move(2, 2),
    },
  ];

  for (const c of CROSS) {
    test(`${c.title} is guarded`, async ({ page }, testInfo) => {
      expectSurvivesRender(c.css, GREY_PAIR);

      const token = await seedSigningToken(admin, c.id);
      const baseline = await baselineOf(page, async (second, snap) => {
        await openPage(second, token);
        await c.setup(second);
        await snap();
        await c.trigger(second);
        await snap();
      });

      await seedStored(c.css);

      const status = await openPage(page, token);
      const evidence: Record<string, unknown> = {};

      await c.setup(page);
      await page.waitForTimeout(SETTLE_MS);

      const before = await measureText(page);

      evidence.before = { markerWeight: await markerWeight(page), failing: lowest(before, baseline) };
      expect.soft(await markerWeight(page), 'premise: the stylesheet is applied before the trigger').toBe('700');
      expect.soft(lowest(before, baseline), 'premise: nothing is unreadable before the trigger').toEqual([]);

      await c.trigger(page);
      await expectGuardedOrReadable(page, c.id, status, evidence, baseline);
      await writeEvidence(testInfo, c.id, evidence);
    });
  }

  test('C77 a dark theme that styles inputs and placeholders stays applied', async ({ page }, testInfo) => {
    const css = [
      MARKER,
      'button{background-color:#1f2937;color:#f9fafb}',
      'input,textarea{background-color:#1f2937;color:#f9fafb}',
      'input::placeholder,textarea::placeholder{background-color:#1f2937;color:#9ca3af}',
    ].join('\n');

    const token = await seedSigningToken(admin, 'c77');
    // Round 20 (C113): control boundaries are measured too, against the default theme, dialog open.
    let boundaryBaseline: ControlBoundary[] = [];
    const baseline = await baselineOf(page, async (second, snap) => {
      await openPage(second, token);
      await openReject(second, null);
      await snap();
      await second.locator('[data-field-type=SIGNATURE] button').first().waitFor();
      boundaryBaseline = await readControlBoundaries(second);
      await second.getByRole('dialog').locator('textarea').fill('Not my document');
      await snap();
    });

    expectSurvivesRender(css, ['background-color:#1f2937', 'color:#f9fafb', 'color:#9ca3af']);
    await seedStored(css);

    const status = await openPage(page, token);

    await openReject(page, null);
    await page.waitForTimeout(SETTLE_MS);

    const empty = await measureText(page);

    await page.locator('[data-field-type=SIGNATURE] button').first().waitFor();

    const boundaries = boundaryFailures(await readControlBoundaries(page), boundaryBaseline);

    await page.getByRole('dialog').locator('textarea').fill('Not my document');
    await expect(page.getByRole('dialog').locator('textarea')).toHaveValue('Not my document');
    await page.waitForTimeout(SETTLE_MS);

    const typed = await measureText(page);
    const weight = await markerWeight(page);

    await writeEvidence(testInfo, 'c77', { status, markerWeight: weight, empty, typed, boundaryBaseline, boundaries });

    expect.soft(status, 'the page answers 200').toBe(200);
    expect.soft(weight, 'the stylesheet is still applied').toBe('700');
    expect
      .soft(
        empty.some((m) => m.kind === 'placeholder'),
        'premise: a placeholder was measured',
      )
      .toBe(true);
    expect.soft(lowest(empty, baseline), 'every element reads at least 3:1, field empty').toEqual([]);
    expect.soft(lowest(typed, baseline), 'every element reads at least 3:1, reason typed').toEqual([]);
    expect.soft(boundaries.failing, 'every control boundary reads at least 3:1, or no worse than default').toEqual([]);
    expect.soft(boundaries.margin, 'the zero-paint overlay is excluded, not passed by the margin').toEqual([]);
    expect.soft(boundaries.excluded.length, 'the field overlay is excluded as zero-paint').toBeGreaterThan(0);
  });
});
