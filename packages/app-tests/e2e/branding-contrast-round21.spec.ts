/**
 * No erasure under the margin, fields always bounded, and a readable input token (round 21).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 21: no erasure
 * under the margin, fields always bounded, and a readable input token", without reading the sanitiser,
 * the guard or its measurement.
 *
 * | Criterion | Test                                                                                |
 * | --------- | ----------------------------------------------------------------------------------- |
 * | 114       | C114-refused, C114-kept, C114-kept-grey, C114-stored, C114-erasure                  |
 * | 115       | C115-erased a test-owned faint control erased under the margin; C115-unchanged      |
 * | 116       | C116-textarea-empty, C116-textarea-typed, C116-full-name; C116-black (control)      |
 * | 117       | rounds 10 to 20 rerun with the round 21 oracle (fields always bounded, no erasure)  |
 *
 * Every guard case records the oracle's view (`readControlBoundaries`, `boundaryFailures`) of the same
 * page with and without the tenant stylesheet, beside the guard's verdict.
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
  type ControlBoundary,
  errorBodyHasCode,
  hslTriplet,
  near,
  openAdminSession,
  type Rgba,
  readBodyVars,
  readControlBoundaries,
  readOrganisationBranding,
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
  admin = await openAdminSession(browser, testInfo, 'round21');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
const MARKER = '.g3-marker{font-weight:700}';
const SETTLE_MS = 3_000;

const squash = (css: string) => css.replace(/\s+/g, '');

const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));

const seedRow = async (css: string) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: css, brandingColors: TOKENS },
  });
};

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

const seedRowWith = async (css: string, colors: Record<string, string>) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: css, brandingColors: colors },
  });
};

const openReject = async (page: Page) => {
  await page.getByRole('button', { name: 'Reject Document' }).first().click();
  await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
};

/** Waits for the fields' click overlays, which the oracle excludes only when the baseline holds them. */
const fieldsMounted = async (page: Page) => {
  await page.locator('[data-field-type] button').first().waitFor();
  await page.waitForTimeout(500);
};

/** The guard's verdict and the oracle's, on a page already showing the tenant stylesheet. */
const verdict = async (page: Page, baseline: ControlBoundary[]) => {
  const weight = await markerWeight(page);
  const guard = await guardReasons(page);
  const oracle = boundaryFailures(await readControlBoundaries(page), baseline);

  return { weight, guard, oracle };
};

/** Only the controls that matter to a case, to keep the evidence readable. */
const pick = (list: ControlBoundary[], match: (c: ControlBoundary) => boolean) =>
  list.filter(match).map((c) => ({ key: c.key, ratio: c.ratio, boundaryPaints: c.boundaryPaints, sides: c.sides }));

