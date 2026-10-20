/**
 * Tokens fall back too, and boundaries keep their baseline (round 22).
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Round 22: tokens fall
 * back too, and boundaries keep their baseline", without reading the sanitiser, the guard or its
 * measurement.
 *
 * | Criterion | Test                                                                                  |
 * | --------- | ------------------------------------------------------------------------------------- |
 * | 118       | C118-card-widget, C118-v1-widget (render); C118-save-card, C118-save-widget (save);   |
 * |           | C118c-stylesheet, C118c-tokens-only and their readable controls (the token step)      |
 * | 119       | C119-white a white border on the faint control; C119-black (control)                  |
 * | 120       | C120-defaults, C120-brand: the signing journey on the mobile widget; C120-dark-refused |
 * | 121       | rounds 10 to 21 rerun with the round 22 oracle (default-theme baseline, no margin)    |
 *
 * The mobile widget (`document-signing-mobile-widget.tsx`) is shown by the V2 signing page below the
 * `lg` breakpoint (`block lg:hidden` in `document-signing-page-view-v2.tsx`), so the V2 cases use a
 * 390x844 viewport. The V1 widget (`document-signing-page-view-v1.tsx:293`, `bg-widget`) shows its
 * Expand button only below `md` (`md:hidden`), so the V1 case uses the same viewport; that button paints
 * `bg-background`, not `bg-widget`.
 *
 * Save-time pairs, read from the components for C118's refusal half: the mobile widget paints `bg-card`
 * (`document-signing-mobile-widget.tsx:36`) under a `text-foreground` heading (line 56) and
 * `text-muted-foreground` Expand icon and subtitle (lines 48, 50, 66); the V1 widget paints `bg-widget`
 * (`document-signing-page-view-v1.tsx:293`) under a `text-foreground` heading (line 295). So the
 * refusals asserted are `foreground on card`, `mutedForeground on card` and `foreground on widget`, in
 * the wording the round 21 warnings use (`input on background`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_BRAND_COLORS } from '@documenso/lib/constants/theme';
import { BRANDING_CONTRAST_THRESHOLD, findBrandingTokenProblems } from '@documenso/lib/utils/branding-contrast';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDataType, FieldType } from '@prisma/client';

import {
  type AdminSession,
  baseUrl,
  boundaryFailures,
  type ControlBoundary,
  contrast,
  errorBodyHasCode,
  hex,
  hslTriplet,
  near,
  openAdminSession,
  parseComputed,
  type Rgba,
  readability,
  readBodyVars,
  readComputed,
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
  admin = await openAdminSession(browser, testInfo, 'round22');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const MARKER = '.g3-marker{font-weight:700}';
const SETTLE_MS = 3_000;
const MOBILE = { width: 390, height: 844 };
const UNCHECKED = '[role=checkbox][data-state=unchecked]';
const DESKTOP = { width: 1280, height: 900 };

const CARD_SET = { card: '#6e7586', cardForeground: '#ffffff' };
const WIDGET_SET = { widget: '#213871' };

/** A clause of a refusal naming `foreground on background`, whole words, as the round 21 warnings do. */
const namesPair = (text: string, foreground: string, background: string) =>
  new RegExp(`(^|[^A-Za-z])${foreground} on ${background}([^A-Za-z]|$)`).test(text);

const logoJson = async () => {
  const logo = await fs.readFile(path.join(__dirname, '../../assets/logo.png'));

  return JSON.stringify({ type: DocumentDataType.BYTES_64, data: logo.toString('base64') });
};

/** The stored row, written directly so the save-time checks cannot refuse it first. Logo kept. */
const seedRow = async (css: string, colors: Record<string, string> | null) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: css, brandingColors: colors, brandingLogo: await logoJson() },
  });
};

const uniqueEmail = (label: string) =>
  `g3-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.documenso.com`;

/** A pending document with one signature field for one recipient, V1 or V2. */
const seedToken = async (label: string, internalVersion: 1 | 2, fields: FieldType[] = [FieldType.SIGNATURE]) => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
  const { recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: admin.teamId,
    recipients: [uniqueEmail(label)],
    fields,
    updateDocumentOptions: { internalVersion },
  });
  const recipient = recipients[0];
  const seeded = await prisma.field.findMany({ where: { recipientId: recipient.id } });

  return { token: recipient.token, fields: seeded };
};

