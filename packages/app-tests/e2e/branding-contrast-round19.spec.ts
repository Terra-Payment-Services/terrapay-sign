/**
 * Colour-only borders and named fonts (round 19).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 19: recolour
 * existing borders only, and named fonts only", without reading the sanitiser, the guard or its
 * measurement.
 *
 * | Criterion | Test                                                                            |
 * | --------- | ------------------------------------------------------------------------------- |
 * | 108       | C108 Codex round 18's nested borders on a checked checkbox, saved and seeded    |
 * | 108       | C108-removed each removed border/outline property; C108-colours the six kept    |
 * | 109       | C109-dropped symbol and unlisted fonts; C109-kept listed fonts                  |
 * | 110       | round 18's C105 restated; the lib test's shorthands and an unlisted font        |
 *
 * `.keep` is `.keep{background-color:#fff;color:#000}`, as in round 16.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  openAdminSession,
  resetBranding,
  saveOrganisationSettings,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round19');
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

/** The `value` warnings that name `property` and sit on `line` of the submitted stylesheet. */
const valueWarningsFor = (
  warnings: { kind: string; detail: string; line?: number }[],
  property: string,
  line: number,
) => warnings.filter((w) => w.kind === 'value' && w.detail.includes(`"${property}"`) && w.line === line);

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

/**
 * How many pixels of a screenshot of `selector` show the stroke colour `rgb` as painted: composited at
 * `opacity` (the shape's cumulative opacity) over the box's most common pixel, a pixel counting when it
 * is nearer that colour than the background. A 2px stroke on a 16px icon is anti-aliased at 1x, so few
 * pixels match the colour exactly (16 within 24 per channel on the default X).
 * Decoded on a blank page in the same context, which has no CSP to refuse the data URL.
 */
const pixelsOf = async (page: Page, selector: string, rgb: string, opacity: number, inset = 0) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
  const box = await page.locator(selector).first().boundingBox();

  if (!box) {
    throw new Error(`no box for ${selector}`);
  }

  const png = await page.screenshot({
    animations: 'disabled',
    clip: { x: box.x + inset, y: box.y + inset, width: box.width - 2 * inset, height: box.height - 2 * inset },
  });
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

/** The `property` warnings that name `property` and sit on `line` of the submitted stylesheet. */
const propertyWarningsFor = (
  warnings: { kind: string; detail: string; line?: number }[],
  property: string,
  line: number,
) => warnings.filter((w) => w.kind === 'property' && w.detail.includes(property) && w.line === line);

/** A pending document whose one recipient has a signature field and a checkbox field. */
const seedCheckboxToken = async (label: string) => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
  const { recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: admin.teamId,
    recipients: [`g3-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.documenso.com`],
    fields: [FieldType.SIGNATURE, FieldType.CHECKBOX],
  });

  return recipients[0].token;
};

const CHECKED = '[role=checkbox][data-state=checked]';

/**
 * Pixels trimmed from each side of the checkbox before counting: its rounded corners show the white page,
 * which is also the checkmark's stroke colour, and the checkmark's svg box overhangs the checkbox.
 */
const INSET = 2;

/** The checkmark's computed stroke and cumulative opacity up to `<html>`. */
const strokeOfCheck = async (page: Page) =>
  await page
    .locator(`${CHECKED} svg`)
    .first()
    .evaluate((svg) => {
      let opacity = 1;

      for (let node: Element | null = svg; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }

      const box = svg.getBoundingClientRect();
      const style = getComputedStyle(svg);

      return {
        stroke: style.stroke,
        opacity,
        box: { width: box.width, height: box.height },
        content: {
          width: box.width - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth),
        },
      };
    });

const REMOVED: string[] = [
  'border:1px solid red',
  'border-top:1px solid red',
  'border-right:1px solid red',
  'border-bottom:1px solid red',
  'border-left:1px solid red',
  'border-style:solid',
  'border-width:1px',
  'border-top-style:solid',
  'border-right-style:solid',
  'border-bottom-style:solid',
  'border-left-style:solid',
  'border-top-width:1px',
  'border-right-width:1px',
  'border-bottom-width:1px',
  'border-left-width:1px',
  'outline:1px solid red',
  'outline-style:solid',
  'outline-width:1px',
];

const COLOURS = [
  'border-color:#123456',
  'border-top-color:#123456',
  'border-right-color:#123456',
  'border-bottom-color:#123456',
  'border-left-color:#123456',
  'outline-color:#123456',
];

const propertyOf = (declaration: string) => declaration.slice(0, declaration.indexOf(':'));

