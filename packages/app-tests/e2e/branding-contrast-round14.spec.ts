/**
 * No interaction state in tenant selectors (round 14).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 14: no
 * interaction state in tenant selectors", without reading the sanitiser or the guard.
 *
 * | Criterion | Test                                                                       |
 * | --------- | -------------------------------------------------------------------------- |
 * | 86        | C86-<class> a selector character outside the set drops the rule            |
 * | 87        | C87 every pseudo-class, and a colon anywhere but ::placeholder, is dropped |
 * | 88        | C88 the kept forms apply; C88-universal `*` stays dropped (amended)        |
 * | 89        | C89a app hover background with tenant text colour; C89b focus-visible     |
 * | 90        | C90 ordinary keyboard, pointer and typing use keeps a benign stylesheet    |
 * | 91        | C91 round 13's hover font loop is refused and stays still                  |
 * | 92        | C92a an empty textarea is measured on its own colour; C92b the control     |
 * | 93        | round 13 C81 and C84 retired there; C70, C77, C24, C80, C82 run alongside  |
 *
 * The stored row is read through prisma, so a check costs no tRPC call. The render path is
 * `renderStoredBrandingCss`, called in process on the raw stylesheet, which is what a row stored
 * before the rule goes through. Where a test asserts that a form does not apply on the signing page,
 * it first proves the form would apply: on a page with no tenant stylesheet it injects the same rule,
 * nested under `.documenso-branded` as the tenant stylesheet is, in a test-owned `<style>` the guard
 * does not own, and reads the effect. A form Chromium rejects (`CSS.supports('selector(...)')` false)
 * is checked at save and render only.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  baseUrl,
  boundaryFailures,
  openAdminSession,
  readability,
  readComputed,
  readControlBoundaries,
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
  admin = await openAdminSession(browser, testInfo, 'round14');
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
const SCAN_WINDOW_MS = 2_500;
const SCRIPT_BUDGET_MS = 300;
const IDLE_BUDGET_MS = 150;

/** Whitespace-free copy, so a stored or rendered stylesheet is compared whatever its formatting. */
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

const selectorWarnings = (save: SaveResult) => save.cssWarnings.filter((w) => w.kind === 'selector');

const rejectButton = (page: Page) => page.getByRole('button', { name: 'Reject Document' }).first();

const openSigning = async (page: Page, token: string) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(rejectButton(page)).toBeVisible({ timeout: 30_000 });

  return response?.status();
};

/**
 * A hidden element carrying the marker class, added once and only read afterwards, so polling is not
 * itself a DOM mutation the guard could react to.
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

const guardAttributes = async (page: Page) =>
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-branding-guard]')).map(
      (element) => `${element.tagName.toLowerCase()}=${element.getAttribute('data-branding-guard')}`,
    ),
  );

/**
 * A test-owned style the guard does not own, nested the way the tenant stylesheet is: in the raised
 * wrapper `.documenso-branded.documenso-branded.documenso-branded { ... }` (spec, "Amendment after the
 * round 14 green run (C70)"), so a premise sees the specificity the real render gives. The page's CSP
 * allows inline styles by nonce only, so the style borrows the nonce of an element the page rendered.
 */
const injectUnguarded = async (page: Page, css: string) =>
  await page.evaluate((text) => {
    const style = document.createElement('style');
    const nonced = Array.from(document.querySelectorAll<HTMLElement>('script,style')).find((element) => element.nonce);

    style.nonce = nonced?.nonce ?? '';
    style.id = 'g3-unguarded';
    style.textContent = `.documenso-branded.documenso-branded.documenso-branded{${text}}`;
    document.head.appendChild(style);

    return document.body.classList.contains('documenso-branded');
  }, css);

const removeUnguarded = async (page: Page) =>
  await page.evaluate(() => {
    document.getElementById('g3-unguarded')?.remove();
  });

const appendHost = async (page: Page, html: string[]) =>
  await page.evaluate((parts) => {
    document.getElementById('g3-host')?.remove();

    const host = document.createElement('div');

    host.id = 'g3-host';
    host.innerHTML = parts.join('');
    document.body.appendChild(host);
  }, html);

const expectSurvivesRender = (css: string, needles: string[]) => {
  const rendered = render(css);

  for (const needle of needles) {
    expect(rendered, `premise: the rendered stylesheet keeps ${needle}`).toContain(squash(needle));
  }
};

const cdpScript = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);

  await cdp.send('Performance.enable');

  return async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');

    return (metrics.find((m) => m.name === 'ScriptDuration')?.value ?? 0) * 1000;
  };
};

// ---------------------------------------------------------------------------------------
// C86: characters
// ---------------------------------------------------------------------------------------

type Form = {
  /** Unique class carried by the selector, used to find the rule in stored and rendered CSS. */
  id: string;
  label: string;
  selector: string;
  /** Test-owned markup the selector matches; omitted when only save and render are checked. */
  html?: string;
  /** The element the rule styles, read for font-weight; defaults to `.${id}`. */
  probe?: string;
  state?: 'active';
  /** Text that proves the rule is still present when the rule has no unique class of its own. */
  needle?: string;
};

