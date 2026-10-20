import type { ChildNode, Container } from 'postcss';

import type { SanitizeBrandingCssWarning } from './sanitize-branding-css';

/**
 * Removes `drop` from `container` in one pass. `node.remove()` searches and splices the parent's
 * array for each node, so removing thousands one at a time is quadratic.
 *
 * @param container the rule, at-rule or root holding the nodes
 * @param drop the children to remove
 */
export const removeNodes = (container: Container, drop: Set<ChildNode>): void => {
  if (drop.size === 0) {
    return;
  }

  const kept = (container.nodes ?? []).filter((node) => !drop.has(node));

  container.removeAll();
  container.append(kept);
};

/** The most warnings one check returns; past it, one line counts the rest. */
export const MAX_BRANDING_CSS_WARNINGS = 500;

export type WarningList = SanitizeBrandingCssWarning[] & { omitted: number };

/** A warning list whose `push` keeps the first MAX_BRANDING_CSS_WARNINGS and counts the rest. */
export const createWarningList = (): WarningList => {
  const list: WarningList = Object.assign([] as SanitizeBrandingCssWarning[], { omitted: 0 });

  list.push = (...items: SanitizeBrandingCssWarning[]) => {
    for (const item of items) {
      if (list.length < MAX_BRANDING_CSS_WARNINGS) {
        Array.prototype.push.call(list, item);
      } else {
        list.omitted++;
      }
    }

    return list.length;
  };

  return list;
};

/** The kept warnings as a plain array, with one closing line when any were left out. */
export const finishWarnings = (list: WarningList): SanitizeBrandingCssWarning[] => {
  const kept = [...list];

  if (list.omitted === 0) {
    return kept;
  }

  return [...kept, { kind: kept[kept.length - 1].kind, detail: `and ${list.omitted} more warnings not shown` }];
};

/** The longest selector, and the most compound selectors in one, that branding may use. */
export const MAX_BRANDING_SELECTOR_LENGTH = 1_000;
export const MAX_BRANDING_SELECTOR_PARTS = 50;

/** CSS whitespace and the `>`, `+`, `~` and `,` that separate compound selectors. */
const SELECTOR_SEPARATORS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x3e, 0x2b, 0x7e, 0x2c]);

const isHexDigit = (code: number) =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);

const isCssSpaceCode = (code: number) =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;

/**
 * The index just past the CSS escape that starts at `index` (a backslash): up to six hex digits
 * and one optional whitespace character, or else the one character after the backslash.
 */
export const skipCssEscape = (text: string, index: number): number => {
  let next = index + 1;

  if (next < text.length && isHexDigit(text.charCodeAt(next))) {
    const limit = Math.min(text.length, next + 6);

    while (next < limit && isHexDigit(text.charCodeAt(next))) {
      next++;
    }

    return next < text.length && isCssSpaceCode(text.charCodeAt(next)) ? next + 1 : next;
  }

  return Math.min(text.length, next + 1);
};

/** The index just past the string whose opening quote is at `index`, or the end of the text. */
export const skipCssString = (text: string, index: number): number => {
  const quote = text.charCodeAt(index);
  let next = index + 1;

  while (next < text.length) {
    const code = text.charCodeAt(next);

    if (code === 0x5c) {
      next = skipCssEscape(text, next);
    } else if (code === quote || code === 0x0a) {
      return next + 1;
    } else {
      next++;
    }
  }

  return next;
};

/**
 * Counts the compound selectors in a selector list in one pass, as CSS reads them: the contents
 * of `()` and `[]`, quoted strings and escaped characters belong to the compound around them, so
 * an `nth-child(2n + 1)` formula, an attribute string or `.a\+b` adds nothing.
 */
const countCompounds = (selector: string): number => {
  let compounds = 0;
  let depth = 0;
  let inCompound = false;
  let index = 0;

  while (index < selector.length) {
    const code = selector.charCodeAt(index);
    const isSeparator = depth === 0 && SELECTOR_SEPARATORS.has(code);

    if (isSeparator) {
      inCompound = false;
      index++;
      continue;
    }

    if (!inCompound) {
      compounds++;
      inCompound = true;
    }

    if (code === 0x5c) {
      index = skipCssEscape(selector, index);
    } else if (code === 0x22 || code === 0x27) {
      index = skipCssString(selector, index);
    } else {
      if (code === 0x28 || code === 0x5b) {
        depth++;
      } else if ((code === 0x29 || code === 0x5d) && depth > 0) {
        depth--;
      }

      index++;
    }
  }

  return compounds;
};

/**
 * Why a selector is too complex to parse, or null. Checked by length and a CSS-aware count of
 * compound selectors before the selector parser builds a tree, which costs far more memory than
 * the text. Arguments of `:is()`, `:not()` and similar do not count toward the compounds; the
 * stylesheet's simple-selector budget bounds them.
 */
export const findSelectorComplexityProblem = (selector: string): string | null => {
  if (selector.length > MAX_BRANDING_SELECTOR_LENGTH) {
    return `selector of ${selector.length} characters is over the ${MAX_BRANDING_SELECTOR_LENGTH.toLocaleString('en')}-character limit`;
  }

  return countCompounds(selector) > MAX_BRANDING_SELECTOR_PARTS
    ? `selector has more than ${MAX_BRANDING_SELECTOR_PARTS} compound selectors`
    : null;
};