/** Opens the signing page at the mobile viewport and waits for the widget heading. */
const openWidget = async (page: Page, token: string) => {
  await page.setViewportSize(MOBILE);

  const response = await page.goto(`${baseUrl}/sign/${token}`);

  await expect(page.getByRole('heading', { name: 'Sign Document' }).first()).toBeVisible({ timeout: 30_000 });

  return response?.status();
};

const openDesktop = async (page: Page, token: string) => {
  await page.setViewportSize(DESKTOP);

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

/**
 * The colour-token style elements: `.documenso-branded { --… }` with the class once, as
 * `recipient-branding.tsx` renders them (the stylesheet repeats the class three times).
 */
const tokenStyles = async (page: Page) =>
  (await page.evaluate(`Array.from(document.querySelectorAll('style'))
    .filter((s) => /^\\s*\\.documenso-branded\\s*\\{\\s*--/.test(s.textContent || ''))
    .map((s) => ({
      guard: s.getAttribute('data-branding-guard'),
      media: s.media,
      disabled: s.sheet ? s.sheet.disabled : null,
      text: (s.textContent || '').slice(0, 400),
    }))`)) as { guard: string | null; media: string; disabled: boolean | null; text: string }[];

/**
 * Tags the visible widget heading, the Expand icon beside it and the widget surface (the heading's nearest
 * `bg-card` or `bg-widget` ancestor) with `data-g3-probe`, and reads the surface's computed background.
 */
const tagWidget = async (page: Page) =>
  (await page.evaluate(`(() => {
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const heading = Array.from(document.querySelectorAll('h2, h3'))
      .find((el) => (el.textContent || '').trim() === 'Sign Document' && shown(el));
    if (!heading) { return { heading: false, icon: false }; }
    heading.setAttribute('data-g3-probe', 'heading');
    let icon = null;
    for (let n = heading.parentElement, i = 0; n && i < 4 && !icon; n = n.parentElement, i++) {
      icon = Array.from(n.querySelectorAll('button svg')).find(shown) || null;
    }
    if (icon) { icon.setAttribute('data-g3-probe', 'expand'); }
    const surface = heading.closest('.bg-card, .bg-widget');
    if (surface) { surface.setAttribute('data-g3-probe', 'surface'); }
    return {
      heading: true,
      icon: Boolean(icon),
      headingTag: heading.tagName.toLowerCase(),
      surface: surface ? (surface.classList.contains('bg-card') ? 'bg-card' : 'bg-widget') : null,
      surfaceBackground: surface ? getComputedStyle(surface).backgroundColor : null,
    };
  })()`)) as {
    heading: boolean;
    icon: boolean;
    headingTag?: string;
    surface?: string | null;
    surfaceBackground?: string | null;
  };

/**
 * The painted contrast of an element from a screenshot: the most common pixel is the background, the
 * pixel with the highest contrast against it is the text. As round 16's reader.
 */
const paintedContrast = async (page: Page, selector: string) => {
  const png = await page.locator(selector).first().screenshot({ animations: 'disabled' });
  const blank = await page.context().newPage();

  try {
    const pixels = await blank.evaluate(async (data) => {
      const image = new Image();

      image.src = `data:image/png;base64,${data}`;
      await image.decode();

      const canvas = document.createElement('canvas');

      canvas.width = image.width;
      canvas.height = image.height;

      const context = canvas.getContext('2d');

      if (!context) {
        return [];
      }

      context.drawImage(image, 0, 0);

      const raw = context.getImageData(0, 0, image.width, image.height).data;
      const out: number[][] = [];

      for (let i = 0; i < raw.length; i += 4) {
        out.push([raw[i], raw[i + 1], raw[i + 2]]);
      }

      return out;
    }, png.toString('base64'));
    const counts = new Map<string, number>();

    for (const p of pixels) {
      const key = p.join(',');

      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const [r, g, b] = [...counts.entries()]
      .sort((x, y) => y[1] - x[1])[0][0]
      .split(',')
      .map(Number);
    const background: Rgba = { r, g, b, a: 1 };
    let text = background;
    let best = 1;

    for (const [pr, pg, pb] of pixels) {
      const candidate: Rgba = { r: pr, g: pg, b: pb, a: 1 };
      const ratio = contrast(candidate, background);

      if (ratio > best) {
        best = ratio;
        text = candidate;
      }
    }

    return { ratio: best, background, text, pixels: pixels.length };
  } finally {
    await blank.close();
  }
};

/** The heading and Expand icon, by the oracle and by pixels. */
const readWidget = async (page: Page) => {
  const tagged = await tagWidget(page);
  const heading = tagged.heading ? readability(await readComputed(page, '[data-g3-probe="heading"]')) : null;
  const icon = tagged.icon ? readability(await readComputed(page, '[data-g3-probe="expand"]'), 'stroke') : null;
  const headingPixels = tagged.heading ? await paintedContrast(page, '[data-g3-probe="heading"]') : null;
  const iconPixels = tagged.icon ? await paintedContrast(page, '[data-g3-probe="expand"]') : null;

  return { tagged, heading, icon, headingPixels, iconPixels };
};

const logoVisible = async (page: Page) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: admin.teamId } });

  return await page
    .getByRole('img', { name: `${team.name}'s Logo` })
    .first()
    .isVisible();
};

