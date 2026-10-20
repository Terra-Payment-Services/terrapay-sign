/**
 * Fixtures for the branding contrast specs (campaign G3). Written from
 * terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md alone; nothing here reads or
 * imports the contrast checker the specs are for.
 *
 * The oracle is the browser. Every readability verdict is computed from what
 * `getComputedStyle` reports on the signing page, composited as the spec's section 2.2
 * describes, with WCAG 2.2 relative luminance and contrast ratio. The server's answer is
 * asserted too, but a test never trusts it for the dangerous direction.
 *
 * Sessions. The login route allows 50 sign-ins per IP per 15 minutes and Playwright
 * restarts the worker after every failing test, so a per-test sign-in would exhaust it in
 * one red run. Each spec file therefore seeds one admin and signs in once; the storage
 * state is written to the OS temporary directory under a name keyed by the creation time
 * of this run's output directory, which Playwright recreates at the start of every run,
 * so a restarted worker reuses it and the next run does not. It is kept out of the
 * output directory because it holds a session cookie, and evidence must hold no secrets.
 * Tests reset the branding row with Prisma before they start. Because a file's tests share the
 * organisation, each spec file sets `test.describe.configure({ mode: 'default' })`: the config is
 * fullyParallel, and on CI (pipeline 55408) tests of one file ran in several workers at once and
 * overwrote each other's branding rows between a save and its assertion. The session file is keyed by
 * the worker's parallel index too, so a retry running beside the file's worker has its own admin.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import {
  type APIResponse,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiSignin } from './authentication';

export const baseUrl = NEXT_PUBLIC_WEBAPP_URL();

export const CANARY_CSS = 'button { border-color: rgb(1, 2, 3); }';
export const CANARY_COLOR = 'rgb(1, 2, 3)';
export const THRESHOLD = 3;

// ---------------------------------------------------------------------------------------
// Colour arithmetic (WCAG 2.2, spec 2.1 and 2.2)
// ---------------------------------------------------------------------------------------

export type Rgba = { r: number; g: number; b: number; a: number };

export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

const linearise = (channel: number) => {
  const c = channel / 255;

  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const luminance = ({ r, g, b }: Rgba) => 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);

/** WCAG contrast of two opaque colours. */
export const contrast = (x: Rgba, y: Rgba) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);

  return (hi + 0.05) / (lo + 0.05);
};

/** Source-over compositing of `top` on an opaque `bottom`, per sRGB channel, unrounded. */
export const composite = (top: Rgba, bottom: Rgba): Rgba => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});

export const hex = (value: string): Rgba => {
  let h = value.replace('#', '');

  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }

  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
};

/**
 * Parses a colour as Chromium serialises a computed value: `rgb(r, g, b)` or
 * `rgba(r, g, b, a)`. Anything else (`oklch(...)`, `color(srgb ...)`, `none`) returns
 * null, which the readability check treats as unreadable: a kept colour the test cannot
 * measure is not shown to be readable.
 */
export const parseComputed = (value: string): Rgba | null => {
  const match = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);

  if (!match) {
    return null;
  }

  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : Number(match[4]);

  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
};

/** HSL triplet as `toNativeCssVars` and theme.css write it: `h s% l%`. */
export const hslTriplet = (value: string): Rgba | null => {
  const match = value.trim().match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);

  if (!match) {
    return null;
  }

  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;

  const hue = (p: number, q: number, t: number) => {
    let x = t;

    if (x < 0) {
      x += 1;
    }

    if (x > 1) {
      x -= 1;
    }

    if (x < 1 / 6) {
      return p + (q - p) * 6 * x;
    }

    if (x < 1 / 2) {
      return q;
    }

    if (x < 2 / 3) {
      return p + (q - p) * (2 / 3 - x) * 6;
    }

    return p;
  };

  if (s === 0) {
    return { r: l * 255, g: l * 255, b: l * 255, a: 1 };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255, a: 1 };
};

/** Two colours within `tolerance` per channel; HSL round trips lose a little. */
export const near = (x: Rgba | null, y: Rgba, tolerance = 2) =>
  x !== null &&
  Math.abs(x.r - y.r) <= tolerance &&
  Math.abs(x.g - y.g) <= tolerance &&
  Math.abs(x.b - y.b) <= tolerance;

// Defaults the spec's section 1.4 measures, from packages/ui/styles/theme.css.
export const LIGHT_DEFAULTS = {
  background: '#ffffff',
  foreground: '#213871',
  mutedForeground: '#6e7586',
};

export const DARK_DEFAULT_TRIPLETS = {
  background: '222 25% 11%',
  foreground: '0 0% 97%',
  mutedForeground: '222 12% 72%',
};

// ---------------------------------------------------------------------------------------
// Session: one admin per spec file
// ---------------------------------------------------------------------------------------

export type AdminSession = {
  context: BrowserContext;
  page: Page;
  userId: number;
  email: string;
  organisationId: string;
  organisationGlobalSettingsId: string;
  teamId: number;
  teamGlobalSettingsId: string;
};

