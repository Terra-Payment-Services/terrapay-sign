/**
 * Border widths at control scale, and only painted SVG fill (round 18).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 18: border widths
 * at control scale, and only painted SVG fill", without reading the sanitiser, the guard or its
 * measurement.
 *
 * | Criterion | Test                                                                          |
 * | --------- | ----------------------------------------------------------------------------- |
 * | 105       | C105 Codex round 17's icon-consuming border, saved and seeded                 |
 * | 105       | C105-dropped and C105-kept the width list beside .keep (round 19: all dropped) |
 * | 106       | C106 Codex round 17's unpainted fill keeps the stylesheet; C106-control       |
 * | 107       | the wide and non-px widths in sanitize-branding-css.test.ts restated as drops |
 *
 * `.keep` is `.keep{background-color:#fff;color:#000}`, as in round 16.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  baseUrl,
  type ComputedPair,
  openAdminSession,
  readability,
  readComputed,
  resetBranding,
  saveOrganisationSettings,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round18');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
const MARKER = '.g3-marker{font-weight:700}';
const KEEP = '.keep{background-color:#fff;color:#000}';
const SETTLE_MS = 3_000;

const squash = (css: string) => css.replace(/\s+/g, '');

const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));

const storedCss = async () =>
  squash(
    (await prisma.organisationGlobalSettings.findUniqueOrThrow({ where: { id: admin.organisationGlobalSettingsId } }))
      .brandingCss ?? '',
  );

const seedRow = async (css: string) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: css, brandingColors: TOKENS },
  });
};

/** The declarations of the first block whose selector is exactly `selector`, whitespace removed. */
const blockOf = (css: string, selector: string) => {
  const start = css.indexOf(`${squash(selector)}{`);

  if (start === -1) {
    return null;
  }

  const open = start + squash(selector).length + 1;

  return css.slice(open, css.indexOf('}', open));
};

/**
 * The `property` warnings that name `property` and sit on `line` of the submitted stylesheet. Round 19
 * (C110): border and outline shapes left the allowlist, so the C105 drops that expected a `value`
 * warning now expect a `property` warning.
 */
const propertyWarningsFor = (
  warnings: { kind: string; detail: string; line?: number }[],
  property: string,
  line: number,
) => warnings.filter((w) => w.kind === 'property' && w.detail.includes(property) && w.line === line);

const openSigning = async (page: Page, token: string) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(page.getByRole('button', { name: 'Reject Document' }).first()).toBeVisible({ timeout: 30_000 });

  return response?.status();
};

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

const openReject = async (page: Page) => {
  await page.getByRole('button', { name: 'Reject Document' }).first().click();
  await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
};

const CLOSE = '[role=dialog] [data-testid=btn-dialog-close]';

/** Every element carrying `data-branding-guard`, as `tag=reason`. */
const guardReasons = async (page: Page) =>
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-branding-guard]')).map(
      (element) => `${element.tagName.toLowerCase()}=${element.getAttribute('data-branding-guard')}`,
    ),
  );

/**
 * How many pixels of a screenshot of `selector` show the stroke colour `rgb` as painted: composited at
 * `opacity` (the shape's cumulative opacity) over the box's most common pixel, a pixel counting when it
 * is nearer that colour than the background. A 2px stroke on a 16px icon is anti-aliased at 1x, so few
 * pixels match the colour exactly (16 within 24 per channel on the default X).
 * Decoded on a blank page in the same context, which has no CSP to refuse the data URL.
 */