test.describe('[BRANDING_CONTRAST]: tokens fall back too', () => {
  for (const c of [
    { id: 'card-widget', version: 2 as const, colors: CARD_SET, value: CARD_SET.card, icon: true },
    // Amended after the round 22 red run: the V1 Expand icon paints bg-background, so only the heading.
    { id: 'v1-widget', version: 1 as const, colors: WIDGET_SET, value: WIDGET_SET.widget, icon: false },
  ]) {
    /**
     * Catches: stored tokens that hide the signing widget's text left in effect. Amended after the round 22
     * red run: whether the render-time drop or the guard removes them is not asserted, only that the
     * tenant value no longer paints the widget.
     */
    test(`C118-${c.id} stored ${JSON.stringify(c.colors)} on the ${c.version === 2 ? 'mobile' : 'V1'} widget falls back to the default theme`, async ({
      page,
    }, testInfo) => {
      const { token } = await seedToken(`c118-${c.id}`, c.version);

      // Premise: with the logo and no tenant tokens, the widget heading and Expand icon read at least 3:1.
      await seedRow('', null);
      await openWidget(page, token);
      await page.waitForTimeout(1_000);

      const premise = await readWidget(page);

      expect(premise.tagged.heading, 'premise: the widget heading is on screen').toBe(true);
      expect(premise.tagged.icon, 'premise: the Expand icon is on screen').toBe(true);
      expect(premise.heading?.ratio ?? 0, 'premise: the default heading reads at least 3:1').toBeGreaterThanOrEqual(
        BRANDING_CONTRAST_THRESHOLD,
      );
      expect(await logoVisible(page), 'premise: the tenant logo shows').toBe(true);

      await seedRow('', c.colors);

      const status = await openWidget(page, token);

      await page.waitForTimeout(SETTLE_MS);

      const after = await readWidget(page);
      const styles = await tokenStyles(page);
      const surface = parseComputed(after.tagged.surfaceBackground ?? '');
      const tenantPaints = surface ? near(surface, hex(c.value), 3) : null;
      const logo = await logoVisible(page);

      await writeEvidence(testInfo, `c118-${c.id}`, {
        viewport: MOBILE,
        colors: c.colors,
        status,
        premise,
        after,
        styles,
        tenantPaints,
        guard: await guardReasons(page),
        logo,
      });

      await page.screenshot({ path: testInfo.outputPath(`c118-${c.id}.png`) });

      expect.soft(status, 'the page answers 200').toBe(200);
      expect.soft(after.heading?.ratio ?? 0, 'the heading reads at least 3:1 (oracle)').toBeGreaterThanOrEqual(3);
      expect.soft(after.headingPixels?.ratio ?? 0, 'the heading reads at least 3:1 (pixels)').toBeGreaterThanOrEqual(3);

      if (c.icon) {
        expect.soft(after.icon?.ratio ?? 0, 'the Expand icon reads at least 3:1 (oracle)').toBeGreaterThanOrEqual(3);
        expect
          .soft(after.iconPixels?.ratio ?? 0, 'the Expand icon reads at least 3:1 (pixels)')
          .toBeGreaterThanOrEqual(3);
      }

      expect.soft(after.tagged.surface, 'premise: the widget surface was found').toBeTruthy();
      expect
        .soft(tenantPaints, `the tenant ${c.value} is not in effect on the widget (${after.tagged.surfaceBackground})`)
        .toBe(false);
      expect.soft(logo, 'the tenant logo still shows').toBe(true);
    });
  }

  for (const c of [
    {
      id: 'card',
      colors: CARD_SET,
      pairs: [
        ['foreground', 'card'],
        ['mutedForeground', 'card'],
      ],
    },
    { id: 'widget', colors: WIDGET_SET, pairs: [['foreground', 'widget']] },
  ]) {
    /** Catches: a token set that hides widget text accepted at save because its pair is not enumerated. */
    test(`C118-save-${c.id} saving ${JSON.stringify(c.colors)} is refused naming the pair`, async ({
      request: _request,
    }, testInfo) => {
      const save = await saveOrganisationSettings(admin, { brandingColors: c.colors });
      const stored = await prisma.organisationGlobalSettings.findUniqueOrThrow({
        where: { id: admin.organisationGlobalSettingsId },
      });

      await writeEvidence(testInfo, `c118-save-${c.id}`, {
        status: save.status,
        text: save.text,
        stored: stored.brandingColors,
      });

      expect.soft(save.status, 'refused, not saved').not.toBe(200);
      expect.soft(errorBodyHasCode(save.body, 'INVALID_BODY'), `INVALID_BODY: ${save.text.slice(0, 300)}`).toBe(true);

      for (const [foreground, background] of c.pairs) {
        expect
          .soft(namesPair(save.text, foreground, background), `the warning names ${foreground} on ${background}`)
          .toBe(true);
      }

      expect.soft(stored.brandingColors, 'the row is unchanged').toBeNull();
    });
  }
});

