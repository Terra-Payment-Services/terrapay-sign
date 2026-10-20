/**
 * Branding selector allowlist and the guard's scan budget (round 13).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 13:
 * selector allowlist and scan budget", without reading the implementation.
 *
 * | Criterion | Test                                                                   |
 * | --------- | ---------------------------------------------------------------------- |
 * | 80        | C80 pseudo-classes and pseudo-elements off the allowlist are dropped   |
 * | 81        | retired in round 14, replaced by C87 and C88 (round14 spec)            |
 * | 82        | C82 evasive spellings are dropped and do not apply                     |
 * | 83        | C83 the three Codex round 12 payloads are dropped                      |
 * | 84        | retired in round 14, replaced by C91 (round14 spec)                    |
 * | 85        | C70, C77 and C24 are existing specs, run alongside                     |
 *
 * The stored row is read through prisma, so a check costs no tRPC call. The render path is
 * `renderStoredBrandingCss`, called in process on the raw stylesheet, which is what a row stored
 * before the allowlist goes through. C82 also loads the signing page with the raw stylesheet
 * seeded into the organisation row.
 */
import { renderStoredBrandingCss } from '@documenso/lib/server-only/branding/branding-css-cache';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  baseUrl,
  openAdminSession,
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
  admin = await openAdminSession(browser, testInfo, 'round13');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };

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