const pixelsOf = async (page: Page, selector: string, rgb: string, opacity: number) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
  const png = await page.locator(selector).first().screenshot({ animations: 'disabled' });
  const blank = await page.context().newPage();

  try {
    return await blank.evaluate(
      async ({ data, stroke, alpha }) => {
        const image = new Image();

        image.src = `data:image/png;base64,${data}`;
        await image.decode();

        const canvas = document.createElement('canvas');

        canvas.width = image.width;
        canvas.height = image.height;

        const context = canvas.getContext('2d');

        if (!context) {
          return { matching: -1, total: 0, target: [] as number[], background: '' };
        }

        context.drawImage(image, 0, 0);

        const raw = context.getImageData(0, 0, image.width, image.height).data;
        const counts = new Map<string, number>();

        for (let i = 0; i < raw.length; i += 4) {
          const key = `${raw[i]},${raw[i + 1]},${raw[i + 2]}`;

          counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        const background = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
        const under = background.split(',').map(Number);
        const target = stroke.map((c, k) => c * alpha + under[k] * (1 - alpha));
        let matching = 0;

        // Inline arithmetic: a named helper here is compiled to a call to tsx's __name, absent in the page.
        for (let i = 0; i < raw.length; i += 4) {
          const toStroke = Math.hypot(raw[i] - target[0], raw[i + 1] - target[1], raw[i + 2] - target[2]);
          const toBackground = Math.hypot(raw[i] - under[0], raw[i + 1] - under[1], raw[i + 2] - under[2]);

          if (toStroke < toBackground) {
            matching++;
          }
        }

        return { matching, total: raw.length / 4, target, background };
      },
      { data: png.toString('base64'), stroke: [r, g, b], alpha: opacity },
    );
  } finally {
    await blank.close();
  }
};

/** The X's computed stroke and its cumulative opacity up to `<html>`. */
const strokeOfX = async (page: Page) =>
  await page
    .locator(`${CLOSE} svg`)
    .first()
    .evaluate((svg) => {
      let opacity = 1;

      for (let node: Element | null = svg; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }

      return { stroke: getComputedStyle(svg).stroke, opacity };
    });

/**
 * The oracle's view of each SVG shape under `selector`, by the round 18 rule: its fill is measured only
 * where `isPointInFill` holds for at least one point of a 7 by 7 interior grid over its bounding box,
 * at (i+1)/8 of each side (an open path reports true at its box corners), and its
 * stroke only when the computed stroke width is above 0. Each shape is tagged `data-g3-shape` so the
 * fixture's `readComputed` can read it.
 */
const paintedParts = async (page: Page, selector: string) =>
  (await page.evaluate(
    `(() => {
      const shapes = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).flatMap((root) =>
        Array.from(root.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')),
      );
      return shapes.map((shape, index) => {
        shape.setAttribute('data-g3-shape', String(index));
        const style = getComputedStyle(shape);
        let fillPaints = false;
        if (typeof shape.isPointInFill === 'function' && style.fill !== 'none') {
          const box = shape.getBBox();
          const svg = shape.ownerSVGElement;
          for (let i = 0; i < 7 && !fillPaints; i++) {
            for (let j = 0; j < 7 && !fillPaints; j++) {
              const point = svg.createSVGPoint();
              point.x = box.x + (box.width * (i + 1)) / 8;
              point.y = box.y + (box.height * (j + 1)) / 8;
              fillPaints = shape.isPointInFill(point);
            }
          }
        }
        const strokeWidth = parseFloat(style.strokeWidth) || 0;
        return {
          index,
          tag: shape.tagName.toLowerCase(),
          fill: style.fill,
          stroke: style.stroke,
          fillPaints,
          strokePaints: style.stroke !== 'none' && strokeWidth > 0,
        };
      });
    })()`,
  )) as { index: number; tag: string; fill: string; stroke: string; fillPaints: boolean; strokePaints: boolean }[];

/** A shape's pair without its own layer: CSS backgrounds do not paint on SVG shapes. */
const shapePair = (pair: ComputedPair): ComputedPair => ({ ...pair, layers: pair.layers.slice(1) });