/**
 * C120's dark palette as amended after the round 22 red run. Since "Fixed backgrounds are pairs too" it is
 * refused at save: its light `mutedForeground` reads 1.68:1 on the V2 page root's fixed `bg-gray-50`
 * (`document-signing-page-view-v2.tsx:84`, "Page 1 of 1" at `pdf-viewer.tsx:317`).
 */
const DARK_PALETTE = {
  background: '#0b1020',
  foreground: '#f5f7ff',
  card: '#141b33',
  cardForeground: '#f5f7ff',
  muted: '#1c2442',
  mutedForeground: '#b8c0e0',
  widget: '#141b33',
  input: '#8a93b8',
  popover: '#141b33',
  popoverForeground: '#f5f7ff',
  secondaryForeground: '#f5f7ff',
  primary: '#8fb4ff',
  // The amendment's palette still failed two pairs with the lib at 39b2a96d5 (primaryForeground on primary
  // 2.06:1, secondaryForeground on secondary 1.07:1); per the rule, those tokens get dark values.
  primaryForeground: '#0b1020',
  secondary: '#1c2442',
};

/**
 * C118c's readable tokens: the shipped defaults sent explicitly (C120-defaults), which pass every pair and
 * so survive the render-time drop, and which carry `--background`, `--foreground` and `--muted-foreground`
 * for the rewrite.
 */
const READABLE_TOKENS = { ...DEFAULT_BRAND_COLORS };

/**
 * Rewrites every tenant token style element (`tokenStyles`) so `--muted-foreground` takes the value of
 * `--<source>` in the same element. Returns what each element held before and after.
 */
const rewriteMutedForeground = async (page: Page, source: 'background' | 'foreground') =>
  (await page.evaluate(`(() => {
    const styles = Array.from(document.querySelectorAll('style'))
      .filter((s) => /^\\s*\\.documenso-branded\\s*\\{\\s*--/.test(s.textContent || ''));
    return styles.map((s) => {
      const before = s.textContent || '';
      const m = before.match(/--${source}:\\s*([^;]+);/);
      if (!m) { return { before, after: null }; }
      s.textContent = before.replace(/--muted-foreground:\\s*[^;]+;/, '--muted-foreground: ' + m[1] + ';');
      return { before, after: s.textContent };
    });
  })()`)) as { before: string; after: string | null }[];

/** Tags the first visible `text-muted-foreground` element with text, and reads it with the oracle. */
const readMutedText = async (page: Page) => {
  const found = await page.evaluate(() => {
    const element = Array.from(document.querySelectorAll<HTMLElement>('.text-muted-foreground')).find(
      (el) => (el.textContent ?? '').trim() !== '' && el.getBoundingClientRect().width > 0,
    );

    element?.setAttribute('data-g3-probe', 'muted-text');

    return element ? (element.textContent ?? '').trim().slice(0, 80) : null;
  });

  return found
    ? { text: found, readability: readability(await readComputed(page, '[data-g3-probe="muted-text"]')) }
    : null;
};