type StoredSession = Omit<AdminSession, 'context' | 'page'> & { storageState: string };

/**
 * Seeds a non-personal organisation and signs its admin in, or reuses the admin this run
 * already signed in for `key` (see the file header). Redirects to /api/health after
 * sign-in so no dashboard tRPC calls are spent.
 */
export const openAdminSession = async (browser: Browser, testInfo: TestInfo, key: string): Promise<AdminSession> => {
  await fs.mkdir(testInfo.project.outputDir, { recursive: true });

  const run = Math.round((await fs.stat(testInfo.project.outputDir)).birthtimeMs);
  // One admin per worker slot as well as per file: a retry or a repeat that Playwright schedules on
  // another worker while the file's own worker carries on gets an organisation of its own.
  const file = path.join(os.tmpdir(), `g3-admin-${key}-${run}-p${testInfo.parallelIndex}.json`);

  const existing = await fs
    .readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as StoredSession)
    .catch(() => null);

  if (existing) {
    const context = await browser.newContext({ storageState: JSON.parse(existing.storageState) });
    const page = await context.newPage();
    const { storageState: _unused, ...rest } = existing;

    return { ...rest, context, page };
  }

  const { user, team, organisation } = await seedUser({ isPersonalOrganisation: false });

  const context = await browser.newContext();
  const page = await context.newPage();

  await apiSignin({ page, email: user.email, redirectPath: '/api/health' });

  const session: StoredSession = {
    userId: user.id,
    email: user.email,
    organisationId: organisation.id,
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
    teamId: team.id,
    teamGlobalSettingsId: team.teamGlobalSettingsId,
    storageState: JSON.stringify(await context.storageState()),
  };

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(session));

  const { storageState: _unused, ...rest } = session;

  return { ...rest, context, page };
};

/** Branding on, no stylesheet and no tokens, for the organisation and its team. */
export const resetBranding = async (admin: AdminSession) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, brandingCss: '', brandingColors: null },
  });

  await prisma.teamGlobalSettings.update({
    where: { id: admin.teamGlobalSettingsId },
    data: { brandingEnabled: null, brandingCss: null, brandingColors: null },
  });
};

/** A pending V1 document on the admin's team; returns the recipient's signing token. */
export const seedSigningToken = async (admin: AdminSession, label: string) => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: admin.teamId,
    recipients: [`g3-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.documenso.com`],
    fields: [FieldType.SIGNATURE],
  });

  return recipients[0].token;
};

// ---------------------------------------------------------------------------------------
// tRPC
// ---------------------------------------------------------------------------------------

export type SaveResult = {
  status: number;
  body: unknown;
  text: string;
  cssWarnings: { kind: string; detail: string; line?: number }[];
};

const readSave = async (response: APIResponse): Promise<SaveResult> => {
  const text = await response.text();

  expect(response.status(), `tRPC rate limit reached; wait a minute between runs: ${text.slice(0, 200)}`).not.toBe(429);

  let body: unknown = null;

  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; the status and text are still reported.
  }

  const json = (body as { result?: { data?: { json?: { cssWarnings?: SaveResult['cssWarnings'] } } } } | null)?.result
    ?.data?.json;

  return { status: response.status(), body, text, cssWarnings: json?.cssWarnings ?? [] };
};

export const saveOrganisationSettings = async (admin: AdminSession, data: Record<string, unknown>) =>
  await readSave(
    await admin.context.request.post(`${baseUrl}/api/trpc/organisation.settings.update`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({
        json: { organisationId: admin.organisationId, data: { brandingEnabled: true, ...data } },
      }),
    }),
  );

export const saveTeamSettings = async (admin: AdminSession, data: Record<string, unknown>) =>
  await readSave(
    await admin.context.request.post(`${baseUrl}/api/trpc/team.settings.update`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ json: { teamId: admin.teamId, data: { brandingEnabled: true, ...data } } }),
    }),
  );

/** Saves a stylesheet, with the canary appended, and requires the 200 the stylesheet contract promises. */
export const saveCss = async (admin: AdminSession, css: string) => {
  const result = await saveOrganisationSettings(admin, { brandingCss: `${css}\n${CANARY_CSS}` });

  expect(result.status, `stylesheet save answers 200: ${result.text.slice(0, 300)}`).toBe(200);

  return result;
};

export type StoredBranding = { brandingCss: string; brandingColors: Record<string, string> | null };

/** The organisation's stored branding as `organisation.get` returns it. */
export const readOrganisationBranding = async (admin: AdminSession): Promise<StoredBranding> => {
  const input = encodeURIComponent(JSON.stringify({ json: { organisationReference: admin.organisationId } }));
  const response = await admin.context.request.get(`${baseUrl}/api/trpc/organisation.get?input=${input}`);

  expect(response.status(), 'tRPC rate limit reached').not.toBe(429);
  expect(response.ok()).toBe(true);

  const settings = (await response.json()).result.data.json.organisationGlobalSettings;

  return { brandingCss: String(settings.brandingCss ?? ''), brandingColors: settings.brandingColors ?? null };
};