/** The oracle's lowest ratio over the painted fills and strokes under `selector`, with the detail. */
const oracleOfShapes = async (page: Page, selector: string) => {
  const parts = await paintedParts(page, selector);
  const measured: { index: number; kind: 'fill' | 'stroke'; ratio: number }[] = [];

  for (const part of parts) {
    const pair = shapePair(await readComputed(page, `[data-g3-shape="${part.index}"]`));

    if (part.fillPaints) {
      measured.push({ index: part.index, kind: 'fill', ratio: readability(pair, 'fill').ratio });
    }

    if (part.strokePaints) {
      measured.push({ index: part.index, kind: 'stroke', ratio: readability(pair, 'stroke').ratio });
    }
  }

  return { parts, measured, lowest: Math.min(...measured.map((m) => m.ratio)) };
};

const WIDTH_DROPPED = [
  'border:4px solid red',
  'border-width:thick',
  'border-width:0.5em',
  'outline:1rem solid red',
  'border-left:5px solid red',
];

const WIDTH_KEPT = [
  'border:3px solid red',
  'border:thin solid red',
  'border:medium solid red',
  'border:solid red',
  'outline:2px solid red',
];

/** The property a declaration sets, for matching its warning. */
const propertyOf = (declaration: string) => declaration.slice(0, declaration.indexOf(':'));