test.describe('[BRANDING_CONTRAST]: the token step of the guard', () => {
  for (const c of [
    { id: 'stylesheet', css: MARKER, source: 'background' as const, expected: 'disabled' },
    { id: 'stylesheet-readable', css: MARKER, source: 'foreground' as const, expected: 'applied' },
    { id: 'tokens-only', css: '', source: 'background' as const, expected: 'disabled' },
    { id: 'tokens-only-readable', css: '', source: 'foreground' as const, expected: 'applied' },
  ]) {
    /**
     * Catches: a token pair the save-time enumeration missed, which the render-time drop cannot see,
     * left applied because the guard only disables the stylesheet (or, with no stylesheet, never runs).
     * The test rewrites the token style element in place so `--muted-foreground` equals
     * `--${c.source}`; the guard measures again on the mutation.
     */
    test(`C118c-${c.id} --muted-foreground rewritten to --${c.source}${c.css ? ' with a readable stylesheet' : ', tokens only'}`, async ({
      page,
    }, testInfo) => {
      const { token } = await seedToken(`c118c-${c.id}`, 1, [FieldType.SIGNATURE, FieldType.CHECKBOX]);

      await seedRow(c.css, READABLE_TOKENS);
      await openDesktop(page, token);
      await installMarker(page);
      await expect(page.locator(UNCHECKED).first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(SETTLE_MS);

      const before = {
        weight: await markerWeight(page),
        guard: await guardReasons(page),
        styles: await tokenStyles(page),
      };

      // Premise: the readable tokens and stylesheet are applied before the rewrite.
      expect(before.styles.length, 'premise: the token style element is on the page').toBeGreaterThan(0);
      expect(before.guard, 'premise: no guard reason before the rewrite').toEqual([]);

      if (c.css) {
        expect(before.weight, 'premise: the stylesheet is applied before the rewrite').toBe('700');
      }

      const rewritten = await rewriteMutedForeground(page, c.source);

      expect(
        rewritten.every((r) => r.after !== null),
        'premise: each token style element had the source variable',
      ).toBe(true);

      await page.waitForTimeout(SETTLE_MS);

      const styles = await tokenStyles(page);
      const weight = await markerWeight(page);
      const guard = await guardReasons(page);
      const muted = await readMutedText(page);
      const logo = await logoVisible(page);

      await writeEvidence(testInfo, `c118c-${c.id}`, {
        css: c.css,
        before,
        rewritten,
        styles,
        weight,
        guard,
        muted,
        logo,
      });

      expect.soft(logo, 'the tenant logo shows').toBe(true);

      if (c.expected === 'disabled') {
        expect
          .soft(
            styles.map((s) => s.guard),
            'every token style element carries data-branding-guard="tokens"',
          )
          .toEqual(styles.map(() => 'tokens'));
        expect
          .soft(muted?.readability.ratio ?? 0, `muted text reads at least 3:1: ${muted?.text}`)
          .toBeGreaterThanOrEqual(3);

        if (c.css) {
          expect.soft(weight, 'the stylesheet is disabled').not.toBe('700');
        }
      } else {
        expect.soft(guard, 'no guard reason on the page').toEqual([]);

        if (c.css) {
          expect.soft(weight, 'the stylesheet stays applied').toBe('700');
        }
      }
    });
  }
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

    return { mounted: Boolean(real) };
  });

/** Applies `rule` from a test-owned nonced style, as the oracle's prediction of the tenant rule; returns its id. */
const injectRule = async (page: Page, rule: string) =>
  await page.evaluate((text) => {
    const style = document.createElement('style');
    const nonced = Array.from(document.querySelectorAll<HTMLElement>('script,style')).find((element) => element.nonce);

    style.id = 'g3-predict';
    style.nonce = nonced?.nonce ?? '';
    style.textContent = text;
    document.head.appendChild(style);
  }, rule);

const removeRule = async (page: Page) =>
  await page.evaluate(() => {
    document.getElementById('g3-predict')?.remove();
  });

const isFaint = (c: ControlBoundary) => c.key.includes('g3 faint control');
const pick = (list: ControlBoundary[]) =>
  list.filter(isFaint).map((c) => ({ key: c.key, ratio: c.ratio, boundaryPaints: c.boundaryPaints, sides: c.sides }));

test.describe('[BRANDING_CONTRAST]: boundaries keep their baseline', () => {
  for (const c of [
    { id: 'white', rule: '.g3-faint-control{border-color:#ffffff}', expected: 'disabled' },
    { id: 'black', rule: '.g3-faint-control{border-color:#000}', expected: 'applied' },
  ] as const) {
    /**
     * Catches: an opaque border recoloured to match its surround (1:1 against a 1.14:1 baseline) passing
     * because any opaque colour counts as painting; and, for the control, a no-margin rule that disables
     * a stylesheet raising the boundary.
     */
    test(`C119-${c.id} the faint control with ${c.rule}`, async ({ page }, testInfo) => {
      const css = [MARKER, c.rule].join('\n');
      const { token } = await seedToken(`c119-${c.id}`, 1, [FieldType.SIGNATURE, FieldType.CHECKBOX]);

      // Oracle baseline: no tenant stylesheet or tokens, the faint control mounted.
      await openDesktop(page, token);
      await expect(page.locator(UNCHECKED).first()).toBeVisible({ timeout: 15_000 });

      const mounted = await addFaintControl(page);

      await page.locator('[data-field-type] button').first().waitFor();
      await page.waitForTimeout(500);

      const baseline = await readControlBoundaries(page);
      const faint = baseline.find(isFaint);

      // The oracle's prediction: the rule applied over the faint control's own style.
      await injectRule(page, `.g3-faint-control.g3-faint-control${c.rule.slice('.g3-faint-control'.length)}`);

      const predicted = boundaryFailures(await readControlBoundaries(page), baseline);

      await removeRule(page);

      expect(mounted.mounted, 'premise: the real checkbox supplied the classes').toBe(true);
      expect(faint?.ratio ?? 0, 'premise: the faint control paints at about 1.1:1').toBeLessThan(1.3);
      expect(faint?.boundaryPaints, 'premise: its boundary paints in the baseline').toBe(true);
      expect(
        predicted.failing.some(isFaint),
        `premise: the oracle ${c.expected === 'disabled' ? 'fails' : 'passes'} the faint control under the rule`,
      ).toBe(c.expected === 'disabled');

      await seedRow(css, null);
      await openDesktop(page, token);
      await installMarker(page);
      await expect(page.locator(UNCHECKED).first()).toBeVisible({ timeout: 15_000 });
      await addFaintControl(page);
      // Opening the reject dialog makes the guard measure again with the control mounted.
      await page.getByRole('button', { name: 'Reject Document' }).first().click();
      await expect(page.getByRole('dialog').locator('textarea')).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);

      const weight = await markerWeight(page);
      const guard = await guardReasons(page);

      await writeEvidence(testInfo, `c119-${c.id}`, {
        css,
        baseline: pick(baseline),
        predicted: { failing: pick(predicted.failing), margin: pick(predicted.margin) },
        current: pick(await readControlBoundaries(page)),
        weight,
        guard,
      });

      if (c.expected === 'disabled') {
        expect.soft(weight, 'the stylesheet is disabled').not.toBe('700');
      } else {
        expect.soft(weight, 'the stylesheet stays applied').toBe('700');
        expect.soft(guard, 'no guard reason on the page').toEqual([]);
      }
    });
  }
});