/** Finds a string value equal to `code` anywhere in a tRPC error body. */
export const errorBodyHasCode = (body: unknown, code: string): boolean => {
  if (body === code) {
    return true;
  }

  if (body && typeof body === 'object') {
    return Object.values(body as Record<string, unknown>).some((value) => errorBodyHasCode(value, code));
  }

  return false;
};

// ---------------------------------------------------------------------------------------
// Stored CSS
// ---------------------------------------------------------------------------------------

/** Decodes CSS escapes as a CSS tokenizer does (copied from branding-css-hide-reject.spec.ts). */
export const decodeCssEscapes = (css: string) =>
  css.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f]))/g, (_match, hexDigits, char) => {
    if (hexDigits === undefined) {
      return char;
    }

    const codePoint = parseInt(hexDigits, 16);

    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return '�';
    }

    return String.fromCodePoint(codePoint);
  });

const normaliseCss = (css: string) => decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, '')).toLowerCase();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The declaration text of every block whose selector is exactly `selector`, decoded and lowercased. */
export const blocksFor = (css: string, selector: string) => {
  const pattern = new RegExp(`(?:^|[}{;\\s])${escapeRegExp(selector.toLowerCase())}\\s*\\{([^{}]*)\\}`, 'g');

  return [...normaliseCss(css).matchAll(pattern)].map((match) => match[1]);
};

const CHECKED_PROPERTY = /(?:^|[;{\s])(color|background-color|background-image|background|fill|stroke)\s*:/;

/** True when any block for `selector` still holds a checked colour declaration (spec 2.4). */
export const keepsCheckedDeclaration = (css: string, selector: string) =>
  blocksFor(css, selector).some((block) => CHECKED_PROPERTY.test(block));

/**
 * The `contrast` warning whose detail names `selector`, matched with an identifier boundary
 * after it so `.g3-a-7` does not match a warning for `.g3-a-70`, whatever the quoting.
 */
export const contrastWarningFor = (warnings: SaveResult['cssWarnings'], selector: string) => {
  const pattern = new RegExp(`${escapeRegExp(selector)}(?![-_a-zA-Z0-9])`);

  return warnings.find((warning) => warning.kind === 'contrast' && pattern.test(warning.detail));
};

// ---------------------------------------------------------------------------------------
// Signing page
// ---------------------------------------------------------------------------------------

export type Mode = 'light' | 'dark-media' | 'dark-cookie';

export const ALL_MODES: Mode[] = ['light', 'dark-media', 'dark-cookie'];

/**
 * Opens the recipient's signing page in `mode`: `light` emulates a light system
 * preference with no theme cookie, `dark-media` a dark one with no cookie, and
 * `dark-cookie` sets the theme cookie to dark through the app's /api/theme action while
 * the system preference stays light. Asserts `<html>` carries `dark` exactly in the dark
 * modes, and that the branding canary reached the Reject button.
 */
export const openSigningPage = async (page: Page, token: string, mode: Mode = 'light') => {
  await page.emulateMedia({ colorScheme: mode === 'dark-media' ? 'dark' : 'light' });

  const theme = await page.context().request.post(`${baseUrl}/api/theme`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ theme: mode === 'dark-cookie' ? 'dark' : null }),
  });

  expect(theme.ok(), `theme action: ${theme.status()}`).toBe(true);

  await page.goto(`${baseUrl}/sign/${token}`);

  const rejectButton = page.getByRole('button', { name: 'Reject Document' });

  await expect(rejectButton).toBeVisible({ timeout: 30_000 });

  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));

  expect(isDark, `<html> carries "dark" in mode ${mode}`).toBe(mode !== 'light');

  const isBranded = await page.evaluate(() => document.body.classList.contains('documenso-branded'));

  expect(isBranded, 'premise: <body> carries documenso-branded').toBe(true);

  return rejectButton;
};

export const expectCanary = async (page: Page) => {
  await expect(page.getByRole('button', { name: 'Reject Document' })).toHaveCSS('border-top-color', CANARY_COLOR);
};

export type ComputedPair = {
  selector: string;
  color: string;
  fill: string;
  stroke: string;
  /** From the element up to `<html>`. `opacity` is the node's computed opacity; absent reads as 1. */
  layers: { backgroundColor: string; backgroundImage: string; opacity?: string }[];
};

/** Computed foreground colours of the element, and the background layers from it up to `<html>`. */
export const readComputed = async (page: Page, selector: string): Promise<ComputedPair> =>
  await page.evaluate((target) => {
    const element = document.querySelector(target);

    if (!element) {
      throw new Error(`no element for ${target}`);
    }

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

    return { selector: target, color: style.color, fill: style.fill, stroke: style.stroke, layers };
  }, selector);