test.describe('[BRANDING_CONTRAST]: border widths at control scale', () => {
  /**
   * Catches: a border wide enough to consume a 16px icon's content box kept at save or render, so the
   * close button's X disappears while the guard, which measures colours and the outer box, reads 4.67:1.
   * Painting is judged from the screenshot: at least 20 pixels of the X's stroke colour.
   */
  test('C105 the icon-consuming border is dropped and the X paints', async ({ page }, testInfo) => {
    const rule = '[data-testid=btn-dialog-close] svg{border:8px solid transparent}';
    const css = `${MARKER}\n${rule}`;
    const token = await seedSigningToken(admin, 'c105');

    // Premise: with no tenant stylesheet the X paints at least 20 pixels of its stroke colour.
    await openSigning(page, token);
    await openReject(page);

    const baselineStroke = await strokeOfX(page);
    const baseline = await pixelsOf(page, CLOSE, baselineStroke.stroke, baselineStroke.opacity);

    expect(baseline.matching, `premise: the default X paints ${JSON.stringify(baseline)}`).toBeGreaterThanOrEqual(20);

    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await seedRow(css);

    const status = await openSigning(page, token);

    await installMarker(page);
    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const weight = await markerWeight(page);
    const stroke = await strokeOfX(page);
    const painted = await pixelsOf(page, CLOSE, stroke.stroke, stroke.opacity);
    const box = await page
      .locator(`${CLOSE} svg`)
      .first()
      .evaluate((svg) => {
        const style = getComputedStyle(svg);

        return { borderTopWidth: style.borderTopWidth, width: style.width, height: style.height };
      });

    await writeEvidence(testInfo, 'c105', {
      status,
      save: { status: save.status, warnings: save.cssWarnings },
      stored,
      rendered,
      baselineStroke,
      baseline,
      markerWeight: weight,
      guard: await guardReasons(page),
      stroke,
      painted,
      box,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect
      .soft(propertyWarningsFor(save.cssWarnings, 'border', 2), 'a property warning names border on line 2')
      .toHaveLength(1);

    for (const [where, text] of [
      ['saved', stored],
      ['rendered', rendered],
    ] as const) {
      expect.soft(text, `${where}: the 8px border is dropped`).not.toContain('8px');
    }

    expect
      .soft(
        weight !== '700' || painted.matching >= 20,
        `the X paints (${painted.matching} pixels of ${stroke.stroke} at ${stroke.opacity}), or the stylesheet is disabled (marker ${weight})`,
      )
      .toBe(true);
  });

  /**
   * Catches: a width above 3px, `thick`, or a non-px unit kept under any border or outline property;
   * the drop without a `value` warning; the rule's other declarations or `.keep` lost with it.
   */
  test('C105-dropped wide, thick and non-px widths are dropped beside .keep', async ({
    request: _request,
  }, testInfo) => {
    const rules = WIDTH_DROPPED.map((d, i) => `.w105-${i}{${d};border-color:rgb(1, 2, 3)}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c105-dropped', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);

    WIDTH_DROPPED.forEach((declaration, i) => {
      expect
        .soft(
          propertyWarningsFor(save.cssWarnings, propertyOf(declaration), i + 2),
          `${declaration}: a property warning on line ${i + 2}`,
        )
        .toHaveLength(1);

      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect
          .soft(blockOf(text, `.w105-${i}`), `${where}: ${declaration} is dropped, border-color kept`)
          .toBe('border-color:rgb(1,2,3)');
      }
    });
  });

  /**
   * Round 19 (C110) restates this former control: `border` and `outline` left the allowlist, so even
   * widths at control scale are dropped with a `property` warning. Catches: a shorthand kept.
   */
  test('C105-kept widths at control scale are now dropped with a property warning', async ({
    request: _request,
  }, testInfo) => {
    const rules = WIDTH_KEPT.map((d, i) => `.k105-${i}{${d}}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c105-kept', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);

    WIDTH_KEPT.forEach((declaration, i) => {
      expect
        .soft(
          propertyWarningsFor(save.cssWarnings, propertyOf(declaration), i + 2),
          `${declaration}: a property warning on line ${i + 2}`,
        )
        .toHaveLength(1);

      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect.soft(blockOf(text, `.k105-${i}`) ?? '', `${where}: ${declaration} is dropped`).toBe('');
      }
    });
  });
});

test.describe('[BRANDING_CONTRAST]: only painted SVG fill is measured', () => {
  const PAYLOAD = [
    MARKER,
    '[data-testid=btn-dialog-close] svg{background-color:#213871;stroke:#fff}',
    '[data-testid=btn-dialog-close] path{fill:currentcolor}',
  ].join('\n');
  const CONTROL_PAYLOAD = [
    MARKER,
    '[data-testid=btn-dialog-close] svg{background-color:#213871;stroke:#fff}',
    '[data-g3-filled]{fill:#fff;background-color:#213871}',
  ].join('\n');

  /**
   * Catches: a guard that measures the X's fill although its paths are open lines enclosing no area, so
   * the unpainted fill reads 1:1 and a readable stylesheet is disabled. The X itself (white stroke on
   * #213871, about 4.67:1 by Codex's measure) must read at least 3:1 by the round 18 oracle.
   */
  test('C106 an unpainted fill leaves a readable stylesheet applied', async ({ page }, testInfo) => {
    const token = await seedSigningToken(admin, 'c106');

    await seedRow(PAYLOAD);
    await openSigning(page, token);
    await installMarker(page);
    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const weight = await markerWeight(page);
    const guard = await guardReasons(page);
    const oracle = await oracleOfShapes(page, CLOSE);

    await writeEvidence(testInfo, 'c106', {
      css: PAYLOAD,
      rendered: render(PAYLOAD),
      markerWeight: weight,
      guard,
      oracle,
    });

    expect(oracle.parts.length, 'premise: the X has shapes').toBeGreaterThan(0);
    expect
      .soft(
        oracle.parts.every((p) => !p.fillPaints),
        'premise: no X path encloses fill area',
      )
      .toBe(true);
    expect.soft(render(PAYLOAD), 'premise: the render keeps the payload').toContain('fill:currentcolor');
    expect.soft(weight, 'the stylesheet stays applied after a three-second settle').toBe('700');
    expect.soft(guard, 'no guard reason on the page').toEqual([]);
    expect
      .soft(oracle.lowest, `the X reads at least 3:1 (${oracle.lowest.toFixed(2)}:1)`)
      .toBeGreaterThanOrEqual(BRANDING_CONTRAST_THRESHOLD);
  });

  /**
   * Control: a closed filled shape painted `#fff` on the white dialog is still measured, and the
   * stylesheet is disabled. If the page already has a filled icon (one whose fill passes the round 18
   * test) it is used; otherwise a test-owned `<button><svg><rect width="10" height="10"/></svg></button>`
   * is added to the dialog as it mounts. The stylesheet omits the payload's path fill rule, so the
   * disable can only come from that shape. The fill comes from the tenant stylesheet, since a fill the
   * test sets itself is not the tenant's doing: `[data-g3-filled]{fill:#fff;background-color:#213871}`
   * passes the save check as a pair, but CSS backgrounds do not paint on SVG shapes, so the white fill
   * lands on the white dialog. A guard that counts the shape's own background reads it as readable.
   */
  test('C106-control a closed filled shape is still measured and disables the stylesheet', async ({
    page,
  }, testInfo) => {
    const token = await seedSigningToken(admin, 'c106-control');

    // Without the path fill rule, so on any build the disable can only come from the filled shape.
    await seedRow(CONTROL_PAYLOAD);
    await openSigning(page, token);
    await installMarker(page);

    // Before the dialog opens, so the shape is in place when the guard first sees the dialog.
    await page.evaluate(`(() => {
      const ns = 'http://www.w3.org/2000/svg';
      const fillsPaint = (shape) => {
        if (typeof shape.isPointInFill !== 'function' || getComputedStyle(shape).fill === 'none') {
          return false;
        }
        const box = shape.getBBox();
        const svg = shape.ownerSVGElement;
        for (let i = 0; i < 7; i++) {
          for (let j = 0; j < 7; j++) {
            const point = svg.createSVGPoint();
            point.x = box.x + (box.width * (i + 1)) / 8;
            point.y = box.y + (box.height * (j + 1)) / 8;
            if (shape.isPointInFill(point)) {
              return true;
            }
          }
        }
        return false;
      };
      const arm = (dialog) => {
        if (dialog.querySelector('[data-g3-filled]')) {
          return;
        }
        const existing = Array.from(dialog.querySelectorAll('svg *')).find(
          (shape) => !shape.closest('[data-testid=btn-dialog-close]') && fillsPaint(shape),
        );
        let shape = existing;
        if (!shape) {
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('aria-label', 'g3 filled control');
          const svg = document.createElementNS(ns, 'svg');
          svg.setAttribute('width', '10');
          svg.setAttribute('height', '10');
          shape = document.createElementNS(ns, 'rect');
          shape.setAttribute('width', '10');
          shape.setAttribute('height', '10');
          svg.appendChild(shape);
          button.appendChild(svg);
          dialog.appendChild(button);
        }
        shape.setAttribute('data-g3-filled', existing ? 'existing' : 'owned');
      };
      new MutationObserver(() => {
        const dialog = document.querySelector('[role=dialog]');
        if (dialog) {
          arm(dialog);
        }
      }).observe(document.body, { childList: true, subtree: true });
    })()`);

    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const which = await page.evaluate(
      () => document.querySelector('[data-g3-filled]')?.getAttribute('data-g3-filled') ?? null,
    );
    const parts = await paintedParts(page, 'svg:has([data-g3-filled])');
    const filled = parts.find((p) => p.fillPaints);
    // The guard may already have removed the stylesheet, so the oracle judges the rule's fill against
    // the shape's painted ancestors rather than reading the computed fill.
    const pair = shapePair(await readComputed(page, '[data-g3-filled]'));
    const oracle = readability({ ...pair, fill: 'rgb(255, 255, 255)' }, 'fill');
    const weight = await markerWeight(page);
    const guard = await guardReasons(page);

    await writeEvidence(testInfo, 'c106-control', { which, filled, oracle, markerWeight: weight, guard });

    // Premise: the shape is there, its fill paints, and the oracle measures it below 3:1.
    expect(which, 'premise: a filled shape is in the dialog').not.toBeNull();
    expect(filled, 'premise: its fill paints by the round 18 test').toBeDefined();
    expect(oracle.ratio, 'premise: the oracle measures the fill below 3:1').toBeLessThan(BRANDING_CONTRAST_THRESHOLD);
    expect.soft(weight, 'the stylesheet is disabled').not.toBe('700');
  });
});
