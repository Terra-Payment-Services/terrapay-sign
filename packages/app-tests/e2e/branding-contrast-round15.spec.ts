/**
 * Opacity in the guard and the selector trailer (round 15).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 15: opacity and
 * the selector trailer", without reading the sanitiser, the guard or its measurement.
 *
 * | Criterion | Test                                                                         |
 * | --------- | ---------------------------------------------------------------------------- |
 * | 94        | C94-<dialog> a faded close icon disables the stylesheet; C94-control-<dialog> |
 * | 95        | C95-<form> a trailer outside the set drops the rule; C95-kept-<form>          |
 * | 96        | rounds 10 to 14 are existing specs, run alongside with the opacity oracle    |
 *
 * Opacity grep for signing-page controls (`git grep -n "opacity-"` over
 * apps/remix/app/components/general/document-signing, packages/ui/primitives/dialog.tsx,
 * packages/ui/primitives/signature-pad and button.tsx, excluding `disabled:` and `opacity-0` hover
 * reveals): `packages/ui/primitives/dialog.tsx:77` (`opacity-70` on the dialog close button, both
 * dialogs) is the one on a control the V1 page shows. `opacity-60` badges sit in the V2 page view and
 * the mobile widget, which the tests do not reach at 1280 px on V1.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  baseUrl,
  openAdminSession,
  readability,
  readComputed,
  resetBranding,
  type SaveResult,
  saveOrganisationSettings,
  seedSigningToken,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'round15');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
const MARKER = '.g3-marker{font-weight:700}';
const KEEP = '.keep{font-weight:700}';
const GUARD_WAIT_MS = 8_000;
const SETTLE_MS = 3_000;
const CLOSE = '[data-testid=btn-dialog-close]';
const CLOSE_ICON = '[role=dialog] [data-testid=btn-dialog-close] svg';

const squash = (css: string) => css.replace(/\s+/g, '');

const storedCss = async () =>
  (await prisma.organisationGlobalSettings.findUniqueOrThrow({ where: { id: admin.organisationGlobalSettingsId } }))
    .brandingCss ?? '';

const seedRow = async (css: string) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: css, brandingColors: TOKENS },
  });
};

const selectorWarnings = (save: SaveResult) => save.cssWarnings.filter((w) => w.kind === 'selector');

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
 * A test-owned style the guard does not own, in the raised wrapper the real render uses
 * (`.documenso-branded.documenso-branded.documenso-branded { ... }`), with the page's CSP nonce.
 */
const injectUnguarded = async (page: Page, css: string) =>
  await page.evaluate((text) => {
    const style = document.createElement('style');
    const nonced = Array.from(document.querySelectorAll<HTMLElement>('script,style')).find((element) => element.nonce);

    style.nonce = nonced?.nonce ?? '';
    style.id = 'g3-unguarded';
    style.textContent = `.documenso-branded.documenso-branded.documenso-branded{${text}}`;
    document.head.appendChild(style);
  }, css);