const CHARACTER_GROUPS: { id: string; title: string; forms: Form[] }[] = [
  {
    id: 'backslash',
    title: 'a backslash (every escape)',
    forms: [
      {
        id: 'c86-bs1',
        label: '.a\\62 c',
        selector: '.c86-bs1.a\\62 c',
        html: '<div class="c86-bs1 abc">x</div>',
      },
      {
        id: 'c86-bs2',
        label: ':\\61 ctive',
        selector: '.c86-bs2:\\61 ctive',
        html: '<div class="c86-bs2">x</div>',
        state: 'active',
      },
    ],
  },
  {
    id: 'codex',
    title: "Codex round 13's escaped functional names",
    forms: [
      {
        id: 'c86-cxlit',
        label: 'the literal payload input:i\\000073 (:checked)+textarea{color:#8f8f8f}',
        selector: 'input:i\\000073 (:checked)+textarea',
        needle: 'i\\000073',
      },
      {
        id: 'c86-cxis',
        label: ':i\\000073 (:checked), read by Chromium as :is(:checked)',
        selector: 'input.c86-cxis:i\\000073 (:checked)+textarea',
        html: '<input type="checkbox" class="c86-cxis" checked><textarea class="c86-cxis-t"></textarea>',
        probe: '.c86-cxis-t',
      },
      {
        id: 'c86-cxwh',
        label: ':wher\\000065 (:checked), read as :where(:checked)',
        selector: 'input.c86-cxwh:wher\\000065 (:checked)+textarea',
        html: '<input type="checkbox" class="c86-cxwh" checked><textarea class="c86-cxwh-t"></textarea>',
        probe: '.c86-cxwh-t',
      },
      {
        id: 'c86-cxnot',
        label: ':n\\00006f t(.zz), read as :not(.zz)',
        selector: 'input.c86-cxnot:n\\00006f t(.zz)+textarea',
        html: '<input type="checkbox" class="c86-cxnot"><textarea class="c86-cxnot-t"></textarea>',
        probe: '.c86-cxnot-t',
      },
      {
        id: 'c86-cxnth',
        label: ':nth-chil\\000064 (1), read as :nth-child(1)',
        selector: '.c86-cxnth > input:nth-chil\\000064 (1)+textarea',
        html: '<div class="c86-cxnth"><input type="checkbox"><textarea class="c86-cxnth-t"></textarea></div>',
        probe: '.c86-cxnth-t',
      },
    ],
  },
  {
    id: 'parens',
    title: 'parentheses (every functional form)',
    forms: [
      {
        id: 'c86-p1',
        label: ':is(.a)',
        selector: '.c86-p1:is(.a)',
        html: '<div class="c86-p1 a">x</div>',
      },
      {
        id: 'c86-p2',
        label: '.a:not(.b)',
        selector: '.c86-p2.a:not(.b)',
        html: '<div class="c86-p2 a">x</div>',
      },
    ],
  },
  {
    id: 'comment',
    title: 'a comment',
    forms: [
      {
        id: 'c86-cm',
        label: '.a/**/.b',
        selector: '.c86-cm.a/**/.b',
        html: '<div class="c86-cm a b">x</div>',
      },
    ],
  },
  {
    id: 'namespace',
    title: 'a namespace bar',
    forms: [
      {
        id: 'c86-ns1',
        label: '*|button',
        selector: '*|button.c86-ns1',
        html: '<button type="button" class="c86-ns1">x</button>',
      },
      {
        id: 'c86-ns2',
        label: '[lang|=en]',
        selector: '.c86-ns2[lang|=en]',
        html: '<div class="c86-ns2" lang="en-GB">x</div>',
      },
    ],
  },
  {
    id: 'punctuation',
    title: '@, %, &, !, ` and ?',
    forms: [
      { id: 'c86-at', label: '@', selector: '.c86-at@x' },
      { id: 'c86-pc', label: '%', selector: '.c86-pc%x' },
      { id: 'c86-amp', label: '&', selector: '& .c86-amp', html: '<div class="c86-amp">x</div>' },
      { id: 'c86-ex', label: '!', selector: '.c86-ex!x' },
      { id: 'c86-bt', label: '`', selector: '.c86-bt`x' },
      { id: 'c86-q', label: '?', selector: '.c86-q?x' },
    ],
  },
  {
    id: 'non-ascii',
    title: 'non-ASCII characters',
    forms: [
      { id: 'c86-na1', label: '.é', selector: '.c86-na1.é', html: '<div class="c86-na1 é">x</div>' },
      {
        id: 'c86-na2',
        label: '.a：hover (raw fullwidth colon U+FF1A)',
        selector: '.c86-na2.a：hover',
        html: '<div class="c86-na2 a：hover">x</div>',
      },
      {
        id: 'c86-na3',
        label: '.a followed by U+200B',
        selector: '.c86-na3.a​',
        html: '<div class="c86-na3 a​">x</div>',
      },
      {
        id: 'c86-na4',
        label: '.a, U+00A0, .b',
        selector: '.c86-na4.a .b',
        html: '<div class="c86-na4 a  b">x</div>',
      },
    ],
  },
];

const ruleOf = (form: Form) => `${form.selector}{font-weight:700}`;
const needleOf = (form: Form) => form.needle ?? `.${form.id}`;
const probeOf = (form: Form) => form.probe ?? `.${form.id}`;

/** Font weights of each form's probe, with the pointer held down on it for `:active` forms. */
const readWeights = async (page: Page, forms: Form[]) => {
  const out: Record<string, string> = {};

  for (const form of forms) {
    const target = page.locator(probeOf(form)).first();

    if (form.state === 'active') {
      await page.locator(`.${form.id}`).first().hover();
      await page.mouse.down();
    }

    out[form.id] = await target.evaluate((element) => getComputedStyle(element).fontWeight);

    if (form.state === 'active') {
      await page.mouse.up();
      await page.mouse.move(0, 0);
    }
  }

  return out;
};