test.describe('[BRANDING_CONTRAST]: borders and outlines are colour only', () => {
  /**
   * Catches: nested 3px borders on a checked checkbox, its span and its svg, kept at save or render,
   * which shrink the 12px checkmark's content box to nothing while the guard reads the vanished stroke
   * at 11.24:1. Painting is judged from a screenshot of the checkbox inset by `INSET`, counted as in C105.
   */
  test('C108 nested borders are dropped and the checkmark paints', async ({ browser }, testInfo) => {
    // At 1x the 12px checkbox's tick covers about 14 pixels inside the inset, under C105's 20; at 2x it
    // covers about four times that, so the threshold keeps its meaning.
    const context = await browser.newContext({ deviceScaleFactor: 2, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const rule = '[role=checkbox],[role=checkbox] span,[role=checkbox] svg{border:3px solid transparent}';
    const css = `${MARKER}\n${rule}`;
    const token = await seedCheckboxToken('c108');

    // Check the field with no tenant stylesheet; the server records it, so it stays checked on reload.
    await openSigning(page, token);
    await page.locator('[role=checkbox]').first().click();
    await expect(page.locator(CHECKED).first(), 'premise: the checkbox field is checked').toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(1_000);

    const baselineStroke = await strokeOfCheck(page);
    const baseline = await pixelsOf(page, CHECKED, baselineStroke.stroke, baselineStroke.opacity, INSET);

    expect(
      baseline.matching,
      `premise: the default checkmark paints ${JSON.stringify(baseline)}`,
    ).toBeGreaterThanOrEqual(20);

    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await seedRow(css);
    await openSigning(page, token);
    await installMarker(page);
    await expect(page.locator(CHECKED).first(), 'premise: still checked after reload').toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(SETTLE_MS);

    const weight = await markerWeight(page);
    const stroke = await strokeOfCheck(page);
    const painted = await pixelsOf(page, CHECKED, stroke.stroke, stroke.opacity, INSET);

    await writeEvidence(testInfo, 'c108', {
      save: { status: save.status, warnings: save.cssWarnings },
      stored,
      rendered,
      baselineStroke,
      baseline,
      markerWeight: weight,
      stroke,
      painted,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect
      .soft(propertyWarningsFor(save.cssWarnings, 'border', 2), 'a property warning names border on line 2')
      .toHaveLength(1);

    for (const [where, text] of [
      ['saved', stored],
      ['rendered', rendered],
    ] as const) {
      expect.soft(text, `${where}: the nested border is dropped`).not.toMatch(/border:/);
    }

    expect
      .soft(
        weight !== '700' || painted.matching >= 20,
        `the checkmark paints (${painted.matching} pixels of ${stroke.stroke} at ${stroke.opacity}), or the stylesheet is disabled (marker ${weight})`,
      )
      .toBe(true);

    await context.close();
  });

  /** Catches: any removed border or outline property kept, or dropped without a property warning or with `.keep`. */
  test('C108-removed every border and outline shape property is dropped beside .keep', async ({
    request: _request,
  }, testInfo) => {
    const rules = REMOVED.map((d, i) => `.b108-${i}{${d};border-color:rgb(1, 2, 3)}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c108-removed', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);

    REMOVED.forEach((declaration, i) => {
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
          .soft(blockOf(text, `.b108-${i}`), `${where}: ${declaration} is dropped, border-color kept`)
          .toBe('border-color:rgb(1,2,3)');
      }
    });
  });

  /** Catches: a colour-only rule so broad that the six colour properties are refused. Control. */
  test('C108-colours the six border and outline colour properties are kept with no warning', async ({
    request: _request,
  }, testInfo) => {
    const rules = COLOURS.map((d, i) => `.c108-${i}{${d}}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c108-colours', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(save.cssWarnings, 'no warning').toEqual([]);

    COLOURS.forEach((declaration, i) => {
      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect.soft(blockOf(text, `.c108-${i}`), `${where}: ${declaration} is kept`).toBe(declaration);
      }
    });
  });
});

test.describe('[BRANDING_CONTRAST]: named fonts only', () => {
  const DROPPED = [
    'Wingdings',
    '"Webdings"',
    'Symbol',
    "'Zapf Dingbats'",
    'Marlett',
    'Comic Sans MS',
    'Arial, Wingdings',
    'W\\69 ngdings',
  ];
  const KEPT = [
    'Arial',
    '"Helvetica Neue", Arial, sans-serif',
    'GEORGIA',
    'system-ui',
    "'Times New Roman', serif",
    // Amendment after the round 19 red run: exactly one CSS-wide keyword is kept.
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
  ];

  /** Catches: a symbol or unlisted family kept, alone or after a listed one, or behind an escape. */
  test('C109-dropped symbol and unlisted fonts are dropped with a value warning', async ({
    request: _request,
  }, testInfo) => {
    const rules = DROPPED.map((v, i) => `.f109-${i}{font-family:${v};border-color:rgb(1, 2, 3)}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c109-dropped', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);

    DROPPED.forEach((value, i) => {
      expect
        .soft(valueWarningsFor(save.cssWarnings, 'font-family', i + 2), `${value}: a value warning on line ${i + 2}`)
        .toHaveLength(1);

      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect
          .soft(blockOf(text, `.f109-${i}`), `${where}: font-family:${value} is dropped, border-color kept`)
          .toBe('border-color:rgb(1,2,3)');
      }
    });
  });

  /** Catches: a list check that refuses listed families, case-folded names, quotes or generics. Control. */
  test('C109-kept listed fonts are kept with no warning', async ({ request: _request }, testInfo) => {
    const rules = KEPT.map((v, i) => `.k109-${i}{font-family:${v}}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c109-kept', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(save.cssWarnings, 'no warning').toEqual([]);

    KEPT.forEach((value, i) => {
      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect
          .soft(blockOf(text, `.k109-${i}`), `${where}: font-family:${value} is kept`)
          .toBe(squash(`font-family:${value}`));
      }
    });
  });
});
