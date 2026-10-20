/**
 * Control boundaries, and font names read as Chromium reads them (round 20).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 20: control
 * boundaries, and font names read as Chromium reads them", without reading the sanitiser, the guard or
 * its measurement.
 *
 * | Criterion | Test                                                                               |
 * | --------- | ---------------------------------------------------------------------------------- |
 * | 111       | C111-<case> an unchecked checkbox hidden or kept visible, guard verdict and oracle |
 * | 112       | C112-dropped and C112-kept font names                                              |
 * | 113       | round 10 C70, round 11 C77, round 14 C89a also measured with control boundaries    |
 *
 * The oracle for C111 is `readControlBoundaries` in fixtures/branding-contrast.ts; every case records its
 * measured values, the baseline from the same page with no tenant stylesheet, and the guard's verdict.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  boundaryFailures,
  openAdminSession,
  readControlBoundaries,
  resetBranding,
  saveOrganisationSettings,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round20');
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

/** Every element carrying `data-branding-guard`, as `tag=reason`. */
const guardReasons = async (page: Page) =>
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-branding-guard]')).map(
      (element) => `${element.tagName.toLowerCase()}=${element.getAttribute('data-branding-guard')}`,
    ),
  );

/** A test-owned, nonced stylesheet in the raised wrapper, as the render nests it, never seen by the guard. */
const injectUnguarded = async (page: Page, css: string) =>
  await page.evaluate((text) => {
    const style = document.createElement('style');
    const nonced = Array.from(document.querySelectorAll<HTMLElement>('script,style')).find((element) => element.nonce);

    style.nonce = nonced?.nonce ?? '';
    style.id = 'g3-unguarded';
    style.textContent = `.documenso-branded.documenso-branded.documenso-branded{${text}}`;
    document.head.appendChild(style);
  }, css);

const removeUnguarded = async (page: Page) =>
  await page.evaluate(() => {
    document.getElementById('g3-unguarded')?.remove();
  });

/** A pending document whose one recipient has a signature field and an unchecked checkbox field. */
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

const UNCHECKED = '[role=checkbox][data-state=unchecked]';

/**
 * The spec's background-only rules (`[role=checkbox]{background-color:#fff}`, `body,div{...}`) do not
 * survive: a lone background is checked against the default text colour and the save and render drop it
 * (red-r20/probe.log). Each background therefore carries a readable text colour, which leaves the
 * boundary geometry the spec describes unchanged.
 */
type BoundaryCase = {
  id: string;
  rules: string[];
  /** `disabled` or `applied`; `oracle` takes the verdict from the oracle and records it (the spec's control clause). */
  expected: 'disabled' | 'applied' | 'oracle';
  note: string;
};

const BOUNDARY_CASES: BoundaryCase[] = [
  {
    id: 'transparent-border',
    rules: ['[role=checkbox]{border-color:transparent}'],
    expected: 'disabled',
    note: "Codex round 19's payload: the unchecked checkbox's border vanishes into the white page.",
  },
  {
    id: 'white-on-white',
    rules: ['[role=checkbox]{background-color:#fff;color:#000}', 'body,div{background-color:#fff;color:#000}'],
    expected: 'oracle',
    note: 'The spec expects a disable unless the app border reads at least 3:1 on white; the oracle decides.',
  },
  {
    id: 'border-matches-surround',
    rules: ['[role=checkbox]{background-color:#213871;color:#fff}', 'body,div{background-color:#213871;color:#fff}'],
    expected: 'disabled',
    note: "The checkbox and its surround are one colour, against the app's unchecked border.",
  },
  {
    id: 'border-matches-field',
    rules: [
      '[role=checkbox]{background-color:#213871;color:#fff}',
      '[data-field-type=CHECKBOX],[data-field-type=CHECKBOX] div{background-color:#213871;color:#fff}',
    ],
    expected: 'disabled',
    note: 'The same, with the surround limited to the checkbox field, so page text stays on white.',
  },
  { id: 'no-tenant-css', rules: [], expected: 'applied', note: 'Control: the marker alone.' },
  {
    id: 'black-border',
    rules: ['[role=checkbox]{border-color:#000}'],
    expected: 'applied',
    note: 'Control: a black border on white reads 21:1.',
  },
];

