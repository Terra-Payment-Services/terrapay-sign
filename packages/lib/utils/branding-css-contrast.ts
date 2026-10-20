import type { Declaration, Rule } from 'postcss';
import postcss from 'postcss';

import type { TCssVarsSchema } from '../types/css-vars';
import { type BackgroundState, backgroundSurface, type Paint, readBackgroundDeclaration } from './branding-background';
import {
  BRANDING_CONTRAST_THRESHOLD,
  BRANDING_THEMES,
  type BrandingTheme,
  brandingTokenOrDefault,
  formatContrastRatio,
} from './branding-contrast';
import { createWarningList, finishWarnings, removeNodes } from './branding-css-bounds';
import {
  asciiLowerCase,
  compositeColour,
  contrastRatio,
  MAX_BRANDING_VALUE_LENGTH,
  parseCssColour,
  type Rgba,
  showBrandingValue,
  trimCssSpace,
} from './parse-css-colour';
import { decodeCssEscapes, type SanitizeBrandingCssResult } from './sanitize-branding-css';

const FOREGROUND_PROPERTIES = new Set(['color', 'fill', 'stroke']);
const BACKGROUND_PROPERTIES = new Set(['background', 'background-color', 'background-image']);

/**
 * The most work one stylesheet may cost the check, at save and on every page load. Past either
 * limit the rest of the stylesheet loses its checked colours rather than being measured.
 */
const MAX_CHECKED_DECLARATIONS = 5000;
const MAX_COMPARISONS = 200_000;

type Page = { background: Rgba; foreground: Rgba };

type Verdict = { ok: true } | { ok: false; reason: string };

const toHex = ({ r, g, b }: Rgba) =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

const propOf = (decl: Declaration) => asciiLowerCase(decodeCssEscapes(decl.prop));

const isCheckedDeclaration = (decl: Declaration) => {
  const prop = propOf(decl);

  return FOREGROUND_PROPERTIES.has(prop) || BACKGROUND_PROPERTIES.has(prop);
};

/** A rule's checked colours, read before any verdict so a warning can name both sides. */
type RuleColours = {
  foregrounds: Paint[];
  states: BackgroundState[];
  /** Values that cannot be measured, as `prop "value"`, with whether any is a gradient. */
  unreadable: string[];
  hasGradient: boolean;
  foregroundTexts: string[];
  backgroundTexts: string[];
};

const readRule = (rule: Rule): RuleColours => {
  const colours: RuleColours = {
    foregrounds: [],
    states: [],
    unreadable: [],
    hasGradient: false,
    foregroundTexts: [],
    backgroundTexts: [],
  };
  const seen = new Set<string>();
  let current: Paint | null = null;

  rule.each((node) => {
    if (node.type !== 'decl') {
      return;
    }

    const prop = propOf(node);

    // A value too long to evaluate is unreadable, so its rule loses its checked colours.
    if (node.value.length > MAX_BRANDING_VALUE_LENGTH && isCheckedDeclaration(node)) {
      const shown = showBrandingValue(node.value);

      (FOREGROUND_PROPERTIES.has(prop) ? colours.foregroundTexts : colours.backgroundTexts).push(shown);
      colours.unreadable.push(`${prop} ${shown}`);

      return;
    }

    const value = trimCssSpace(node.value);
    const keyword = asciiLowerCase(value);

    if (FOREGROUND_PROPERTIES.has(prop)) {
      if ((prop !== 'color' && keyword === 'currentcolor') || (prop === 'fill' && keyword === 'none')) {
        return;
      }

      const colour = parseCssColour(value);

      colours.foregroundTexts.push(value);

      if (colour) {
        colours.foregrounds.push({ colour, text: value });
      } else {
        colours.unreadable.push(`${prop} "${value}"`);
      }
    }

    if (BACKGROUND_PROPERTIES.has(prop)) {
      const background = readBackgroundDeclaration(prop, value);

      colours.backgroundTexts.push(value);

      if ('refused' in background) {
        colours.unreadable.push(`${prop} "${value}"`);
        colours.hasGradient ||= background.refused === 'gradient';

        return;
      }

      // The colour as the cascade leaves it after this declaration; a shorthand resets it.
      current = prop === 'background-image' ? current : background.colour;

      // Exact channels: a rounded key could merge a passing state with a failing one.
      const key = current ? `${current.colour.r},${current.colour.g},${current.colour.b},${current.colour.a}` : 'none';

      if (!seen.has(key)) {
        seen.add(key);
        colours.states.push({ colour: current, text: current ? current.text : 'none' });
      }
    }
  });

  return colours;
};

const describe = (texts: string[], fallback: string) => (texts.length > 0 ? texts.join('; ') : fallback);