test.describe('[BRANDING_CONTRAST]: the input token', () => {
  /** Catches: an `input` token too faint on the background accepted, as other channel B pairs are not. */
  for (const value of ['#f5f5f5', '#ffffff', '#000000']) {
    test(`C114-refused input ${value} on a default background is refused naming the pair`, async ({
      request: _request,
    }, testInfo) => {
      const before = await readOrganisationBranding(admin);
      const save = await saveOrganisationSettings(admin, { brandingColors: { input: value } });
      const after = await readOrganisationBranding(admin);

      await writeEvidence(testInfo, `c114-refused-${value.slice(1)}`, {
        status: save.status,
        text: save.text,
        before,
        after,
      });

      expect.soft(save.status, 'refused, not saved').not.toBe(200);
      expect.soft(errorBodyHasCode(save.body, 'INVALID_BODY'), `INVALID_BODY: ${save.text.slice(0, 300)}`).toBe(true);
      expect.soft(save.text, 'the warning names the input token').toMatch(/input/i);
      expect.soft(save.text, 'the warning names the background it is paired with').toMatch(/background/i);
      expect.soft(after, 'the row is unchanged').toEqual(before);
    });
  }

  /** Control: the default and a mid grey pass in both themes. */
  test('C114-kept input #6e7586 is kept', async ({ request: _request }, testInfo) => {
    const save = await saveOrganisationSettings(admin, { brandingColors: { input: '#6e7586' } });
    const after = await readOrganisationBranding(admin);

    await writeEvidence(testInfo, 'c114-kept', { status: save.status, text: save.text, after });

    expect.soft(save.status, `kept: ${save.text.slice(0, 300)}`).toBe(200);
    expect.soft((after.brandingColors as Record<string, string> | null)?.input, 'the token is stored').toBe('#6e7586');
  });

  /**
   * The second control, #808080 since the amendment after the round 21 red run: it reads about 3.9:1 on
   * the light default and about 4.5:1 on the dark default (#000000, refused above, reads about 1.2:1 there).
   */
  test('C114-kept-grey input #808080 is kept', async ({ request: _request }, testInfo) => {
    const save = await saveOrganisationSettings(admin, { brandingColors: { input: '#808080' } });
    const after = await readOrganisationBranding(admin);

    await writeEvidence(testInfo, 'c114-kept-grey', { status: save.status, text: save.text, after });

    expect.soft(save.status, `kept: ${save.text.slice(0, 300)}`).toBe(200);
    expect.soft((after.brandingColors as Record<string, string> | null)?.input, 'the token is stored').toBe('#808080');
  });

  /** Catches: a faint `input` token stored before the rule still reaching the signing page. */
  test('C114-stored a stored faint input token renders the default', async ({ page }, testInfo) => {
    await seedRowWith('', { input: '#f5f5f5' });

    const token = await seedSigningToken(admin, 'c114-stored');

    await openSigning(page, token);

    const vars = await readBodyVars(page, ['--input']);
    const rendered = hslTriplet(vars['--input']);

    await writeEvidence(testInfo, 'c114-stored', { vars });

    expect
      .soft(near(rendered, { r: 0xf5, g: 0xf5, b: 0xf5, a: 1 } as Rgba, 3), '--input is not the faint token')
      .toBe(false);
    expect
      .soft(
        near(rendered, { r: 0x6e, g: 0x75, b: 0x86, a: 1 } as Rgba, 3),
        `--input is the default (${vars['--input']})`,
      )
      .toBe(true);
  });

  /**
   * Catches: Codex round 20's first payload. With the faint token kept, the checkbox's baseline is about
   * 1.09:1, and erasing its border to 1:1 falls inside the 0.3 margin; the stylesheet must be disabled.
   */
  test('C114-erasure a stored faint token and a transparent checkbox border disable the stylesheet', async ({
    page,
  }, testInfo) => {
    const css = [MARKER, '[role=checkbox]{border-color:transparent}'].join('\n');
    const token = await seedCheckboxToken('c114-erasure');

    await seedRowWith(MARKER, { input: '#f5f5f5' });
    await openSigning(page, token);
    await expect(page.locator(UNCHECKED).first(), 'premise: an unchecked checkbox is on the page').toBeVisible({
      timeout: 15_000,
    });

    await fieldsMounted(page);

    const baseline = await readControlBoundaries(page);

    await seedRowWith(css, { input: '#f5f5f5' });
    await openSigning(page, token);
    await installMarker(page);
    await page.waitForTimeout(SETTLE_MS);

    const result = await verdict(page, baseline);

    // Recorded, not asserted: Codex measured the checkbox at about 1.09:1 under this token.
    const faintReachesCheckbox = baseline.some((c) => c.role === 'checkbox' && c.ratio < 1.3);

    await writeEvidence(testInfo, 'c114-erasure', {
      faintReachesCheckbox,
      baseline: pick(baseline, (c) => c.role === 'checkbox'),
      ...result,
    });

    expect.soft(result.weight, 'the stylesheet is disabled').not.toBe('700');
  });
});