test.describe('[BRANDING_CONTRAST]: control boundaries', () => {
  for (const c of BOUNDARY_CASES) {
    /**
     * Catches: a guard with nothing to measure on an unchecked checkbox, which carries neither text nor an
     * SVG, so a border recoloured to match its surround hides the control while the stylesheet stays on;
     * and, for the controls, a boundary rule that disables a readable stylesheet.
     */
    test(`C111-${c.id} ${c.note}`, async ({ page }, testInfo) => {
      const css = [MARKER, ...c.rules].join('\n');
      const token = await seedCheckboxToken(`c111-${c.id}`);

      // Baseline: the same page with no tenant stylesheet.
      await openSigning(page, token);
      await expect(page.locator(UNCHECKED).first(), 'premise: an unchecked checkbox is on the page').toBeVisible({
        timeout: 15_000,
      });

      const baseline = await readControlBoundaries(page);
      const baselineCheckbox = baseline.filter((b) => b.role === 'checkbox');

      expect(baselineCheckbox.length, 'premise: the oracle measures the checkbox').toBeGreaterThan(0);

      // The oracle's prediction, from the same rules applied unguarded.
      await injectUnguarded(page, c.rules.join('\n'));

      const predicted = await readControlBoundaries(page);
      const predictedVerdict = boundaryFailures(predicted, baseline);

      await removeUnguarded(page);

      // The rules survive save and render, so the stored row is what the guard sees.
      const save = await saveOrganisationSettings(admin, { brandingCss: css });
      const rendered = render(css);

      await seedRow(css);

      const status = await openSigning(page, token);

      await installMarker(page);
      await page.waitForTimeout(SETTLE_MS);

      const weight = await markerWeight(page);
      const guard = await guardReasons(page);
      const expected =
        c.expected === 'oracle' ? (predictedVerdict.failing.length > 0 ? 'disabled' : 'applied') : c.expected;

      await writeEvidence(testInfo, `c111-${c.id}`, {
        css,
        save: { status: save.status, warnings: save.cssWarnings },
        rendered,
        status,
        baseline,
        predicted,
        predictedVerdict,
        expected,
        markerWeight: weight,
        guard,
      });

      expect.soft(save.status, 'premise: the save answers 200').toBe(200);
      expect.soft(save.cssWarnings, 'premise: the save drops nothing').toEqual([]);

      for (const rule of c.rules) {
        expect.soft(rendered, `premise: the render keeps ${rule}`).toContain(squash(rule));
      }

      if (c.expected !== 'oracle') {
        expect
          .soft(predictedVerdict.failing.length > 0 ? 'disabled' : 'applied', 'the oracle agrees with the spec')
          .toBe(c.expected);
      }

      if (expected === 'disabled') {
        expect.soft(weight, 'the stylesheet is disabled').not.toBe('700');
      } else {
        expect.soft(weight, 'the stylesheet stays applied').toBe('700');
        expect.soft(guard, 'no guard reason on the page').toEqual([]);
      }
    });
  }
});

test.describe('[BRANDING_CONTRAST]: font names as Chromium reads them', () => {
  const DROPPED = ['Arial\\,Georgia', '"inherit"', "'initial'", 'Ari\\61l', '"Ari\\\nal"'];
  const KEPT = ['inherit', '"Arial"', "'Times New Roman', serif"];

  /**
   * Catches: escapes decoded before splitting (`Arial\,Georgia` read as two listed families, where
   * Chromium reads one family `Arial,Georgia`), a quoted keyword taken for the keyword, and any value with
   * a backslash kept.
   */
  test('C112-dropped font names with a backslash or a quoted keyword are dropped', async ({
    request: _request,
  }, testInfo) => {
    const rules = DROPPED.map((v, i) => `.f112-${i}{font-family:${v};border-color:rgb(1, 2, 3)}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);
    // The continuation spans two lines, so each rule's line is counted from the submitted text.
    const lineOf = (i: number) => css.slice(0, css.indexOf(`.f112-${i}{`)).split('\n').length;

    await writeEvidence(testInfo, 'c112-dropped', {
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
        .soft(
          valueWarningsFor(save.cssWarnings, 'font-family', lineOf(i)),
          `${JSON.stringify(value)}: a value warning on line ${lineOf(i)}`,
        )
        .toHaveLength(1);

      for (const [where, text] of [
        ['saved', stored],
        ['rendered', rendered],
      ] as const) {
        expect
          .soft(blockOf(text, `.f112-${i}`), `${where}: font-family:${JSON.stringify(value)} is dropped`)
          .toBe('border-color:rgb(1,2,3)');
      }
    });
  });

  /** Control: an unquoted keyword, a quoted listed family and a quoted list stay. */
  test('C112-kept an unquoted keyword and quoted listed families are kept', async ({ request: _request }, testInfo) => {
    const rules = KEPT.map((v, i) => `.k112-${i}{font-family:${v}}`);
    const css = [KEEP, ...rules].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c112-kept', {
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
          .soft(blockOf(text, `.k112-${i}`), `${where}: font-family:${value} is kept`)
          .toBe(squash(`font-family:${value}`));
      }
    });
  });
});