const judgeRule = (colours: RuleColours, pages: Record<BrandingTheme, Page>): Verdict => {
  const { foregrounds, states, unreadable, hasGradient, foregroundTexts, backgroundTexts } = colours;

  if (unreadable.length > 0) {
    const text = describe(foregroundTexts, `page text ${toHex(pages.light.foreground)}`);
    const background = describe(backgroundTexts, `page background ${toHex(pages.light.background)}`);
    const why = hasGradient ? 'gradients are not checked for contrast' : 'cannot be checked for contrast';

    return { ok: false, reason: `${text} on background ${background}: ${why} (${unreadable.join(', ')})` };
  }

  if (foregrounds.length === 0 && states.length === 0) {
    return { ok: true };
  }

  for (const theme of BRANDING_THEMES) {
    const page = pages[theme];
    const texts =
      foregrounds.length > 0 ? foregrounds : [{ colour: page.foreground, text: `page text ${toHex(page.foreground)}` }];
    const surfaces =
      states.length > 0
        ? states.map((state) => ({ colour: backgroundSurface(state, page.background), text: state.text }))
        : [{ colour: page.background, text: `page background ${toHex(page.background)}` }];

    for (const surface of surfaces) {
      for (const text of texts) {
        const ratio = contrastRatio(compositeColour(text.colour, surface.colour), surface.colour);

        if (ratio < BRANDING_CONTRAST_THRESHOLD) {
          return {
            ok: false,
            reason: `${text.text} on background ${surface.text} has contrast ${formatContrastRatio(ratio)} in the ${theme} theme, below 3:1`,
          };
        }
      }
    }
  }

  return { ok: true };
};

const stripCheckedDeclarations = (rule: Rule) => {
  removeNodes(rule, new Set((rule.nodes ?? []).filter((node) => node.type === 'decl' && isCheckedDeclaration(node))));
};

/**
 * Removes the colour declarations of every stylesheet rule whose text, icon and background
 * colours would be below 3:1, in either theme, and warns for each. A rule's colours are
 * paired with each other; a side the rule does not set is the page's background or text colour
 * from `colors`, or the theme default. A colour the checker cannot read, and any gradient, counts
 * as unreadable. Work is bounded: past the budget, later rules lose their checked colours.
 *
 * Expects CSS already passed through `sanitizeBrandingCss`.
 *
 * @param css sanitised branding CSS
 * @param colors the branding tokens rendered with it
 */
export const checkBrandingCssContrast = (
  css: string,
  colors: TCssVarsSchema | null | undefined,
): SanitizeBrandingCssResult => {
  try {
    return checkContrast(css, colors);
  } catch {
    const reason = 'the stylesheet could not be checked for contrast';

    return { css: '', warnings: [{ kind: 'contrast', detail: reason }], refused: reason };
  }
};

const checkContrast = (css: string, colors: TCssVarsSchema | null | undefined): SanitizeBrandingCssResult => {
  if (trimCssSpace(css) === '') {
    return { css, warnings: [] };
  }

  const tokens = colors ?? {};
  const pages = Object.fromEntries(
    BRANDING_THEMES.map((theme) => [
      theme,
      {
        background: brandingTokenOrDefault(tokens, 'background', theme),
        foreground: brandingTokenOrDefault(tokens, 'foreground', theme),
      },
    ]),
  ) as Record<BrandingTheme, Page>;

  const root = postcss.parse(css);
  const warnings = createWarningList();
  let declarations = 0;
  let comparisons = 0;
  let overBudget = false;

  root.walkRules((rule) => {
    const checked = (rule.nodes ?? []).filter((node) => node.type === 'decl' && isCheckedDeclaration(node)).length;

    if (checked === 0) {
      return;
    }

    declarations += checked;

    const colours = overBudget || declarations > MAX_CHECKED_DECLARATIONS ? null : readRule(rule);
    const work = colours
      ? Math.max(colours.foregrounds.length, 1) * Math.max(colours.states.length, 1) * BRANDING_THEMES.length
      : 0;

    comparisons += work;

    if (!colours || declarations > MAX_CHECKED_DECLARATIONS || comparisons > MAX_COMPARISONS) {
      if (!overBudget) {
        warnings.push({
          kind: 'contrast',
          detail: `rule "${rule.selector}" and later rules: the stylesheet is too large to check for contrast, so their colours were removed`,
          line: rule.source?.start?.line,
        });
      }

      overBudget = true;
      stripCheckedDeclarations(rule);

      return;
    }

    const verdict = judgeRule(colours, pages);

    if (!verdict.ok) {
      warnings.push({
        kind: 'contrast',
        detail: `rule "${rule.selector}": ${verdict.reason}`,
        line: rule.source?.start?.line,
      });
      stripCheckedDeclarations(rule);
    }
  });

  return { css: root.toString(), warnings: finishWarnings(warnings) };
};