const openSigning = async (page: Page, label: string) => {
  const token = await seedSigningToken(admin, label);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/sign/${token}`);
  await expect(page.getByRole('button', { name: 'Reject Document' }).first()).toBeVisible({ timeout: 30_000 });
};

const slug = (text: string) =>
  text
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

/** A save, then the stored row and the in-process render of the raw stylesheet, for dropped rules. */
const checkDropped = async (
  css: string,
  dropped: { id: string; label: string }[],
  kept: string[],
  evidenceName: string,
  testInfo: Parameters<typeof writeEvidence>[0],
) => {
  const save = await saveOrganisationSettings(admin, { brandingCss: css });
  const stored = await storedCss();
  const rendered = render(css);

  await writeEvidence(testInfo, evidenceName, {
    status: save.status,
    warnings: save.cssWarnings,
    stored,
    rendered,
  });

  expect.soft(save.status, 'the save answers 200').toBe(200);
  expect
    .soft(selectorWarnings(save).length, `one selector warning per dropped rule (${dropped.length})`)
    .toBeGreaterThanOrEqual(dropped.length);

  for (const item of dropped) {
    expect.soft(stored, `saved: ${item.label} is dropped`).not.toContain(`.${item.id}`);
    expect.soft(rendered, `rendered: ${item.label} is dropped`).not.toContain(`.${item.id}`);
  }

  for (const rule of kept) {
    expect.soft(stored, `saved: ${rule} is kept`).toContain(rule);
    expect.soft(rendered, `rendered: ${rule} is kept`).toContain(rule);
  }
};

const DROPPED_CLASSES = [
  'active',
  'target',
  'checked',
  'indeterminate',
  'valid',
  'invalid',
  'placeholder-shown',
  'has(a)',
  'visited',
  'link',
  'disabled',
  'enabled',
  'default',
  'read-only',
  'read-write',
  'any-link',
  'defined',
  'fullscreen',
  'bogus-state',
];

const DROPPED_ELEMENTS = [
  'first-line',
  'first-letter',
  'selection',
  'marker',
  'before',
  'after',
  'backdrop',
  'file-selector-button',
  'bogus-element',
];

test.describe('[BRANDING_CONTRAST]: selector allowlist and scan budget', () => {
  test('C80a pseudo-classes off the allowlist are dropped, the rest of the stylesheet is kept', async ({
    request: _request,
  }, testInfo) => {
    const dropped = DROPPED_CLASSES.map((name) => ({ id: `d-${slug(name)}`, label: `:${name}` }));
    const css = `.keep{font-weight:700}\n${DROPPED_CLASSES.map((name, i) => `.${dropped[i].id}:${name}{font-weight:700}`).join('\n')}`;

    await checkDropped(css, dropped, ['.keep{font-weight:700}'], 'c80a', testInfo);
  });

  test('C80b pseudo-elements off the allowlist are dropped, the rest of the stylesheet is kept', async ({
    request: _request,
  }, testInfo) => {
    const dropped = DROPPED_ELEMENTS.map((name) => ({ id: `d-${slug(name)}`, label: `::${name}` }));
    const css = `.keep{font-weight:700}\n.p-keep::placeholder{font-weight:700}\n${DROPPED_ELEMENTS.map((name, i) => `.${dropped[i].id}::${name}{font-weight:700}`).join('\n')}`;

    await checkDropped(
      css,
      dropped,
      ['.keep{font-weight:700}', '.p-keep::placeholder{font-weight:700}'],
      'c80b',
      testInfo,
    );
  });

  // C81 (kept pseudo-class forms) is retired by round 14: no pseudo-class is kept any more. It is
  // replaced by C87 (every pseudo-class dropped) and C88 (the kept forms) in
  // branding-contrast-round14.spec.ts.

  type Evasive = {
    id: string;
    label: string;
    form: string;
    element: string;
    state?: 'active';
    pseudo?: string;
  };

  const EVASIVE: Evasive[] = [
    {
      id: 'esc1',
      label: 'escaped :\\61 ctive',
      form: ':\\61 ctive',
      element: '<div class="e-esc1">x</div>',
      state: 'active',
    },
    {
      id: 'esc2',
      label: 'escaped :\\000061ctive',
      form: ':\\000061ctive',
      element: '<div class="e-esc2">x</div>',
      state: 'active',
    },
    {
      id: 'upper',
      label: 'uppercase :ACTIVE',
      form: ':ACTIVE',
      element: '<div class="e-upper">x</div>',
      state: 'active',
    },
    {
      id: 'isact',
      label: ':is(:active)',
      form: ':is(:active)',
      element: '<div class="e-isact">x</div>',
      state: 'active',
    },
    {
      id: 'wherechk',
      label: ':where(:checked)',
      form: ':where(:checked)',
      element: '<input type="checkbox" checked class="e-wherechk">',
    },
    { id: 'nothas', label: ':not(:has(a))', form: ':not(:has(a))', element: '<div class="e-nothas">x</div>' },
    { id: 'part', label: '::part(x)', form: '::part(x)', element: '<div class="e-part">x</div>' },
    { id: 'highlight', label: '::highlight(x)', form: '::highlight(x)', element: '<div class="e-highlight">x</div>' },
    {
      id: 'firstline',
      label: 'legacy :first-line',
      form: ':first-line',
      element: '<div class="e-firstline">x</div>',
      pseudo: '::first-line',
    },
    {
      id: 'before',
      label: 'legacy :before',
      form: ':before',
      element: '<div class="e-before">x</div>',
      pseudo: '::before',
    },
    {
      id: 'cmt1',
      label: 'comment :/**/active',
      form: ':/**/active',
      element: '<div class="e-cmt1">x</div>',
      state: 'active',
    },
    {
      id: 'ws1',
      label: 'whitespace :is( :active )',
      form: ':is( :active )',
      element: '<div class="e-ws1">x</div>',
      state: 'active',
    },
    {
      id: 'cmt2',
      label: 'comment :is(/**/:active)',
      form: ':is(/**/:active)',
      element: '<div class="e-cmt2">x</div>',
      state: 'active',
    },
  ];

  test('C82 evasive spellings are dropped and do not apply', async ({ page }, testInfo) => {
    await openSigning(page, 'c82');

    const supported = await page.evaluate(
      (forms) => Object.fromEntries(forms.map((f) => [f.id, CSS.supports(`selector(.e-${f.id}${f.form})`)])),
      EVASIVE.map(({ id, form }) => ({ id, form })),
    );

    // A spelling Chromium rejects is not a live selector, so it is not tested.
    const live = EVASIVE.filter((f) => supported[f.id]);

    expect
      .soft(live.length, 'premise: most spellings are valid selectors in Chromium')
      .toBeGreaterThan(EVASIVE.length / 2);

    const css = `.keep{font-weight:700}\n${live.map((f) => `.e-${f.id}${f.form}{font-weight:700;content:"x"}`).join('\n')}`;
    const save = await saveOrganisationSettings(admin, { brandingCss: css });
    const stored = await storedCss();
    const rendered = render(css);

    expect.soft(save.status, 'the save answers 200').toBe(200);
    expect
      .soft(selectorWarnings(save).length, 'one selector warning per live spelling')
      .toBeGreaterThanOrEqual(live.length);
    expect.soft(stored, 'saved: the allowed rule is kept').toContain('.keep{font-weight:700}');

    for (const f of live) {
      expect.soft(stored, `saved: ${f.label} is dropped`).not.toContain(`.e-${f.id}`);
      expect.soft(rendered, `rendered: ${f.label} is dropped`).not.toContain(`.e-${f.id}`);
    }

    // A stored row from before the allowlist: the raw rules go through the render path to Chromium.
    await seedRow(css);
    await openSigning(page, 'c82-raw');
    await page.evaluate(
      (elements) => {
        const host = document.createElement('div');

        host.id = 'e-host';
        host.innerHTML = elements.join('');
        document.body.appendChild(host);
      },
      live.map((f) => f.element),
    );

    const applied: Record<string, string> = {};

    for (const f of live) {
      const target = page.locator(`.e-${f.id}`);

      if (f.state === 'active') {
        await target.hover();
        await page.mouse.down();
      }

      applied[f.id] = await target.evaluate(
        (element, pseudo) => getComputedStyle(element, pseudo ?? null).fontWeight,
        f.pseudo,
      );

      if (f.state === 'active') {
        await page.mouse.up();
        await page.mouse.move(0, 0);
      }
    }

    await writeEvidence(testInfo, 'c82', { supported, status: save.status, warnings: save.cssWarnings, applied });

    for (const f of live) {
      expect.soft(applied[f.id], `raw row: ${f.label} does not apply in Chromium`).not.toBe('700');
    }
  });

  const ROUND12 = [
    {
      id: 'c83-has-active',
      css: '[role=dialog] textarea{background-color:#8f8f8f}\n[role=dialog] textarea::placeholder{background-color:#8f8f8f;color:#000}\n[role=dialog]:has(button:active) textarea{color:#8f8f8f}',
      kept: ['[role=dialog]textarea{background-color:#8f8f8f}'],
      gone: [':has(', ':active'],
    },
    {
      id: 'c83-first-line',
      css: '[role=dialog] h2{background-color:#8f8f8f}\n[role=dialog] h2::first-line{color:#8f8f8f}',
      kept: ['[role=dialog]h2{background-color:#8f8f8f}'],
      gone: ['::first-line'],
    },
    {
      id: 'c83-target-checked',
      css: '.t{background-color:#8f8f8f}\n.t:target{color:#8f8f8f}\ninput:checked + .t{color:#8f8f8f}',
      kept: ['.t{background-color:#8f8f8f}'],
      gone: [':target', ':checked'],
    },
  ];

  for (const c of ROUND12) {
    test(`${c.id} the Codex round 12 payload is dropped at save and at render`, async ({
      request: _request,
    }, testInfo) => {
      const save = await saveOrganisationSettings(admin, { brandingCss: c.css });
      const stored = await storedCss();
      const rendered = render(c.css);

      await writeEvidence(testInfo, c.id, { status: save.status, warnings: save.cssWarnings, stored, rendered });

      expect.soft(save.status, 'the save answers 200').toBe(200);
      expect.soft(selectorWarnings(save).length, 'a selector warning').toBeGreaterThanOrEqual(1);

      for (const text of c.gone) {
        expect.soft(stored, `saved: ${text} is gone`).not.toContain(text);
        expect.soft(rendered, `rendered: ${text} is gone`).not.toContain(text);
      }

      for (const rule of c.kept) {
        expect.soft(stored, `saved: ${rule} is kept`).toContain(rule);
        expect.soft(rendered, `rendered: ${rule} is kept`).toContain(rule);
      }
    });
  }

  // C84 (scan budget) is retired by round 14: the budget and its `unstable` reason are removed, and the
  // hover rule it bounded is now dropped. It is replaced by C91 in branding-contrast-round14.spec.ts.
});