/** Splits a computed `background-image` into its layers, topmost first. */
const splitLayers = (image: string) => {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < image.length; i++) {
    if (image[i] === '(') {
      depth++;
    } else if (image[i] === ')') {
      depth--;
    } else if (image[i] === ',' && depth === 0) {
      layers.push(image.slice(start, i).trim());
      start = i + 1;
    }
  }

  layers.push(image.slice(start).trim());

  return layers.filter((layer) => layer !== '' && layer !== 'none');
};

const GRADIENT_SAMPLES = 32;

/**
 * Every colour a gradient layer paints, sampled along the interpolation between each
 * pair of adjacent stops (premultiplied sRGB, the CSS default), not only at the stops.
 * Positions only move where a colour falls, so the painted set does not depend on them.
 * Returns [] for a layer that paints no colour (`url()`), null when it cannot be read.
 */
const gradientSamples = (layer: string): Rgba[] | null => {
  if (!/gradient\(/i.test(layer)) {
    return [];
  }

  const stops = (layer.match(/rgba?\([^)]*\)/g) ?? []).map(parseComputed);

  if (stops.length === 0 || stops.some((stop) => stop === null)) {
    return null;
  }

  const list = stops as Rgba[];

  if (/conic-gradient/i.test(layer)) {
    list.push(list[0]);
  }

  if (list.length === 1) {
    return list;
  }

  const samples: Rgba[] = [];

  for (let i = 0; i < list.length - 1; i++) {
    const [p, q] = [list[i], list[i + 1]];

    for (let k = 0; k <= GRADIENT_SAMPLES; k++) {
      const t = k / GRADIENT_SAMPLES;
      const a = p.a + (q.a - p.a) * t;
      const mix = (x: number, y: number) => (a === 0 ? 0 : (x * p.a + (y * q.a - x * p.a) * t) / a);

      samples.push({ r: mix(p.r, q.r), g: mix(p.g, q.g), b: mix(p.b, q.b), a });
    }
  }

  return samples;
};

export type Readability = {
  ratio: number;
  foreground: string;
  backgrounds: string[];
  /** The background giving the lowest ratio, when one was measured. */
  worst?: string;
  unmeasurable?: string;
};

/** Source-over compositing of `top` on a `bottom` that may itself be translucent, unrounded. */
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top.a + bottom.a * (1 - top.a);

  if (a === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;

  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
};

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** One painted path: the pixel under the glyph without it (`bg`) and with it (`text`). */
type Painted = { bg: Rgba; text: Rgba };

const dedupePainted = (list: Painted[]) => {
  const seen = new Map<string, Painted>();
  const key = (c: Rgba) =>
    `${Math.round(c.r * 2)},${Math.round(c.g * 2)},${Math.round(c.b * 2)},${Math.round(c.a * 200)}`;

  for (const p of list) {
    seen.set(`${key(p.bg)}|${key(p.text)}`, p);
  }

  return [...seen.values()];
};

/**
 * The lowest contrast of `foreground` against every background the element can show:
 * each element's background colour and then its image layers, bottom layer first, are
 * composited from `<html>` down over a white canvas, and every gradient contributes every
 * colour along its interpolation (spec 2.2 and 2.4).
 *
 * Opacity (round 15): a node with `opacity` below 1 is an isolated group. Its own background,
 * its descendants' backgrounds and the glyph are painted on transparent, then the group is
 * composited at that opacity over the backdrop beneath it. So the glyph's alpha is multiplied by
 * the cumulative opacity of the element and its ancestors up to the node that supplies the
 * background, and a background supplied inside the faded group is faded the same way. With every
 * opacity at 1 this is exactly the earlier oracle.
 */
export const readability = (pair: ComputedPair, foreground: 'color' | 'fill' | 'stroke' = 'color'): Readability => {
  const value = pair[foreground];
  const root = [...pair.layers].reverse();
  const describe = (c: Rgba) => `rgb(${c.r.toFixed(1)}, ${c.g.toFixed(1)}, ${c.b.toFixed(1)})`;
  const fg = value === 'none' ? null : parseComputed(value);
  let failure: string | undefined;

  const paint = (k: number, backdrops: Painted[]): Painted[] => {
    const layer = root[k];
    const colour = parseComputed(layer.backgroundColor);

    if (colour === null) {
      failure = `background ${layer.backgroundColor}`;

      return [];
    }

    const opacity = layer.opacity === undefined ? 1 : Number(layer.opacity);
    const isolated = opacity < 1;
    let paths: Painted[] = isolated ? [{ bg: TRANSPARENT, text: TRANSPARENT }] : backdrops;

    paths = paths.map((p) => ({ bg: over(colour, p.bg), text: over(colour, p.text) }));

    for (const image of splitLayers(layer.backgroundImage).reverse()) {
      const samples = gradientSamples(image);

      if (samples === null) {
        failure = `gradient ${image}`;

        return [];
      }

      if (samples.length > 0) {
        paths = dedupePainted(
          paths.flatMap((p) => samples.map((sample) => ({ bg: over(sample, p.bg), text: over(sample, p.text) }))),
        );
      }
    }

    if (k < root.length - 1) {
      paths = paint(k + 1, paths);
    } else if (fg) {
      paths = paths.map((p) => ({ bg: p.bg, text: over(fg, p.text) }));
    }

    if (!isolated) {
      return paths;
    }

    const fade = (c: Rgba): Rgba => ({ ...c, a: c.a * opacity });

    return dedupePainted(
      backdrops.flatMap((b) => paths.map((p) => ({ bg: over(fade(p.bg), b.bg), text: over(fade(p.text), b.text) }))),
    );
  };

  const painted = root.length === 0 ? [{ bg: WHITE, text: WHITE }] : paint(0, [{ bg: WHITE, text: WHITE }]);

  if (failure) {
    return { ratio: 0, foreground: value, backgrounds: [], unmeasurable: failure };
  }

  const backgrounds = painted.map((p) => describe(p.bg));

  if (value === 'none') {
    return { ratio: 1, foreground: value, backgrounds };
  }

  if (fg === null) {
    return { ratio: 0, foreground: value, backgrounds, unmeasurable: `foreground ${value}` };
  }

  const ratios = painted.map((p) => contrast(p.text, p.bg));
  const ratio = Math.min(...ratios);

  return {
    ratio,
    foreground: value,
    backgrounds,
    worst: describe(painted[ratios.indexOf(ratio)].bg),
  };
};

