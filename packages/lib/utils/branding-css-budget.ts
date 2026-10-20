import { MAX_BRANDING_SELECTOR_LENGTH, skipCssEscape, skipCssString } from './branding-css-bounds';
import { MAX_BRANDING_CSS_DEPTH } from './branding-css-depth';

/** Statements: `;` and `{` outside comments and strings, plus every comment. */
export const MAX_BRANDING_CSS_STATEMENTS = 10_000;

/**
 * Characters across every rule and at-rule prelude, the text before a `{`, leaving out comments
 * and rule selectors over the per-selector limit, which are dropped unparsed.
 */
export const MAX_BRANDING_SELECTOR_CHARACTERS = 20_000;

/** Simple selectors across every prelude: each `.`, `#`, `[`, `:` and `*`, and each type name. */
export const MAX_BRANDING_SIMPLE_SELECTORS = 2_000;

const isNameStart = (code: number) =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x2d || code === 0x5f || code >= 0x80;

/** After one of these, a name starts a type selector rather than continuing a class or id. */
const TYPE_POSITION = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x3e, 0x2b, 0x7e, 0x2c, 0x28]);

/** The index just past the comment opening at `index`, or the end of the text. */
const skipComment = (text: string, index: number): number => {
  const close = text.indexOf('*/', index + 2);

  return close === -1 ? text.length : close + 2;
};

type Prelude = { characters: number; simpleSelectors: number; isAtRule: boolean };

/** CSS whitespace, which PostCSS trims from both ends of a selector before it is checked. */
const CSS_SPACES = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c]);

/**
 * Measures one prelude: its characters outside comments and edge whitespace, its simple selectors (skipping comments,
 * strings and escapes, and only ever overstating), and whether it opens an at-rule.
 */
const measurePrelude = (text: string, start: number, end: number): Prelude => {
  let characters = 0;
  let trimmed = 0;
  let count = 0;
  let previous = 0x20;
  let isAtRule: boolean | null = null;
  let index = start;

  while (index < end) {
    const code = text.charCodeAt(index);

    if (code === 0x2f && text.charCodeAt(index + 1) === 0x2a) {
      index = Math.min(skipComment(text, index), end);
      previous = 0x20;
      continue;
    }

    // Leading whitespace is trimmed by PostCSS, so it is not counted.
    if (characters === 0 && CSS_SPACES.has(code)) {
      index++;
      continue;
    }

    if (isAtRule === null && !TYPE_POSITION.has(code)) {
      isAtRule = code === 0x40;
    }

    const next =
      code === 0x22 || code === 0x27
        ? skipCssString(text, index)
        : code === 0x5c
          ? skipCssEscape(text, index)
          : index + 1;

    if (code === 0x2e || code === 0x23 || code === 0x5b || code === 0x3a || code === 0x2a) {
      count++;
    } else if (code !== 0x22 && code !== 0x27 && code !== 0x5c && isNameStart(code) && TYPE_POSITION.has(previous)) {
      count++;
    }

    characters += Math.min(next, end) - index;

    // Only up to the last character that is not whitespace, the length PostCSS checks.
    if (!CSS_SPACES.has(code)) {
      trimmed = characters;
    }

    previous = code;
    index = next;
  }

  return { characters: trimmed, simpleSelectors: count, isAtRule: isAtRule === true };
};

/** What exceeds the budget. Every kind refuses the stylesheet. */
export type BrandingCssBudgetProblem = { kind: 'statements' | 'depth' | 'selectors'; detail: string };

/**
 * Why a stylesheet is too large to parse, or null. One linear pass over the text before postcss
 * builds a tree, whose memory is many times the text's and is paid on every save and on every
 * render-cache miss. Comments and strings are skipped as CSS reads them, and each comment
 * counts as a statement, since postcss gives it a node of its own.
 */
export const findBrandingCssBudgetProblem = (css: string): BrandingCssBudgetProblem | null => {
  let statements = 0;
  let selectorCharacters = 0;
  let simpleSelectors = 0;
  let segmentStart = 0;
  let depth = 0;
  let index = 0;

  while (index < css.length) {
    const code = css.charCodeAt(index);

    if (code === 0x2f && css.charCodeAt(index + 1) === 0x2a) {
      statements++;
      index = skipComment(css, index);
    } else if (code === 0x22 || code === 0x27) {
      index = skipCssString(css, index);
    } else if (code === 0x5c) {
      index = skipCssEscape(css, index);
    } else {
      if (code === 0x7b) {
        statements++;
        depth++;
        const prelude = measurePrelude(css, segmentStart, index);

        // A rule selector over the per-selector limit is dropped before the selector parser sees
        // it, so it costs nothing that the 32 KiB request limit does not already bound.
        if (prelude.isAtRule || prelude.characters <= MAX_BRANDING_SELECTOR_LENGTH) {
          selectorCharacters += prelude.characters;
          simpleSelectors += prelude.simpleSelectors;
        }
      } else if (code === 0x3b) {
        statements++;
      } else if (code === 0x7d && depth > 0) {
        depth--;
      }

      if (code === 0x7b || code === 0x7d || code === 0x3b) {
        segmentStart = index + 1;
      }

      index++;
    }

    // The same bound the parsed tree is held to, found first so it is never reported as selectors.
    if (depth > MAX_BRANDING_CSS_DEPTH) {
      return { kind: 'depth', detail: `the stylesheet nests rules more than ${MAX_BRANDING_CSS_DEPTH} levels deep` };
    }

    if (statements > MAX_BRANDING_CSS_STATEMENTS) {
      const limit = MAX_BRANDING_CSS_STATEMENTS.toLocaleString('en');

      return { kind: 'statements', detail: `the stylesheet has more than ${limit} statements and comments` };
    }

    if (selectorCharacters > MAX_BRANDING_SELECTOR_CHARACTERS) {
      const limit = MAX_BRANDING_SELECTOR_CHARACTERS.toLocaleString('en');

      return { kind: 'selectors', detail: `the stylesheet's selectors total more than ${limit} characters` };
    }

    if (simpleSelectors > MAX_BRANDING_SIMPLE_SELECTORS) {
      const limit = MAX_BRANDING_SIMPLE_SELECTORS.toLocaleString('en');

      return { kind: 'selectors', detail: `the stylesheet has more than ${limit} simple selectors` };
    }
  }

  return null;
};