/** What the guard has done, with the tenant's own `--variable` and whether it still applies. */
const state = async (page: Page, variable: string, value: string) => {
  await installMarker(page);

  const vars = await readBodyVars(page, [variable]);

  return {
    url: page.url(),
    weight: await markerWeight(page),
    guard: await guardReasons(page),
    tokensApply: near(hslTriplet(vars[variable]), hex(value), 3),
    vars,
  };
};

const PALETTES: { id: string; colors: Record<string, string>; variable: string; value: string }[] = [
  // Criterion 25's accepted palettes ("the round 1 accepted palettes").
  { id: 'defaults', colors: { ...DEFAULT_BRAND_COLORS }, variable: '--primary', value: DEFAULT_BRAND_COLORS.primary },
  {
    id: 'brand',
    colors: { primary: '#c84a44', primaryForeground: '#ffffff' },
    variable: '--primary',
    value: '#c84a44',
  },
];

test.describe('[BRANDING_CONTRAST]: benign tokens stay', () => {
  /**
   * Catches: a dark palette whose light text tokens land on the light theme's fixed surfaces accepted at
   * save, so the signer gets the default theme by fallback instead of the tenant being told. The warning
   * wording for a fixed surface is the implementer's, so only the token is asserted.
   */
  test('C120-dark-refused saving the dark palette is refused naming mutedForeground', async ({
    request: _request,
  }, testInfo) => {
    const save = await saveOrganisationSettings(admin, { brandingColors: DARK_PALETTE });
    const stored = await prisma.organisationGlobalSettings.findUniqueOrThrow({
      where: { id: admin.organisationGlobalSettingsId },
    });

    await writeEvidence(testInfo, 'c120-dark-refused', {
      colors: DARK_PALETTE,
      status: save.status,
      text: save.text,
      stored: stored.brandingColors,
    });

    expect.soft(save.status, 'refused, not saved').not.toBe(200);
    expect.soft(errorBodyHasCode(save.body, 'INVALID_BODY'), `INVALID_BODY: ${save.text.slice(0, 300)}`).toBe(true);
    expect.soft(save.text, 'the warning names mutedForeground').toContain('mutedForeground');
    expect.soft(stored.brandingColors, 'nothing is stored').toBeNull();
  });

  for (const p of PALETTES) {
    /** Catches: the token fallback firing on a palette that passes every pair, at any step of signing. */
    test(`C120-${p.id} the stylesheet and tokens stay applied through signing on the mobile widget`, async ({
      page,
    }, testInfo) => {
      expect(findBrandingTokenProblems(p.colors), 'premise: the palette passes every save-time pair').toEqual([]);

      const save = await saveOrganisationSettings(admin, { brandingCss: MARKER, brandingColors: p.colors });

      expect(save.status, `premise: the palette and stylesheet are saved: ${save.text.slice(0, 300)}`).toBe(200);

      const { token, fields } = await seedToken(`c120-${p.id}`, 2);
      const steps: Record<string, unknown> = {};

      await openWidget(page, token);
      await page.waitForTimeout(SETTLE_MS);
      steps.loaded = await state(page, p.variable, p.value);

      await page.getByRole('button', { name: 'Expand' }).click();
      await page.waitForTimeout(1_000);
      steps.expanded = await state(page, p.variable, p.value);

      await page.getByTestId('signature-pad-dialog-button').filter({ visible: true }).first().click();
      await page.getByRole('tab', { name: 'Type' }).click();
      await page.getByTestId('signature-pad-type-input').fill('Signature');
      await page.waitForTimeout(1_000);
      steps.signaturePad = await state(page, p.variable, p.value);
      await page.getByRole('button', { name: 'Next' }).click();

      const canvas = page.locator('.konva-container canvas').first();

      await expect(canvas).toBeVisible({ timeout: 30_000 });

      const box = await canvas.boundingBox();

      if (!box) {
        throw new Error('The signing canvas has no bounding box');
      }

      for (const field of fields) {
        const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
        const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

        await canvas.click({ position: { x, y } });
        await page.waitForTimeout(500);
      }

      // The widget's subtitle once no field remains (document-signing-mobile-widget.tsx:70).
      await expect(
        page.getByText('Please complete the document once reviewed').filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 10_000 });
      steps.fieldSigned = await state(page, p.variable, p.value);

      await page.getByRole('button', { name: 'Complete' }).filter({ visible: true }).first().click();
      await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
      await page.waitForTimeout(1_000);
      steps.completeDialog = await state(page, p.variable, p.value);

      await page.getByRole('button', { name: 'Sign', exact: true }).click();
      await page.waitForURL(/\/complete/, { timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
      steps.complete = await state(page, p.variable, p.value);

      await writeEvidence(testInfo, `c120-${p.id}`, { viewport: MOBILE, colors: p.colors, steps });

      for (const [step, value] of Object.entries(steps)) {
        const s = value as Awaited<ReturnType<typeof state>>;

        expect.soft(s.guard, `${step}: no guard reason on the page`).toEqual([]);
        expect.soft(s.tokensApply, `${step}: the tenant ${p.variable} applies`).toBe(true);

        expect.soft(s.weight, `${step}: the stylesheet stays applied`).toBe('700');
      }
    });
  }
});