/** Computed custom properties on `<body>`, where the tenant tokens are written. */
export const readBodyVars = async (page: Page, names: string[]) =>
  await page.evaluate(
    (keys) =>
      Object.fromEntries(keys.map((key) => [key, getComputedStyle(document.body).getPropertyValue(key).trim()])),
    names,
  );

/**
 * What the browser computes for `declaration` on a fresh element, through a test-owned
 * nonced `<style>`, independent of anything the server stored. Evidence for the parser
 * differential (criteria 11 and 28).
 */
export const browserComputes = async (page: Page, declarations: string[]) =>
  await page.evaluate((list) => {
    const out: Record<string, { color: string; backgroundColor: string; backgroundImage: string }> = {};

    list.forEach((declaration, index) => {
      const name = `g3-diff-${index}`;
      const style = document.createElement('style');

      // The page's CSP admits only nonced <style>; borrow the nonce the page already uses.
      // The sentinel outline colour proves the rule applied.
      style.nonce = document.querySelector<HTMLElement>('style[nonce], script[nonce]')?.nonce ?? '';
      style.textContent = `.${name} { outline-color: rgb(4, 5, 6); ${declaration} }`;
      document.head.appendChild(style);

      const element = document.createElement('div');

      element.className = name;
      element.style.setProperty('display', 'block');
      document.documentElement.appendChild(element);

      const computed = getComputedStyle(element);

      if (computed.outlineColor !== 'rgb(4, 5, 6)') {
        throw new Error(`the test-owned <style> did not apply (CSP?): ${declaration}`);
      }

      out[declaration] = {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        backgroundImage: computed.backgroundImage,
      };

      element.remove();
      style.remove();
    });

    return out;
  }, declarations);

/** The inherited text colour a fresh element under `<html>` gets with no declaration. */
export const baselineColor = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.createElement('div');

    document.documentElement.appendChild(element);

    const color = getComputedStyle(element).color;

    element.remove();

    return color;
  });

// ---------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------

export const writeEvidence = async (testInfo: TestInfo, name: string, data: unknown) => {
  const file = testInfo.outputPath(`${name}.json`);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
};

export const screenshot = async (page: Page, testInfo: TestInfo, name: string) => {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
};

// ---------------------------------------------------------------------------------------
// Stylesheet case runner
// ---------------------------------------------------------------------------------------

/**
 * How a case is observed. `div`, `label` and `p` append that element holding "Label";
 * `stroke-icon` a Lucide-shaped svg (`stroke="currentColor"`, `fill="none"`), measured by
 * its stroke; `fill-icon` a filled svg (`fill="currentColor"`, `stroke="none"`), measured
 * by its fill; `reject` the page's real Reject Document button.
 */
export type ProbeKind = 'div' | 'label' | 'p' | 'stroke-icon' | 'fill-icon' | 'reject';

export type CssCase = {
  /** Unique label; also the probe's data-g3-probe value. */
  id: string;
  /** The rule's selector exactly as written in `css`; used to find its stored block and its warning. */
  selector: string;
  css: string;
  expected: 'refused' | 'kept';
  probe?: ProbeKind;
  /** Class put on the probe so the rule matches it; defaults to the selector's class. */
  className?: string;
  /** Declarations that must survive unchanged when kept. */
  keep?: string[];
  /** Refused cases expect a `contrast` warning naming the selector unless this is false. */
  contrastWarning?: boolean;
};

const classOf = (selector: string) => selector.match(/\.([a-z0-9-]+)\s*$/i)?.[1] ?? '';

const measureOf = (kind: ProbeKind) => (kind === 'stroke-icon' ? 'stroke' : kind === 'fill-icon' ? 'fill' : 'color');