const DIALOGS: { id: string; open: (page: Page) => Promise<void> }[] = [
  {
    id: 'signature',
    open: async (page) => {
      await page.locator('[data-field-type=SIGNATURE]').click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    id: 'reject',
    open: async (page) => {
      await page.getByRole('button', { name: 'Reject Document' }).first().click();
      await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
    },
  },
];

const closeRule = (colour: string) => `${CLOSE}{background-color:#fff;color:${colour}}`;

test.describe('[BRANDING_CONTRAST]: opacity in the guard and the selector trailer', () => {
  for (const dialog of DIALOGS) {
    for (const variant of [
      { id: 'faded', colour: '#909090', unreadable: true },
      { id: 'control', colour: '#595959', unreadable: false },
    ]) {
      const title =
        variant.id === 'faded'
          ? `C94-${dialog.id} a #909090 close icon at opacity 0.7 disables the stylesheet`
          : `C94-control-${dialog.id} a #595959 close icon at opacity 0.7 leaves the stylesheet applied`;

      /**
       * Catches: a guard that reads the close icon's computed colour (#909090 on white, 3.2:1) and not the
       * painted colour, which the app's `opacity-70` (dialog.tsx:77) fades to about 2.16:1; a guard that
       * applies opacity to the foreground but forgets the background supplied inside the faded group; a
       * guard that over-corrects and disables a readable stylesheet (the #595959 control, about 3.42:1).
       */
      test(title, async ({ page }, testInfo) => {
        const rule = closeRule(variant.colour);
        const css = `${MARKER}\n${rule}`;
        const token = await seedSigningToken(admin, `c94-${variant.id}-${dialog.id}`);
        const evidence: Record<string, unknown> = {};

        // Premise: the rule survives the save and the render checks.
        const save = await saveOrganisationSettings(admin, { brandingCss: css });
        const stored = squash(await storedCss());
        const rendered = squash(renderStoredBrandingCss(css, TOKENS));

        evidence.save = { status: save.status, warnings: save.cssWarnings, stored, rendered };
        expect(save.status, 'premise: the save answers 200').toBe(200);
        expect(save.cssWarnings, 'premise: the save drops nothing').toEqual([]);
        expect(stored, 'premise: the stored stylesheet keeps the rule').toContain(squash(rule));
        expect(rendered, 'premise: the rendered stylesheet keeps the rule').toContain(squash(rule));

        // Premise with no tenant stylesheet: the close button's computed opacity is 0.7, and the same rule,
        // unguarded, paints the icon below or above 3:1 by the opacity-aware oracle.
        await resetBranding(admin);
        await openSigning(page, token);
        await dialog.open(page);

        const opacity = await page
          .locator(`[role=dialog] ${CLOSE}`)
          .evaluate((element) => getComputedStyle(element).opacity);

        await injectUnguarded(page, rule);

        const premise = readability(await readComputed(page, CLOSE_ICON), 'stroke');
        const premiseColour = await page.locator(`[role=dialog] ${CLOSE}`).evaluate((e) => getComputedStyle(e).color);

        evidence.premise = { opacity, colour: premiseColour, readability: premise };
        expect(opacity, 'premise: the close button has computed opacity 0.7').toBe('0.7');
        expect(premiseColour, 'premise: the test-owned style applies').not.toBe('');

        if (variant.unreadable) {
          expect(premise.ratio, 'premise: the painted icon reads under 3:1').toBeLessThan(BRANDING_CONTRAST_THRESHOLD);
        } else {
          expect(premise.ratio, 'premise: the painted icon reads at least 3:1').toBeGreaterThanOrEqual(
            BRANDING_CONTRAST_THRESHOLD,
          );
        }

        await seedRow(css);

        const status = await openSigning(page, token);

        await installMarker(page);
        await page.waitForTimeout(1_000);

        const beforeOpen = await markerWeight(page);

        await dialog.open(page);

        const weight = variant.unreadable ? await waitForDisabled(page) : await settle(page);

        evidence.page = { status, beforeOpen, markerWeight: weight };
        await writeEvidence(testInfo, `c94-${variant.id}-${dialog.id}`, evidence);

        expect.soft(status, 'the page answers 200').toBe(200);
        expect.soft(beforeOpen, 'premise: the stylesheet is applied before the dialog opens').toBe('700');

        if (variant.unreadable) {
          expect.soft(weight, 'the guard disables the stylesheet once the dialog is open').not.toBe('700');
        } else {
          expect.soft(weight, 'the stylesheet stays applied with the dialog open').toBe('700');
        }
      });
    }
  }

  const TRAILERS: { id: string; label: string; css: string; dropped: boolean }[] = [
    { id: 'comment', label: 'a comment holding :hover', css: 'button/*:hover*/{font-weight:777}', dropped: true },
    { id: 'form-feed', label: 'a form feed', css: 'button\f{font-weight:777}', dropped: true },
    { id: 'nbsp', label: 'a no-break space U+00A0', css: 'button {font-weight:777}', dropped: true },
    { id: 'space', label: 'a plain space', css: 'button {font-weight:777}', dropped: false },
    { id: 'newline', label: 'a newline', css: 'button\n{font-weight:777}', dropped: false },
  ];

  /**
   * Amended after the round 15 red run: a vertical tab is refused for the whole stylesheet already (the
   * save answers 400 and the render is empty), which fails closed like the C86 semicolon case. That
   * outcome is asserted; `.keep` is not expected to survive.
   *
   * Catches: a change that starts accepting the stylesheet, or part of it, with a vertical tab before a
   * brace, at save or at render.
   */
  test('C95-vertical-tab a vertical tab before the brace refuses the whole stylesheet', async ({
    request: _request,
  }, testInfo) => {
    const css = `${KEEP}\nbutton\v{font-weight:777}`;
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = renderStoredBrandingCss(css, TOKENS);

    await writeEvidence(testInfo, 'c95-vertical-tab', { css, status: save.status, stored, rendered });

    expect.soft(save.status, 'the save is refused with 400').toBe(400);
    expect.soft(stored, 'saved: nothing is stored').toBe('');
    expect.soft(rendered.trim(), 'rendered: nothing is rendered').toBe('');
  });

  for (const t of TRAILERS) {
    const title = t.dropped
      ? `C95-${t.id} ${t.label} between the selector and its brace drops the rule`
      : `C95-kept-${t.id} ${t.label} before the brace is kept`;

    /**
     * Catches: a character check that reads the selector postcss parsed but not what postcss stores
     * between it and the `{` (`rule.raws.between`), so a comment, form feed or no-break
     * space reaches the stored and rendered stylesheet; the render path for raw rows doing the same;
     * a drop that costs `.keep`; and, for the kept forms, a check so strict that ordinary whitespace
     * before `{` drops the rule.
     */
    test(title, async ({ request: _request }, testInfo) => {
      const css = `${KEEP}\n${t.css}`;
      const save = await saveOrganisationSettings(admin, { brandingCss: css });
      const stored = await storedCss();
      const rendered = renderStoredBrandingCss(css, TOKENS);

      await writeEvidence(testInfo, `c95-${t.id}`, {
        css,
        status: save.status,
        warnings: save.cssWarnings,
        stored,
        rendered,
      });

      expect.soft(save.status, 'the save answers 200').toBe(200);
      expect.soft(squash(stored), 'saved: .keep is kept').toContain(KEEP);
      expect.soft(squash(rendered), 'rendered: .keep is kept').toContain(KEEP);

      if (t.dropped) {
        expect.soft(selectorWarnings(save).length, 'a selector warning').toBeGreaterThanOrEqual(1);
        expect.soft(stored, 'saved: the rule is dropped').not.toContain('777');
        expect.soft(rendered, 'rendered: the rule is dropped').not.toContain('777');
      } else {
        expect.soft(selectorWarnings(save), 'no selector warning').toEqual([]);
        expect.soft(stored, 'saved: the rule is kept').toContain('font-weight:777');
        expect.soft(rendered, 'rendered: the rule is kept').toContain('font-weight:777');
      }
    });
  }
});

const settle = async (page: Page) => {
  await page.waitForTimeout(SETTLE_MS);

  return await markerWeight(page);
};