/** Appends a test-owned checkbox-like button with the real checkbox's classes and a faint border colour. */
const addFaintControl = async (page: Page) =>
  await page.evaluate(() => {
    const real = document.querySelector('[role=checkbox]');
    const style = document.createElement('style');
    const nonced = Array.from(document.querySelectorAll<HTMLElement>('script,style')).find((element) => element.nonce);

    // (0,1,0) after the app's classes, so it beats `border-input` and loses to the tenant wrapper (0,3,1).
    style.nonce = nonced?.nonce ?? '';
    style.textContent = '.g3-faint-control{border-color:#f0f0f0}';
    document.head.appendChild(style);

    const control = document.createElement('button');

    control.type = 'button';
    control.setAttribute('role', 'checkbox');
    control.setAttribute('aria-checked', 'false');
    control.setAttribute('aria-label', 'g3 faint control');
    control.className = `${real?.getAttribute('class') ?? ''} g3-faint-control`;
    real?.parentElement?.appendChild(control);

    return { classes: control.className, mounted: Boolean(real) };
  });

test.describe('[BRANDING_CONTRAST]: no erasure under the margin', () => {
  for (const c of [
    { id: 'erased', rules: ['.g3-faint-control{border-color:transparent}'], expected: 'disabled' },
    { id: 'unchanged', rules: [], expected: 'applied' },
  ] as const) {
    /**
     * Catches: a faint control (about 1.1:1 in the baseline, inside the margin) whose border a tenant makes
     * transparent, passing because 1:1 is within 0.3 of 1.1. The guard is made to re-measure by opening
     * the reject dialog after the control mounts.
     */
    test(`C115-${c.id} a test-owned faint control, ${c.id === 'erased' ? 'its border erased' : 'left unchanged'}`, async ({
      page,
    }, testInfo) => {
      const css = [MARKER, ...c.rules].join('\n');
      const token = await seedCheckboxToken(`c115-${c.id}`);

      // Oracle baseline: no tenant stylesheet, the faint control mounted.
      await openSigning(page, token);
      await expect(page.locator(UNCHECKED).first()).toBeVisible({ timeout: 15_000 });

      const mounted = await addFaintControl(page);
      await fieldsMounted(page);

      const baseline = await readControlBoundaries(page);
      const faint = baseline.find((b) => b.key.includes('g3 faint control'));

      expect(mounted.mounted, 'premise: the real checkbox supplied the classes').toBe(true);
      expect(faint, 'premise: the oracle measures the faint control').toBeDefined();
      expect(faint?.ratio ?? 0, 'premise: the faint control paints at about 1.1:1').toBeLessThan(1.3);
      expect(faint?.boundaryPaints, 'premise: its boundary paints in the baseline').toBe(true);

      await seedRow(css);
      await openSigning(page, token);
      await installMarker(page);
      await expect(page.locator(UNCHECKED).first()).toBeVisible({ timeout: 15_000 });
      await addFaintControl(page);
      await openReject(page);
      await page.waitForTimeout(SETTLE_MS);

      const result = await verdict(page, baseline);

      await writeEvidence(testInfo, `c115-${c.id}`, {
        css,
        mounted,
        baseline: pick(baseline, (b) => b.key.includes('g3 faint control')),
        current: pick(await readControlBoundaries(page), (b) => b.key.includes('g3 faint control')),
        ...result,
      });

      if (c.expected === 'disabled') {
        expect.soft(result.weight, 'the stylesheet is disabled').not.toBe('700');
      } else {
        expect.soft(result.weight, 'the stylesheet stays applied').toBe('700');
        expect.soft(result.guard, 'no guard reason on the page').toEqual([]);
      }
    });
  }
});