const compact = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*/g, ':')
    .trim()
    .toLowerCase();

export const keepsDeclarationsUnchanged = (css: string, selector: string, declarations: string[]) => {
  const blocks = blocksFor(css, selector).map(compact);

  return declarations.every((declaration) => blocks.some((block) => block.includes(compact(declaration))));
};

/** Appends the probes for `cases` and returns the selector to read for each. */
export const addProbes = async (page: Page, cases: CssCase[]) => {
  const specs = cases.map((c) => ({ id: c.id, kind: c.probe ?? 'div', className: c.className ?? classOf(c.selector) }));

  await page.evaluate((list) => {
    const svgNs = 'http://www.w3.org/2000/svg';

    for (const { id, kind, className } of list) {
      if (kind === 'reject') {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Reject Document',
        );

        button?.setAttribute('data-g3-probe', id);
        continue;
      }

      if (kind === 'stroke-icon' || kind === 'fill-icon') {
        const wrapper = document.createElement('div');
        const svg = document.createElementNS(svgNs, 'svg');
        const shape = document.createElementNS(svgNs, 'path');

        svg.setAttribute('class', className);
        svg.setAttribute('data-g3-probe', id);
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('fill', kind === 'fill-icon' ? 'currentColor' : 'none');
        svg.setAttribute('stroke', kind === 'fill-icon' ? 'none' : 'currentColor');
        svg.setAttribute('stroke-width', '2');
        shape.setAttribute('d', 'M2 2 L22 2 L22 22 Z');
        svg.appendChild(shape);
        wrapper.appendChild(svg);
        document.body.appendChild(wrapper);
        continue;
      }

      const element = document.createElement(kind);

      if (className) {
        element.className = className;
      }

      element.setAttribute('data-g3-probe', id);
      element.textContent = 'Label';
      document.body.appendChild(element);
    }
  }, specs);

  return Object.fromEntries(specs.map((s) => [s.id, `[data-g3-probe="${s.id}"]`]));
};

export type StylesheetRun = {
  save: SaveResult;
  storedCss: string;
  measurements: Record<Mode, Record<string, { computed: ComputedPair; readability: Readability }>>;
};

/**
 * Saves every case's rule in one stylesheet (plus the canary), reads the stored CSS back,
 * opens the signing page in each mode and measures every probe, then checks each case
 * with soft assertions so a red run lists every failing entry:
 *
 * - refused: a `contrast` warning names the selector, its stored block holds no checked
 *   colour declaration, and the probe reads at least 3:1 in every mode;
 * - kept: no `contrast` warning names the selector, the listed declarations survive, and
 *   the probe reads at least 3:1 in every mode.
 */
export const runStylesheetCases = async ({
  admin,
  page,
  testInfo,
  name,
  cases,
  modes = ['light'],
  route = 'organisation',
}: {
  admin: AdminSession;
  page: Page;
  testInfo: TestInfo;
  name: string;
  cases: CssCase[];
  modes?: Mode[];
  route?: 'organisation' | 'team';
}): Promise<StylesheetRun> => {
  const css = cases.map((c) => c.css).join('\n');

  const save =
    route === 'organisation'
      ? await saveCss(admin, css)
      : await saveTeamSettings(admin, { brandingCss: `${css}\n${CANARY_CSS}` });

  expect(save.status, `stylesheet save answers 200: ${save.text.slice(0, 300)}`).toBe(200);

  const storedCss =
    route === 'organisation'
      ? (await readOrganisationBranding(admin)).brandingCss
      : String(
          (await prisma.teamGlobalSettings.findUniqueOrThrow({ where: { id: admin.teamGlobalSettingsId } }))
            .brandingCss ?? '',
        );

  const token = await seedSigningToken(admin, name);
  const measurements = {} as StylesheetRun['measurements'];

  for (const mode of modes) {
    await openSigningPage(page, token, mode);
    await expectCanary(page);

    const selectors = await addProbes(page, cases);

    measurements[mode] = {};

    for (const c of cases) {
      const computed = await readComputed(page, selectors[c.id]);

      measurements[mode][c.id] = { computed, readability: readability(computed, measureOf(c.probe ?? 'div')) };
    }

    await screenshot(page, testInfo, `${name}-${mode}`);
  }

  await writeEvidence(testInfo, name, {
    submittedCss: css,
    response: save.body,
    storedCss,
    measurements,
  });

  for (const c of cases) {
    const warning = contrastWarningFor(save.cssWarnings, c.selector);

    if (c.expected === 'refused') {
      if (c.contrastWarning !== false) {
        expect.soft(warning, `${c.id}: a contrast warning names ${c.selector}`).toBeDefined();
      }

      expect
        .soft(
          keepsCheckedDeclaration(storedCss, c.selector),
          `${c.id}: stored CSS has no checked colour in ${c.selector}`,
        )
        .toBe(false);
    } else {
      expect.soft(warning, `${c.id}: no contrast warning for ${c.selector}`).toBeUndefined();
      expect
        .soft(
          keepsDeclarationsUnchanged(storedCss, c.selector, c.keep ?? []),
          `${c.id}: stored CSS keeps ${JSON.stringify(c.keep)} in ${c.selector}`,
        )
        .toBe(true);
    }

    for (const mode of modes) {
      const { readability: r } = measurements[mode][c.id];

      expect
        .soft(
          r.ratio,
          `${c.id} [${mode}]: computed ${r.foreground} on ${r.worst ?? r.backgrounds.join(' | ')} (lowest of ${r.backgrounds.length}) ${r.unmeasurable ?? ''}`,
        )
        .toBeGreaterThanOrEqual(THRESHOLD);
    }
  }

  return { save, storedCss, measurements };
};