const keepWeight = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.querySelector('#g3-host .keep');

    return element ? getComputedStyle(element).fontWeight : 'missing';
  });

test.describe('[BRANDING_CONTRAST]: no interaction state in tenant selectors', () => {
  for (const group of CHARACTER_GROUPS) {
    /**
     * Catches: a character outside the set reaching the stored or rendered stylesheet (an escape the
     * selector parser decodes differently from Chromium, an escaped functional name it reads as a
     * combinator, a comment, a namespace, non-ASCII look-alikes); the drop costing `.keep` or the whole
     * stylesheet; a drop with no `selector` warning; the render path for rows stored before the rule
     * passing the raw form to Chromium, where it applies.
     */
    test(`C86-${group.id} ${group.title} drops the rule, .keep stays`, async ({ page }, testInfo) => {
      const css = [KEEP, ...group.forms.map(ruleOf)].join('\n');
      const save = await saveOrganisationSettings(admin, { brandingCss: css });
      const stored = await storedCss();
      const rendered = render(css);
      const token = await seedSigningToken(admin, `c86-${group.id}`);
      const markup = ['<div class="keep">k</div>', ...group.forms.flatMap((f) => (f.html ? [f.html] : []))];

      // Premise: on a page with no tenant stylesheet, which forms Chromium parses, and that each would apply.
      await resetBranding(admin);
      await openSigning(page, token);
      await appendHost(page, markup);

      const supported = await page.evaluate(
        (list) => Object.fromEntries(list.map((f) => [f.id, CSS.supports(`selector(${f.selector})`)])),
        group.forms.map(({ id, selector }) => ({ id, selector })),
      );
      const live = group.forms.filter((f) => f.html && supported[f.id]);
      const wrapped = await injectUnguarded(page, [KEEP, ...live.map(ruleOf)].join('\n'));
      const injectedKeep = await keepWeight(page);
      const wouldApply = await readWeights(page, live);

      await removeUnguarded(page);

      // A stored row from before the rule: the raw stylesheet goes through the render path to Chromium.
      await seedRow(css);
      await openSigning(page, token);
      await appendHost(page, markup);

      const keep = await keepWeight(page);
      const applied = await readWeights(page, live);

      await writeEvidence(testInfo, `c86-${group.id}`, {
        css,
        status: save.status,
        warnings: save.cssWarnings,
        stored,
        rendered,
        supported,
        injectedKeep,
        wouldApply,
        applied,
        keep,
      });

      expect.soft(save.status, 'the save answers 200').toBe(200);
      expect
        .soft(selectorWarnings(save).length, `one selector warning per dropped rule (${group.forms.length})`)
        .toBeGreaterThanOrEqual(group.forms.length);
      expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
      expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);

      for (const form of group.forms) {
        expect.soft(stored, `saved: ${form.label} is dropped`).not.toContain(squash(needleOf(form)));
        expect.soft(rendered, `rendered: ${form.label} is dropped`).not.toContain(squash(needleOf(form)));
      }

      expect.soft(wrapped, 'premise: the signing page body carries documenso-branded').toBe(true);
      expect.soft(injectedKeep, 'premise: the test-owned style applies (.keep is bold through it)').toBe('700');

      for (const form of live) {
        expect.soft(wouldApply[form.id], `premise: ${form.label} applies in Chromium without the rule`).toBe('700');
        expect.soft(applied[form.id], `raw row: ${form.label} does not apply on the signing page`).not.toBe('700');
      }

      expect.soft(keep, 'raw row: .keep applies on the signing page').toBe('700');
    });
  }

  /**
   * Amended after the round 14 red run: a `;` in a selector is a parse error for the whole stylesheet
   * in postcss, today's fail-closed outcome for any parse error, and it is kept. So the semicolon case
   * asserts that nothing from the stylesheet is stored, rendered or applied, rather than `.keep` surviving.
   *
   * Catches: a parse error that keeps part of the stylesheet (the rule with the `;`, or a rule beside
   * it); the render path for a raw stored row passing any of it to Chromium; a save that answers 500.
   */
  test('C86-semicolon a semicolon is a parse error for the whole stylesheet', async ({ page }, testInfo) => {
    const css = `${KEEP}\n.c86-sc;x{font-weight:700}`;
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);
    const token = await seedSigningToken(admin, 'c86-semicolon');

    await seedRow(css);
    await openSigning(page, token);
    await appendHost(page, ['<div class="keep">k</div>', '<div class="c86-sc">x</div>']);

    const keep = await keepWeight(page);

    await writeEvidence(testInfo, 'c86-semicolon', {
      css,
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
      keep,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect
      .soft(
        save.cssWarnings.some((w) => w.kind === 'parse-error'),
        'a parse-error warning',
      )
      .toBe(true);
    expect.soft(stored, 'saved: nothing from the stylesheet is stored').toBe('');
    expect.soft(rendered, 'rendered: nothing from the stylesheet is rendered').toBe('');
    expect.soft(keep, 'raw row: .keep does not apply on the signing page').not.toBe('700');
  });

  // -------------------------------------------------------------------------------------
  // C87: no pseudo-classes
  // -------------------------------------------------------------------------------------

  const NO_PSEUDO: Form[] = [
    { id: 'c87-hover', label: ':hover', selector: '.c87-hover:hover' },
    { id: 'c87-focus', label: ':focus', selector: '.c87-focus:focus' },
    { id: 'c87-fv', label: ':focus-visible', selector: '.c87-fv:focus-visible' },
    { id: 'c87-fw', label: ':focus-within', selector: '.c87-fw:focus-within' },
    { id: 'c87-fc', label: ':first-child', selector: '.c87-fc:first-child' },
    { id: 'c87-lc', label: ':last-child', selector: '.c87-lc:last-child' },
    { id: 'c87-oc', label: ':only-child', selector: '.c87-oc:only-child' },
    { id: 'c87-fot', label: ':first-of-type', selector: '.c87-fot:first-of-type' },
    { id: 'c87-lot', label: ':last-of-type', selector: '.c87-lot:last-of-type' },
    { id: 'c87-oot', label: ':only-of-type', selector: '.c87-oot:only-of-type' },
    { id: 'c87-empty', label: ':empty', selector: '.c87-empty:empty' },
    { id: 'c87-root', label: ':root', selector: ':root .c87-root' },
    { id: 'c87-nth', label: ':nth-child(2)', selector: '.c87-nth:nth-child(2)' },
    { id: 'c87-not', label: ':not(.a)', selector: '.c87-not:not(.a)' },
    { id: 'c87-is', label: ':is(.a)', selector: '.c87-is:is(.a)' },
    { id: 'c87-where', label: ':where(.a)', selector: '.c87-where:where(.a)' },
    { id: 'c87-upper', label: 'uppercase :HOVER', selector: '.c87-upper:HOVER' },
    { id: 'c87-ph', label: 'single-colon :placeholder', selector: 'input.c87-ph:placeholder' },
    { id: 'c87-href', label: 'a colon in a quoted value [href^="https:"]', selector: 'a.c87-href[href^="https:"]' },
  ];

  /**
   * Catches: any pseudo-class round 13 kept still being kept (hover, focus, the structural ones, :not,
   * :is, :where, :root); a case-sensitive match that lets :HOVER through; a colon rule that keys on
   * pseudo-class names rather than on the colon, so :placeholder (one colon) or a colon inside a quoted
   * attribute value survives; the render path keeping what the save drops; a drop with no warning or
   * one that costs `.keep`.
   */
  test('C87 every pseudo-class, and any colon but ::placeholder, drops the rule', async ({
    request: _request,
  }, testInfo) => {
    const css = [KEEP, ...NO_PSEUDO.map(ruleOf)].join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    await writeEvidence(testInfo, 'c87', { css, status: save.status, warnings: save.cssWarnings, stored, rendered });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect
      .soft(selectorWarnings(save).length, `one selector warning per dropped rule (${NO_PSEUDO.length})`)
      .toBeGreaterThanOrEqual(NO_PSEUDO.length);
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(rendered, 'rendered: .keep is kept').toContain(KEEP);

    for (const form of NO_PSEUDO) {
      expect.soft(stored, `saved: ${form.label} is dropped`).not.toContain(`.${form.id}`);
      expect.soft(rendered, `rendered: ${form.label} is dropped`).not.toContain(`.${form.id}`);
    }
  });

  // -------------------------------------------------------------------------------------
  // C88: kept forms
  // -------------------------------------------------------------------------------------

  const KEPT: { label: string; selector: string; probe: string; placeholder?: boolean }[] = [
    { label: 'type', selector: 'dfn', probe: '#g3-host dfn' },
    { label: 'class', selector: '.k88-class', probe: '.k88-class' },
    { label: 'id', selector: '#k88-id', probe: '#k88-id' },
    { label: 'attribute, no operator', selector: '[data-k88-a]', probe: '[data-k88-a]' },
    { label: 'attribute =', selector: '[data-k88-b=x]', probe: '[data-k88-b]' },
    { label: 'attribute ~=', selector: '[data-k88-c~="x"]', probe: '[data-k88-c]' },
    { label: 'attribute ^=', selector: '[data-k88-d^="ab"]', probe: '[data-k88-d]' },
    { label: 'attribute $= single-quoted', selector: "[data-k88-e$='yz']", probe: '[data-k88-e]' },
    { label: 'attribute *=', selector: '[data-k88-f*="mid"]', probe: '[data-k88-f]' },
    { label: 'attribute = single-quoted', selector: "[data-k88-g='q']", probe: '[data-k88-g]' },
    { label: 'descendant', selector: '.k88-p .k88-desc', probe: '.k88-desc' },
    { label: 'child >', selector: '.k88-p > .k88-child', probe: '.k88-child' },
    { label: 'adjacent +', selector: '.k88-s1 + .k88-adj', probe: '.k88-adj' },
    { label: 'sibling ~', selector: '.k88-s1 ~ .k88-sib', probe: '.k88-sib' },
    { label: 'selector list', selector: '.k88-l1, .k88-l2', probe: '.k88-l2' },
    { label: '::placeholder', selector: 'input.k88-ph::placeholder', probe: '.k88-ph', placeholder: true },
    { label: '::PLACEHOLDER', selector: 'input.k88-PH::PLACEHOLDER', probe: '.k88-PH', placeholder: true },
  ];

  const KEPT_MARKUP = [
    '<dfn>t</dfn>',
    '<div class="k88-class">c</div>',
    '<div id="k88-id">i</div>',
    '<div data-k88-a>a</div>',
    '<div data-k88-b="x">b</div>',
    '<div data-k88-c="w x y">c</div>',
    '<div data-k88-d="abc">d</div>',
    '<div data-k88-e="xyz">e</div>',
    '<div data-k88-f="a-mid-b">f</div>',
    '<div data-k88-g="q">g</div>',
    '<div class="k88-p"><section><span class="k88-desc">d</span></section><span class="k88-child">c</span></div>',
    '<div><span class="k88-s1">1</span><span class="k88-adj">2</span><b>3</b><span class="k88-sib">4</span></div>',
    '<div class="k88-l2">l</div>',
    '<input class="k88-ph" placeholder="p">',
    '<input class="k88-PH" placeholder="p">',
  ];

  /**
   * Catches: a character or colon check so broad that it drops ordinary selectors (attribute operators,
   * quotes, combinators, lists, `::placeholder` in either case); a rule that is stored but rewritten so
   * it no longer matches; a kept rule that does not reach Chromium. Expected to pass on round 13 code:
   * it is the control for C86 and C87.
   */
  test('C88 type, class, id, attribute, combinator, list and ::placeholder forms are kept and apply', async ({
    page,
  }, testInfo) => {
    const css = KEPT.map((k) => `${k.selector}{font-weight:700}`).join('\n');
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);
    const token = await seedSigningToken(admin, 'c88');

    await openSigning(page, token);
    await appendHost(page, KEPT_MARKUP);

    const applied: Record<string, string> = {};

    for (const k of KEPT) {
      applied[k.label] = await page
        .locator(k.probe)
        .first()
        .evaluate(
          (element, isPlaceholder) => getComputedStyle(element, isPlaceholder ? '::placeholder' : null).fontWeight,
          Boolean(k.placeholder),
        );
    }

    await writeEvidence(testInfo, 'c88', { css, status: save.status, warnings: save.cssWarnings, stored, applied });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(selectorWarnings(save), 'no selector warning').toEqual([]);

    for (const k of KEPT) {
      const rule = squash(`${k.selector}{font-weight:700}`);

      expect.soft(stored, `saved: ${k.label} is kept`).toContain(rule);
      expect.soft(rendered, `rendered: ${k.label} is kept`).toContain(rule);
      expect.soft(applied[k.label], `${k.label} applies in Chromium`).toBe('700');
    }
  });

  /**
   * Amended after the round 14 red run: the universal selector is not a kept form. The sanitiser refuses `*` as a
   * selector ("universal "*" selector not allowed") and rule 3 keeps that check; `*` stays in the
   * character set only for the `*=` operator.
   *
   * Catches: the round 14 character set or the parse step admitting `*` as a selector; the render path
   * keeping what the save drops; the dropped rule applying in Chromium from a raw stored row.
   */
  test('C88-universal a universal selector is dropped, as the sanitiser does', async ({ page }, testInfo) => {
    const css = `${KEEP}\n.k88-u > *{font-weight:700}`;
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);
    const token = await seedSigningToken(admin, 'c88-universal');

    await seedRow(css);
    await openSigning(page, token);
    await appendHost(page, [
      '<div class="keep">k</div>',
      '<div class="k88-u"><span class="k88-u-child">u</span></div>',
    ]);

    const applied = await page.locator('.k88-u-child').evaluate((element) => getComputedStyle(element).fontWeight);
    const keep = await keepWeight(page);

    await writeEvidence(testInfo, 'c88-universal', {
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
      applied,
      keep,
    });

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(selectorWarnings(save).length, 'a selector warning').toBeGreaterThanOrEqual(1);
    expect.soft(stored, 'saved: the universal rule is dropped').not.toContain('.k88-u');
    expect.soft(rendered, 'rendered: the universal rule is dropped').not.toContain('.k88-u');
    expect.soft(stored, 'saved: .keep is kept').toContain(KEEP);
    expect.soft(applied, 'raw row: the universal rule does not apply').not.toBe('700');
    expect.soft(keep, 'raw row: .keep applies').toBe('700');
  });

  // -------------------------------------------------------------------------------------
  // C89: app state with tenant colours
  // -------------------------------------------------------------------------------------

  /**
   * The control is the Reject Document trigger, `<Button variant="outline">` at
   * apps/remix/app/components/general/document-signing/document-signing-reject-dialog.tsx:112. The
   * outline variant is `border border-input hover:bg-accent hover:text-accent-foreground`
   * (packages/ui/primitives/button.tsx:18; ghost at :20 is the same hover pair without the border).
   * The test finds it by those classes in the DOM.
   *
   * Restated after the wrapper amendment: the tenant sets only the text colour on the control
   * (`button{color:#fff}`), and the dark background comes from an ancestor rule (`div{background-color:#000}`).
   * The control's own background stays the app's: transparent at rest, so it shows the ancestor's black,
   * and `hover:bg-accent` (light blue) on hover. With the raised wrapper the tenant's white text (0,3,1)
   * outranks `hover:text-accent-foreground` (0,2,0), so the hovered control is white on light blue.
   * A lone colour is checked against the base page colours, so the row also sets the `background` and
   * `foreground` tokens to black and white; with the defaults the save and render checks drop both rules.
   *
   * Catches: a guard that stops re-measuring on pointerover once the scan budget goes; a guard that
   * measures only the tenant's colours and not the cascade the signer sees under app state styles.
   */
  test('C89a hovering an outline control pairs the app hover background with the tenant text colour', async ({
    page,
  }, testInfo) => {
    const rules = ['div{background-color:#000}', 'button{color:#fff}'];
    const css = [MARKER, ...rules].join('\n');
    // Round 22: dark card, widget, muted, popover and secondary, so every component pair reads
    // (the test's own primary already reads on black), and a mid-grey `foreground` #767676, which reads on the black background (4.6:1) and on the fixed gray-50 signing surface (4.2:1). A white foreground cannot read on gray-50 since
    // 754b9eda4; #767676 still lets `div{background-color:#000}` pass against it at save.
    const tokens = {
      ...TOKENS,
      background: '#000000',
      foreground: '#767676',
      card: '#000000',
      cardForeground: '#ffffff',
      widget: '#000000',
      muted: '#000000',
      popover: '#000000',
      popoverForeground: '#ffffff',
      secondary: '#000000',
      secondaryForeground: '#ffffff',
    };
    const control = (p: Page) =>
      p
        .locator('button[class~="border-input"][class~="hover:bg-accent"][class~="hover:text-accent-foreground"]')
        .filter({ hasText: 'Reject Document' })
        .first();
    const token = await seedSigningToken(admin, 'c89a');
    const evidence: Record<string, unknown> = {};

    // Premise on a page with no tenant stylesheet: the control exists, and the same rules, unguarded in
    // the raised wrapper, read at least 3:1 at rest and under 3:1 hovered.
    await openSigning(page, token);
    await expect(control(page), 'premise: an outline-variant control is on the signing page').toBeVisible();

    // The field's transparent click overlay is a control by the round 20 rule; wait for it to mount.
    await page.locator('[data-field-type=SIGNATURE] button').first().waitFor();

    // Round 20 (C113): control boundaries are measured too, against this default-theme baseline.
    const boundaryBaseline = await readControlBoundaries(page);
    await control(page).evaluate((element) => element.setAttribute('data-g3-probe', 'c89'));
    evidence.classes = await control(page).getAttribute('class');

    const wrapped = await injectUnguarded(page, rules.join('\n'));
    const premiseRest = readability(await readComputed(page, '[data-g3-probe="c89"]'));
    const premiseColour = await control(page).evaluate((element) => getComputedStyle(element).color);

    await control(page).hover();
    await page.waitForTimeout(300);

    const premiseHover = readability(await readComputed(page, '[data-g3-probe="c89"]'));

    await page.mouse.move(0, 0);
    await removeUnguarded(page);
    evidence.premise = { wrapped, colour: premiseColour, rest: premiseRest, hover: premiseHover };

    expect(wrapped, 'premise: the signing page body carries documenso-branded').toBe(true);
    expect(premiseColour, 'premise: the test-owned style applies (white text)').toBe('rgb(255, 255, 255)');
    expect(premiseRest.ratio, 'premise: the control reads at least 3:1 at rest').toBeGreaterThanOrEqual(
      BRANDING_CONTRAST_THRESHOLD,
    );
    expect(premiseHover.ratio, 'premise: the hovered control reads under 3:1').toBeLessThan(
      BRANDING_CONTRAST_THRESHOLD,
    );

    // The stylesheet and tokens survive the save and render checks.
    const save = await saveOrganisationSettings(admin, { brandingCss: css, brandingColors: tokens });
    const stored = await storedCss();
    const rendered = squash(renderStoredBrandingCss(css, tokens));

    evidence.save = { status: save.status, warnings: save.cssWarnings, stored, rendered };
    expect(save.status, 'premise: the save answers 200').toBe(200);
    expect(save.cssWarnings, 'premise: the save drops nothing').toEqual([]);

    for (const rule of rules) {
      expect(stored, `premise: the stored stylesheet keeps ${rule}`).toContain(rule);
      expect(rendered, `premise: the rendered stylesheet keeps ${rule}`).toContain(rule);
    }

    const status = await openSigning(page, token);

    await installMarker(page);
    await page.waitForTimeout(SETTLE_MS);
    await control(page).evaluate((element) => element.setAttribute('data-g3-probe', 'c89'));

    const restWeight = await markerWeight(page);
    const rest = readability(await readComputed(page, '[data-g3-probe="c89"]'));

    // The field's transparent click overlay is a control by the round 20 rule; wait for it to mount.
    await page.locator('[data-field-type=SIGNATURE] button').first().waitFor();

    const boundaries = boundaryFailures(await readControlBoundaries(page), boundaryBaseline);

    evidence.rest = { markerWeight: restWeight, readability: rest, boundaryBaseline, boundaries };
    expect.soft(status, 'the page answers 200').toBe(200);
    expect.soft(restWeight, 'premise: the stylesheet is applied at rest').toBe('700');
    expect
      .soft(boundaries.failing, 'at rest every control boundary reads at least 3:1, or no worse than default')
      .toEqual([]);
    expect.soft(boundaries.margin, 'the zero-paint overlay is excluded, not passed by the margin').toEqual([]);
    expect.soft(boundaries.excluded.length, 'the field overlay is excluded as zero-paint').toBeGreaterThan(0);

    await control(page).hover();

    const weight = await waitForDisabled(page);
    const hovered = readability(await readComputed(page, '[data-g3-probe="c89"]'));

    evidence.hovered = { markerWeight: weight, readability: hovered };
    await writeEvidence(testInfo, 'c89a', evidence);

    expect.soft(weight, 'hovering the control disables the stylesheet').not.toBe('700');
    expect
      .soft(hovered.ratio, 'the hovered control reads at least 3:1 after the guard')
      .toBeGreaterThanOrEqual(BRANDING_CONTRAST_THRESHOLD);
  });

  test('C89b keyboard focus with an app focus-visible colour class', async () => {
    test.skip(
      true,
      'No signing-page control carries an app focus-visible colour class. `git grep -nE "focus-visible:(bg|text)-"` ' +
        'over the whole worktree at 79ac42d04 returns no hits; packages/ui/primitives/button.tsx:10 sets only ' +
        'focus-visible:outline-none, focus-visible:ring-2, focus-visible:ring-ring and focus-visible:ring-offset-2.',
    );
  });

  // -------------------------------------------------------------------------------------
  // C90: ordinary use keeps benign branding
  // -------------------------------------------------------------------------------------

  /**
   * Catches: a guard that disables a harmless stylesheet because the signer used the keyboard or the
   * pointer quickly (Codex round 13: thirteen Tab presses tripped the scan budget); a guard that
   * disables on typing; any `data-branding-guard` reason left on the page after ordinary use.
   */
  test('C90 tabbing, sweeping the pointer and typing keep a benign stylesheet applied', async ({ page }, testInfo) => {
    const css = `${MARKER}\nbutton{border-color:blue}\n[role=dialog]{border-color:blue}`;

    expectSurvivesRender(css, ['button{border-color:blue}', '[role=dialog]{border-color:blue}']);
    await seedRow(css);

    const token = await seedSigningToken(admin, 'c90');
    const status = await openSigning(page, token);

    await installMarker(page);
    await page.waitForTimeout(1_000);

    const before = await markerWeight(page);

    expect(before, 'premise: the stylesheet is applied on load').toBe('700');

    for (let i = 0; i < 13; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(40);
    }

    const afterTabs = await markerWeight(page);
    const boxes = (
      await page.locator('button:visible').evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();

          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }),
      )
    ).filter((b) => b.x > 0 && b.y > 0 && b.y < 900);

    expect(boxes.length, 'premise: the page has visible buttons to sweep').toBeGreaterThan(0);
    await page.mouse.move(1, 1);

    for (let sweep = 0; sweep < 30; sweep++) {
      for (const box of boxes) {
        await page.mouse.move(box.x, box.y, { steps: 4 });
      }

      await page.mouse.move(1, 1, { steps: 4 });
    }

    const afterSweeps = await markerWeight(page);

    await rejectButton(page).click();

    const reason = page.getByRole('dialog').locator('textarea');

    await expect(reason).toBeVisible();

    const text = 'The figures on page two do not match the agreed schedule. '.repeat(4).slice(0, 200);

    await reason.pressSequentially(text, { delay: 5 });
    await expect(reason).toHaveValue(text);
    await page.waitForTimeout(1_000);

    const end = await markerWeight(page);
    const attributes = await guardAttributes(page);

    await writeEvidence(testInfo, 'c90', {
      status,
      before,
      afterTabs,
      afterSweeps,
      end,
      sweptButtons: boxes.length,
      attributes,
    });

    expect.soft(afterTabs, 'still applied after thirteen Tab presses').toBe('700');
    expect.soft(afterSweeps, 'still applied after thirty pointer sweeps').toBe('700');
    expect.soft(end, 'still applied after typing 200 characters').toBe('700');
    expect.soft(attributes, 'no element carries data-branding-guard').toEqual([]);
  });

  // -------------------------------------------------------------------------------------
  // C91: round 13's loop, now refused
  // -------------------------------------------------------------------------------------

  /**
   * Catches: the hover rule surviving the save or the render path; the hover loop still running
   * (script time over the window), or the font flipping under the parked pointer, or the guard
   * disabling the stylesheet (which also changes the font). Replaces round 13's C84.
   */
  test('C91 a hover font rule is dropped, and the parked pointer changes nothing', async ({ page }, testInfo) => {
    const base = 'button{font-family:monospace}';
    const css = `${MARKER}\n${base}\nbutton:hover{font-family:Arial}`;
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect.soft(selectorWarnings(save).length, 'a selector warning').toBeGreaterThanOrEqual(1);
    expect.soft(stored, 'saved: the hover rule is dropped').not.toContain(':hover');
    expect.soft(stored, 'saved: the base rule is kept').toContain(base);
    expect.soft(rendered, 'rendered: the hover rule is dropped').not.toContain(':hover');
    expect.soft(rendered, 'rendered: the base rule is kept').toContain(base);

    await seedRow(css);

    const token = await seedSigningToken(admin, 'c91');

    await openSigning(page, token);
    await installMarker(page);

    const fontOf = async () => await rejectButton(page).evaluate((element) => getComputedStyle(element).fontFamily);
    const scriptMs = await cdpScript(page);

    await page.waitForTimeout(1_500);

    const idleStart = await scriptMs();

    await page.waitForTimeout(1_000);

    const idleMs = (await scriptMs()) - idleStart;
    const initialFont = await fontOf();
    const box = await rejectButton(page).boundingBox();

    expect(box, 'premise: the Reject Document button has a box').not.toBeNull();

    const started = await scriptMs();
    const parkedAt = Date.now();

    // The button is right-aligned, so a narrower font pulls its left edge away from the pointer.
    await page.mouse.move((box?.x ?? 0) + 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);

    const fonts = new Set<string>();

    while (Date.now() - parkedAt < SCAN_WINDOW_MS) {
      fonts.add(await fontOf());
      await page.waitForTimeout(50);
    }

    const scanMs = (await scriptMs()) - started;

    await writeEvidence(testInfo, 'c91', {
      status: save.status,
      warnings: save.cssWarnings,
      stored,
      rendered,
      idleScriptMs: idleMs,
      scanWindowScriptMs: scanMs,
      initialFont,
      fontsSeen: [...fonts],
      finalMarkerWeight: await markerWeight(page),
    });

    expect.soft(initialFont, 'premise: the base font rule applies before parking').toContain('monospace');
    expect
      .soft(idleMs, `premise: the page is idle (under ${IDLE_BUDGET_MS} ms of script in a second)`)
      .toBeLessThan(IDLE_BUDGET_MS);
    expect.soft([...fonts], 'the font does not change under the parked pointer').toEqual([initialFont]);
    expect
      .soft(scanMs, `script time over ${SCAN_WINDOW_MS} ms is under ${SCRIPT_BUDGET_MS} ms`)
      .toBeLessThan(SCRIPT_BUDGET_MS);
  });

  // -------------------------------------------------------------------------------------
  // C92: inputs read with a value and without one
  // -------------------------------------------------------------------------------------

  const openReject = async (page: Page) => {
    await rejectButton(page).click();
    await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
  };

  const PLACEHOLDER_RULE = '[role=dialog] textarea::placeholder{background-color:#8f8f8f;color:#000}';

  /**
   * The spec writes the textarea pair as one rule. Grey on grey in one rule is a same-rule pair the
   * save and render contrast checks drop (spec 2.4, 2.7), which would leave nothing for the guard to
   * see, so the two halves are split into lone declarations as round 11's C73 does; each survives the
   * render check on its own (premise below).
   *
   * Catches: a guard that measures a textarea's own colour only when it holds a value, so an empty
   * textarea whose placeholder is readable hides grey-on-grey text the signer is about to type.
   */
  test('C92a an empty textarea is measured on its own colour', async ({ page }, testInfo) => {
    const rules = ['[role=dialog] textarea{background-color:#8f8f8f}', '[role=dialog] textarea{color:#8f8f8f}'];
    const css = [MARKER, ...rules, PLACEHOLDER_RULE].join('\n');
    const token = await seedSigningToken(admin, 'c92a');

    expectSurvivesRender(css, [...rules, PLACEHOLDER_RULE]);

    // Premise with no tenant stylesheet: the same rules, unguarded, leave the placeholder readable and
    // the textarea's own colour unreadable.
    await openSigning(page, token);
    await openReject(page);
    await page
      .getByRole('dialog')
      .locator('textarea')
      .evaluate((element) => element.setAttribute('data-g3-probe', 'c92'));
    await injectUnguarded(page, [...rules, PLACEHOLDER_RULE].join('\n'));

    const own = readability(await readComputed(page, '[data-g3-probe="c92"]'));
    const placeholder = await page.locator('[data-g3-probe="c92"]').evaluate((element) => {
      const style = getComputedStyle(element, '::placeholder');

      return { color: style.color, backgroundColor: style.backgroundColor };
    });

    await removeUnguarded(page);

    expect(own.ratio, "premise: the textarea's own colour reads under 3:1").toBeLessThan(BRANDING_CONTRAST_THRESHOLD);
    expect(placeholder.color, 'premise: the placeholder rule applies (black)').toBe('rgb(0, 0, 0)');

    await seedRow(css);

    const status = await openSigning(page, token);

    await installMarker(page);
    await openReject(page);

    const value = await page.getByRole('dialog').locator('textarea').inputValue();
    const weight = await waitForDisabled(page);
    const attributes = await guardAttributes(page);

    await writeEvidence(testInfo, 'c92a', {
      status,
      premise: { own, placeholder },
      value,
      markerWeight: weight,
      attributes,
    });

    expect.soft(value, 'premise: the textarea is empty').toBe('');
    expect.soft(weight, 'the guard disables the stylesheet with the textarea empty').not.toBe('700');
    // Round 14 removes the scan budget, so a disable here must be for contrast, never `unstable`.
    expect.soft(attributes, 'the guard records no unstable reason').not.toContain('style=unstable');
  });

  /**
   * Catches: a guard that treats a script-set value as unmeasured and so either misses it or disables a
   * readable stylesheet. Control: expected to pass on round 13 code too.
   */
  test('C92b a readable textarea stays applied after a script sets its value', async ({ page }, testInfo) => {
    const rule = '[role=dialog] textarea{background-color:#8f8f8f;color:#000}';
    const css = [MARKER, rule, PLACEHOLDER_RULE].join('\n');

    expectSurvivesRender(css, [rule, PLACEHOLDER_RULE]);
    await seedRow(css);

    const token = await seedSigningToken(admin, 'c92b');
    const status = await openSigning(page, token);

    await installMarker(page);
    await openReject(page);
    await page.waitForTimeout(SETTLE_MS);

    const empty = await markerWeight(page);
    const textarea = page.getByRole('dialog').locator('textarea');

    await textarea.evaluate((element) => {
      (element as HTMLTextAreaElement).value = 'Not my document';
      element.setAttribute('data-g3-probe', 'c92b');
    });
    await page.waitForTimeout(SETTLE_MS);

    const set = await markerWeight(page);
    const own = readability(await readComputed(page, '[data-g3-probe="c92b"]'));

    await writeEvidence(testInfo, 'c92b', { status, empty, set, own, value: await textarea.inputValue() });

    expect.soft(empty, 'premise: the stylesheet is applied with the textarea empty').toBe('700');
    expect.soft(await textarea.inputValue(), 'premise: the script set the value').toBe('Not my document');
    expect.soft(set, 'the stylesheet is still applied after the value is set').toBe('700');
    expect.soft(own.ratio, 'the textarea reads at least 3:1').toBeGreaterThanOrEqual(BRANDING_CONTRAST_THRESHOLD);
  });
});