test.describe('[BRANDING_CONTRAST]: fields always bounded', () => {
  /** Catches: a textarea whose placeholder exempts its boundary, so a transparent border passes. */
  test('C116-textarea-empty a transparent reason box border, placeholder showing', async ({ page }, testInfo) => {
    const css = [MARKER, 'textarea{border-color:transparent}'].join('\n');
    const token = await seedSigningToken(admin, 'c116-empty');

    await openSigning(page, token);
    await openReject(page);

    await fieldsMounted(page);

    const baseline = await readControlBoundaries(page);

    await seedRow(css);
    await openSigning(page, token);
    await installMarker(page);
    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const result = await verdict(page, baseline);

    await writeEvidence(testInfo, 'c116-textarea-empty', {
      css,
      rendered: render(css),
      baseline: pick(baseline, (b) => b.tag === 'textarea'),
      ...result,
    });

    expect.soft(render(css), 'premise: the render keeps the rule').toContain('textarea{border-color:transparent}');
    expect.soft(result.weight, 'the stylesheet is disabled').not.toBe('700');
  });

  /** Catches: a typed value exempting the boundary. */
  test('C116-textarea-typed a transparent reason box border, reason typed', async ({ page }, testInfo) => {
    const css = [MARKER, 'textarea{border-color:transparent}'].join('\n');
    const token = await seedSigningToken(admin, 'c116-typed');
    const textarea = page.getByRole('dialog').locator('textarea');

    await openSigning(page, token);
    await openReject(page);
    await textarea.fill('Not my document');

    await fieldsMounted(page);

    const baseline = await readControlBoundaries(page);

    await seedRow(css);
    await openSigning(page, token);
    await installMarker(page);
    await openReject(page);

    const atOpen = await markerWeight(page);

    await textarea.fill('Not my document');
    await expect(textarea).toHaveValue('Not my document');
    await page.waitForTimeout(SETTLE_MS);

    const result = await verdict(page, baseline);

    await writeEvidence(testInfo, 'c116-textarea-typed', {
      css,
      markerAtOpen: atOpen,
      baseline: pick(baseline, (b) => b.tag === 'textarea'),
      ...result,
    });

    expect.soft(result.weight, 'the stylesheet is disabled').not.toBe('700');
  });

  /** Catches: a filled text field's border made transparent while its value is readable. */
  test('C116-full-name a transparent border on the filled name field', async ({ page }, testInfo) => {
    const css = [MARKER, '#full-name{border-color:transparent}'].join('\n');
    const token = await seedSigningToken(admin, 'c116-name');
    const name = page.locator('#full-name');

    await openSigning(page, token);
    await expect(name, 'premise: the signing page shows the name field').toBeVisible({ timeout: 15_000 });
    await name.fill('Grace Hopper');

    await fieldsMounted(page);

    const baseline = await readControlBoundaries(page);

    await seedRow(css);
    await openSigning(page, token);
    await installMarker(page);
    await name.fill('Grace Hopper');
    await expect(name).toHaveValue('Grace Hopper');
    await page.waitForTimeout(SETTLE_MS);

    const result = await verdict(page, baseline);

    await writeEvidence(testInfo, 'c116-full-name', {
      css,
      baseline: pick(baseline, (b) => b.key.includes('full-name')),
      ...result,
    });

    expect.soft(result.weight, 'the stylesheet is disabled').not.toBe('700');
  });

  /** Control: a black reason box border stays applied, empty and typed. */
  test('C116-black a black reason box border stays applied', async ({ page }, testInfo) => {
    const css = [MARKER, 'textarea{border-color:#000}'].join('\n');
    const token = await seedSigningToken(admin, 'c116-black');
    const textarea = page.getByRole('dialog').locator('textarea');

    await openSigning(page, token);
    await openReject(page);

    await fieldsMounted(page);

    const baseline = await readControlBoundaries(page);

    await seedRow(css);
    await openSigning(page, token);
    await installMarker(page);
    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const empty = await verdict(page, baseline);

    await textarea.fill('Not my document');
    await page.waitForTimeout(SETTLE_MS);

    const typed = await verdict(page, baseline);

    await writeEvidence(testInfo, 'c116-black', { css, empty, typed });

    expect.soft(empty.weight, 'applied with the field empty').toBe('700');
    expect.soft(typed.weight, 'applied with a reason typed').toBe('700');
    expect.soft(typed.guard, 'no guard reason on the page').toEqual([]);
    expect.soft(typed.oracle.failing, 'the oracle agrees: nothing fails').toEqual([]);
  });
});