// ---------------------------------------------------------------------------------------
// Forced interleaving
// ---------------------------------------------------------------------------------------

/**
 * Waits until at least `count` database backends are waiting on a lock, at least one of
 * them on the backend `pid`, or until `timeoutMs` passes. Returns the most seen at once,
 * which is the probe that the interleaving window was hit.
 */
export const waitForLockWaiters = async (pid: number, count: number, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let most = 0;

  while (Date.now() < deadline) {
    const [{ waiting, onHolder }] = await prisma.$queryRaw<Array<{ waiting: number; onHolder: number }>>`
      SELECT count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0)::int AS "waiting",
             count(*) FILTER (WHERE ${pid}::int = ANY(pg_blocking_pids(pid)))::int AS "onHolder"
      FROM pg_stat_activity WHERE datname = current_database()`;

    most = Math.max(most, onHolder > 0 ? waiting : 0);

    if (onHolder > 0 && waiting >= count) {
      return most;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return most;
};

/**
 * Measures an element styled by a test-owned, nonced rule, independent of the server.
 * Used to check the readability oracle itself.
 */
export const measureTestOwned = async (page: Page, className: string, declarations: string) => {
  await page.evaluate(
    ({ name, body }) => {
      const style = document.createElement('style');

      style.nonce = document.querySelector<HTMLElement>('style[nonce], script[nonce]')?.nonce ?? '';
      style.textContent = `.${name} { ${body} }`;
      document.head.appendChild(style);

      const element = document.createElement('div');

      element.className = name;
      element.textContent = 'Label';
      document.body.appendChild(element);
    },
    { name: className, body: declarations },
  );

  return await readComputed(page, `.${className}`);
};

// ---------------------------------------------------------------------------------------
// Control boundaries (round 20, WCAG 2.2 SC 1.4.11)
// ---------------------------------------------------------------------------------------

export type ControlBoundary = {
  key: string;
  tag: string;
  role: string | null;
  /** The start of the control's outer HTML, to identify it in evidence. */
  hint: string;
  /** The effective background behind the control: its parent's, composited down to a white canvas. */
  behind: string;
  /** The control's own background composited over `behind`. */
  own: string;
  /** Painted border sides (width above 0, style not none or hidden) and each one's ratio against `behind`. */
  sides: { side: string; width: string; color: string; ratio: number }[];
  backgroundRatio: number;
  /** The better of the best border side and the own background, as the round 20 rule takes either. */
  ratio: number;
  /** Neither its own background nor any border side paints: every one is fully transparent or absent. */
  paintsNothing: boolean;
  /**
   * Round 21: its boundary paints, some border side with width above 0 and a visible colour, or its own
   * background differing from what is behind it.
   */
  boundaryPaints: boolean;
  /** It shows text, a value or a placeholder (fields are measured for their boundary as well, round 21). */
  hasText: boolean;
  /** Why the oracle could not judge it (a background image on the chain), if it could not. */
  unmeasurable?: string;
};

/**
 * The oracle's control boundaries, by the round 20 rule: every visible, enabled control not already
 * measured through text, an SVG or a placeholder (native checkbox and radio inputs, `[role=checkbox]`,
 * `[role=radio]`, `[role=switch]`, and any `button`, `input`, `textarea` or `select` whose own text,
 * value and placeholder are all empty and which holds no SVG). Each passes when a painted border side,
 * or its own background, has at least 3:1 against the background behind it. Backgrounds are composited
 * by alpha from `<html>` down over white; opacity is not applied. Written as a string so tsx's `__name`
 * helper never reaches the page.
 */
export const readControlBoundaries = async (page: Page): Promise<ControlBoundary[]> =>
  (await page.evaluate(`(() => {
    const parse = (value) => {
      const m = value.match(/rgba?\\(([^)]+)\\)/);
      if (!m) { return null; }
      const p = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (top, bottom) => {
      const a = top.a + bottom.a * (1 - top.a);
      if (a === 0) { return { r: 0, g: 0, b: 0, a: 0 }; }
      const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
      return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
    };
    const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (x, y) => { const a = lum(x); const b = lum(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const str = (c) => 'rgb(' + c.r.toFixed(1) + ', ' + c.g.toFixed(1) + ', ' + c.b.toFixed(1) + ')';
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) { return false; }
      for (let n = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) { return false; }
      }
      return true;
    };
    const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const isToggle = (el) =>
      (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) ||
      ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '');
    const isEmptyButton = (el) =>
      el.tagName === 'BUTTON' &&
      (el.textContent || '').trim() === '' &&
      (el.value === undefined || String(el.value) === '');
    // Round 21: fields are measured for their boundary whatever they hold.
    const UNBOUNDED_INPUTS = ['hidden', 'submit', 'button', 'reset', 'image', 'range', 'color', 'file'];
    const isField = (el) =>
      (el.tagName === 'INPUT' && !UNBOUNDED_INPUTS.includes(el.type)) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    const candidates = Array.from(
      document.querySelectorAll('input, button, textarea, select, [role=checkbox], [role=radio], [role=switch]'),
    ).filter(
      (el) =>
        (isField(el) || ((isToggle(el) || isEmptyButton(el)) && !el.querySelector('svg'))) && visible(el) && enabled(el),
    );
    const seen = new Map();
    return candidates.map((el) => {
      const chain = [];
      let image = null;
      for (let n = el.parentElement; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage !== 'none' && !image) { image = s.backgroundImage; }
        chain.push(parse(s.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 });
      }
      let behind = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of chain.reverse()) { behind = over(layer, behind); }
      const style = getComputedStyle(el);
      const ownLayer = parse(style.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
      const own = over(ownLayer, behind);
      const sides = ['top', 'right', 'bottom', 'left'].flatMap((side) => {
        const width = style.getPropertyValue('border-' + side + '-width');
        const kind = style.getPropertyValue('border-' + side + '-style');
        const color = style.getPropertyValue('border-' + side + '-color');
        if (!(parseFloat(width) > 0) || kind === 'none' || kind === 'hidden') { return []; }
        const painted = over(parse(color) || { r: 0, g: 0, b: 0, a: 0 }, own);
        return [{ side, width, color, ratio: ratio(painted, behind) }];
      });
      const backgroundRatio = ratio(own, behind);
      const same = (x, y) => Math.abs(x.r - y.r) < 0.5 && Math.abs(x.g - y.g) < 0.5 && Math.abs(x.b - y.b) < 0.5;
      const boundaryPaints = sides.some((s) => (parse(s.color) || { a: 0 }).a > 0) || !same(own, behind);
      const paintsNothing =
        ownLayer.a === 0 &&
        style.backgroundImage === 'none' &&
        sides.every((s) => (parse(s.color) || { a: 0 }).a === 0);
      const best = Math.max(backgroundRatio, ...sides.map((s) => s.ratio));
      const name = el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '';
      const base = el.tagName.toLowerCase() + '|' + (el.getAttribute('role') || '') + '|' + name;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return {
        key: base + '#' + n,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        hint: el.outerHTML.slice(0, 160),
        behind: str(behind),
        own: str(own),
        sides,
        backgroundRatio,
        ratio: best,
        paintsNothing,
        boundaryPaints,
        hasText: (el.textContent || '').trim() !== '' || (el.value !== undefined && String(el.value) !== '') || Boolean(el.getAttribute('placeholder')),
        ...(image ? { unmeasurable: 'background image ' + image } : {}),
      };
    });
  })()`)) as ControlBoundary[];

/**
 * The controls that fail the boundary rule as round 22 states it: below 3:1 and below the same control's
 * ratio in `baseline`, the default theme with neither the tenant stylesheet nor the tenant tokens. There
 * is no margin for boundaries (round 22); `margin` lists the controls under 3:1 that pass because they are
 * no worse than their baseline. A control whose default-theme border and own background paint nothing (a
 * transparent click overlay) is excluded and listed in `excluded`; the decision comes from `baseline`, so
 * a tenant cannot exempt a control by making it transparent. An erased boundary (one that paints in
 * `baseline` and nothing now) fails by its ratio like any other, opaque or not; `erased` lists them for
 * the evidence only, as round 22 replaced round 21's alpha test.
 */
export const boundaryFailures = (current: ControlBoundary[], baseline: ControlBoundary[] = []) => {
  const byKey = new Map(baseline.map((b) => [b.key, b]));
  const failing: (ControlBoundary & { baselineRatio?: number })[] = [];
  const margin: (ControlBoundary & { baselineRatio: number })[] = [];
  const excluded: ControlBoundary[] = [];
  const erased: (ControlBoundary & { baselineRatio: number })[] = [];

  for (const control of current) {
    const before = byKey.get(control.key);

    if (before?.paintsNothing) {
      excluded.push(control);
      continue;
    }

    if (before?.boundaryPaints && !control.boundaryPaints) {
      erased.push({ ...control, baselineRatio: before.ratio });
    }

    if (control.ratio >= THRESHOLD) {
      continue;
    }

    if (before && control.ratio >= before.ratio) {
      margin.push({ ...control, baselineRatio: before.ratio });
    } else {
      failing.push({ ...control, baselineRatio: before?.ratio });
    }
  }

  return { failing, margin, excluded, erased };
};
