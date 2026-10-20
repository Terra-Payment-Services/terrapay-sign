import type { AtRule, ChildNode, Container, Declaration, Rule } from 'postcss';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { z } from 'zod';

import { BRANDING_CSS_MAX_LENGTH, BRANDING_CSS_TOO_LONG } from '../constants/branding';

import { findSeeThroughBackground } from './branding-background';
import { createWarningList, findSelectorComplexityProblem, finishWarnings, removeNodes } from './branding-css-bounds';
import { findBrandingCssBudgetProblem } from './branding-css-budget';
import { exceedsBrandingCssDepth, MAX_BRANDING_CSS_DEPTH } from './branding-css-depth';
import { asciiLowerCase } from './parse-css-colour';

export const ZSanitizeBrandingCssWarningSchema = z.object({
  kind: z.enum(['selector', 'property', 'value', 'at-rule', 'parse-error', 'contrast']),
  detail: z.string(),
  line: z.number().optional(),
});

export type SanitizeBrandingCssWarning = z.infer<typeof ZSanitizeBrandingCssWarningSchema>;

export type SanitizeBrandingCssResult = {
  css: string;
  warnings: SanitizeBrandingCssWarning[];
  /** Set when the whole stylesheet is refused; a save answers 4xx with it and a page drops the CSS. */
  refused?: string;
};

/**
 * The class name the sanitised CSS will be wrapped in at render time using
 * CSS nesting (`.documenso-branded.documenso-branded.documenso-branded { <user css> }`,
 * the class repeated for specificity). The sanitiser itself
 * does NOT prefix selectors — the wrapper is applied by `RecipientBranding`
 * on every render so we keep the user's original CSS intact in the database.
 */
export const SANITIZE_BRANDING_SCOPE_CLASS = 'documenso-branded';

/**
 * The properties branding may set: colours, backgrounds, border and outline colours, and fonts. A
 * blocklist cannot keep up with every property that hides, moves or resizes a control
 * (`filter`, `translate`, negative margins, `all`, custom properties the app reads), so
 * anything else is refused. The radius properties are refused too (round 17): a corner
 * clips the element's background, which shows app paint behind it that the guard does not read.
 * Border and outline shorthands, styles and widths are refused (round 19): nested borders
 * add up and can erase an icon, so a tenant recolours a border the app draws and cannot create,
 * widen or restyle one.
 */
const ALLOWED_PROPERTIES = new Set([
  'color',
  'background',
  'background-color',
  'background-image',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'font-family',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-transform',
  'fill',
  'stroke',
  'accent-color',
  'caret-color',
]);

/**
 * Functions a value may call: colours and gradients. `url()`, `image-set()`, `src()`,
 * `var()` and the rest are refused.
 */
const ALLOWED_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
]);

const BLOCKED_VALUE_SUBSTRINGS = ['url(', 'expression(', '@import', 'javascript:'];

const BLOCKED_AT_RULES = new Set([
  'import',
  'font-face',
  'keyframes',
  'charset',
  'namespace',
  'supports',
  'page',
  'document',
  'viewport',
]);

/**
 * Decode CSS escapes (`\\75` or `\\000075 ` for `u`, `\\i` for `i`) so a property or value is
 * checked as the browser reads it.
 */
export const decodeCssEscapes = (raw: string): string =>
  raw.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f]))/g, (_match, hex?: string, char?: string) => {
    if (hex === undefined) {
      return char ?? '';
    }

    const codePoint = parseInt(hex, 16);

    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return '\uFFFD';
    }

    return String.fromCodePoint(codePoint);
  });

type SelectorValidationResult = { kind: 'ok' } | { kind: 'drop'; reason: string };

/**
 * The characters a selector may contain (round 14). Escapes, functional forms, comments,
 * namespaces and non-ASCII are all refused on the raw text, before any parser reads it, so the
 * server never has to agree with the browser about how they decode.
 */
const SELECTOR_CHARACTERS = /^[A-Za-z0-9 \t\n\r\-_.#[\]=~^$*"',>+:]*$/;

/**
 * Why a selector's raw text is refused, or null. Once every `::placeholder` is removed no colon may
 * remain, so no selector names an interaction or structural state the signing-page guard would
 * have to watch; a colon inside a quoted attribute value (`[href^="https:"]`) is refused too.
 */
const findSelectorTextProblem = (raw: string): string | null => {
  if (!SELECTOR_CHARACTERS.test(raw)) {
    return 'selector contains a character that is not allowed';
  }

  if (raw.replace(/::placeholder/gi, '').includes(':')) {
    return 'pseudo-classes and pseudo-elements other than "::placeholder" are not allowed';
  }

  return null;
};

/**
 * Validate a selector for the rules we care about, but DO NOT rewrite it.
 * The sanitised output is later wrapped in the repeated `.documenso-branded` class via
 * native CSS nesting by `RecipientBranding`, so scoping happens at render.
 */
const validateSelector = (rawSelector: string, rawText: string): SelectorValidationResult => {
  const textProblem = findSelectorTextProblem(rawText);

  if (textProblem !== null) {
    return { kind: 'drop', reason: textProblem };
  }

  const complexity = findSelectorComplexityProblem(rawSelector);

  if (complexity !== null) {
    return { kind: 'drop', reason: complexity };
  }

  let dropReason: string | null = null;

  const transform = selectorParser((selectors) => {
    selectors.each((selector) => {
      selector.walk((node) => {
        // The text check leaves `::placeholder` as the only possible pseudo, but `::placeholderx`
        // passes it, so the parsed name must be exactly that (round 14).
        if (node.type === 'pseudo' && asciiLowerCase(node.value) !== '::placeholder') {
          dropReason = `pseudo-element "${node.value}" not allowed`;
        }

        // `&` names the wrapper itself, and `html:has(&)` reaches outside it.
        if (node.type === 'nesting') {
          dropReason = 'nesting selector "&" not allowed';
        }
      });

      if (dropReason !== null) {
        return;
      }

      // Universal selector check — only when it is a direct child of the
      // top-level compound (i.e. `* { ... }` or `* .foo { ... }`).
      // Universal nodes nested inside attribute selectors (`[class*="x"]`)
      // are a different node type and won't appear here.
      selector.each((node) => {
        if (node.type === 'universal') {
          dropReason = 'universal "*" selector not allowed';
        }
      });
    });
  });

  try {
    // We don't keep the result — we only care about parsing and walking
    // to populate dropReason.
    transform.processSync(rawSelector);
  } catch (error) {
    return {
      kind: 'drop',
      reason: error instanceof Error ? error.message : 'failed to parse selector',
    };
  }

  if (dropReason !== null) {
    return { kind: 'drop', reason: dropReason };
  }

  return { kind: 'ok' };
};

/**
 * The font families a tenant may name (round 19), lowercase. Any other family, a symbol font
 * such as Wingdings included, could turn a label into pictures on a device that has it.
 */
const ALLOWED_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'arial',
  'helvetica',
  'helvetica neue',
  'verdana',
  'tahoma',
  'trebuchet ms',
  'segoe ui',
  'roboto',
  'inter',
  'open sans',
  'lato',
  'georgia',
  'times new roman',
  'times',
  'garamond',
  'palatino',
  'courier new',
  'courier',
  'consolas',
  'menlo',
  'monaco',
]);

/** A lone CSS-wide keyword resolves to the app's font or a parent's, so it is kept. */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/**
 * Why a `font-family` value is refused, or null: every family, compared without letter case, must
 * be on `ALLOWED_FONT_FAMILIES`, unless the value is one unquoted CSS-wide keyword. Any backslash
 * refuses the value (round 20), since an escape can join or rename families in ways a split
 * after decoding does not see; families are split at top-level commas on the raw text, and a
 * quoted string is always a family name, so `"inherit"` names a font and is refused.
 *
 * @param value the declared value as written
 */
const findFontFamilyProblem = (value: string): string | null => {
  if (value.includes('\\')) {
    return 'a backslash is not allowed in a font family';
  }

  const families: valueParser.Node[][] = [[]];

  for (const node of valueParser(value).nodes) {
    if (node.type === 'div' && node.value === ',') {
      families.push([]);
    } else if (node.type === 'word' || node.type === 'string') {
      families[families.length - 1].push(node);
    }
  }

  const names = families.map((nodes) => asciiLowerCase(nodes.map((node) => node.value).join(' ')));
  const isLoneKeyword = families.length === 1 && families[0].length === 1 && families[0][0].type === 'word';

  if (isLoneKeyword && CSS_WIDE_KEYWORDS.has(names[0])) {
    return null;
  }

  const refused = names.find((name) => !ALLOWED_FONT_FAMILIES.has(name));

  return refused === undefined ? null : `font family "${refused}" is not allowed`;
};

/**
 * Why a value is refused, or null. The value is parsed into tokens so a function or a stray `!`
 * is seen however it is spelt.
 */
const findValueProblem = (prop: string, rawValue: string): string | null => {
  let problem: string | null = null;

  valueParser(rawValue).walk((node) => {
    if (problem !== null) {
      return;
    }

    if (node.type === 'function') {
      const name = decodeCssEscapes(node.value).toLowerCase();

      // An escaped name parses apart from its parentheses, leaving a function with no name.
      if (!ALLOWED_FUNCTIONS.has(name)) {
        problem = name === '' ? 'a bare parenthesised group is not allowed' : `function "${name}()" is not allowed`;
      }

      return;
    }

    if (node.type === 'comment' || (node.type === 'string' && prop !== 'font-family')) {
      problem = `${node.type} is not allowed here`;

      return;
    }

    if (node.type !== 'word') {
      return;
    }

    const word = decodeCssEscapes(node.value);

    if (word.includes('!')) {
      problem = '"!" is not allowed';

      return;
    }

    const dimension = valueParser.unit(word);

    // The shorthand's only length is the line's thickness, which can paint over a label.
    if (prop === 'text-decoration' && dimension && dimension.unit !== '') {
      problem = `thickness "${word}" is not allowed`;

      return;
    }
  });

  return problem;
};

const valueIsBlocked = (rawValue: string): boolean => {
  const lowered = decodeCssEscapes(rawValue).toLowerCase();

  // An escaped `!important` stays in the value, where postcss does not see it.
  if (/!\s*important/.test(lowered)) {
    return true;
  }

  return BLOCKED_VALUE_SUBSTRINGS.some((needle) => lowered.includes(needle));
};

/**
 * Check every child of a rule. Declarations are filtered; nested rules and at-rules are
 * dropped, since CSS nesting would otherwise carry declarations past this check.
 */
const sanitizeDeclarations = (container: Container, warnings: SanitizeBrandingCssWarning[]): void => {
  const toRemove = new Set<ChildNode>();

  container.each((node) => {
    if (node.type === 'rule') {
      warnings.push({
        kind: 'selector',
        detail: `nested rule "${node.selector}" is not allowed`,
        line: node.source?.start?.line,
      });
      toRemove.add(node);

      return;
    }

    if (node.type === 'atrule') {
      warnings.push({
        kind: 'at-rule',
        detail: `nested at-rule "@${node.name}" is not allowed`,
        line: node.source?.start?.line,
      });
      toRemove.add(node);

      return;
    }

    if (node.type !== 'decl') {
      return;
    }

    const decl = node;

    if (!isWrittenAsParsed(decl)) {
      warnings.push({
        kind: 'property',
        detail: `property "${(decl.raws.before ?? '').trim()}${decl.prop}" is written in a form the browser ignores`,
        line: decl.source?.start?.line,
      });
      toRemove.add(decl);

      return;
    }

    const propLower = decodeCssEscapes(decl.prop).toLowerCase();

    if (!ALLOWED_PROPERTIES.has(propLower)) {
      warnings.push({
        kind: 'property',
        detail: `property "${decl.prop}" is not allowed`,
        line: decl.source?.start?.line,
      });
      toRemove.add(decl);

      return;
    }

    if (valueIsBlocked(decl.value)) {
      warnings.push({
        kind: 'value',
        detail: `value of "${decl.prop}" contains a disallowed token`,
        line: decl.source?.start?.line,
      });
      toRemove.add(decl);

      return;
    }

    const valueProblem = findValueProblem(propLower, decl.value);

    if (valueProblem !== null) {
      warnings.push({
        kind: 'value',
        detail: `value of "${decl.prop}": ${valueProblem}`,
        line: decl.source?.start?.line,
      });
      toRemove.add(decl);

      return;
    }

    const fontProblem = propLower === 'font-family' ? findFontFamilyProblem(decl.value) : null;

    if (fontProblem !== null) {
      warnings.push({
        kind: 'value',
        detail: `value of "${decl.prop}": ${fontProblem}`,
        line: decl.source?.start?.line,
      });
      toRemove.add(decl);

      return;
    }

    const seeThrough = findSeeThroughBackground(propLower, decodeCssEscapes(decl.value));

    if (seeThrough !== null) {
      warnings.push({
        kind: 'value',
        detail: `value of "${decl.prop}": ${seeThrough}`,
        line: decl.source?.start?.line,
      });
      toRemove.add(decl);

      return;
    }

    if (decl.important) {
      decl.important = false;
    }
  });

  removeNodes(container, toRemove);
};

/**
 * PostCSS keeps a legacy hack such as `*background` or `_background` in `raws.before` and reports
 * the property as `background`, which the browser ignores as written. A declaration is kept
 * only if nothing but CSS whitespace precedes the property and nothing but a colon, comments and
 * CSS whitespace separates it from the value.
 */
const isWrittenAsParsed = (decl: Declaration): boolean => {
  const before = decl.raws.before ?? '';
  const between = (decl.raws.between ?? ':').replace(/\/\*[\s\S]*?\*\//g, '');

  return /^[ \t\n\r\f]*$/.test(before) && /^[ \t\n\r\f]*:[ \t\n\r\f]*$/.test(between);
};

/** @returns true when the rule must be removed; the caller removes it with its siblings. */
const sanitizeRule = (rule: Rule, warnings: SanitizeBrandingCssWarning[]): boolean => {
  const line = rule.source?.start?.line;
  // `rule.selector` has comments removed; the character check reads the selector as stored, with
  // what postcss keeps between it and its `{` (round 15).
  const rawText = (rule.raws.selector?.raw ?? rule.selector) + (rule.raws.between ?? '');
  const validation = validateSelector(rule.selector, rawText);

  if (validation.kind === 'drop') {
    warnings.push({ kind: 'selector', detail: validation.reason, line });

    return true;
  }

  // Selector is left as-is. Scoping is applied at render time by wrapping
  // the entire sanitised CSS in the repeated `.documenso-branded` class (CSS nesting).

  sanitizeDeclarations(rule, warnings);

  // If the rule has no declarations left, leave the empty rule in place — the
  // output is still valid CSS and the user can see what happened. (Removing
  // it would also be acceptable; we keep it to make warnings easier to map.)
  return false;
};

/**
 * A declaration outside any rule, at the top level or directly inside `@media`, would apply
 * to the wrapper element itself once the CSS is nested in it, so it is dropped.
 */
const warnStrayDeclaration = (decl: Declaration, warnings: SanitizeBrandingCssWarning[]): void => {
  warnings.push({
    kind: 'property',
    detail: `declaration "${decl.prop}" must be inside a rule`,
    line: decl.source?.start?.line,
  });
};

/** Sanitises the children of the root or of an `@media`, removing the refused ones in one pass. */
const sanitizeChildren = (container: Container, warnings: SanitizeBrandingCssWarning[]): void => {
  const drop = new Set<ChildNode>();

  for (const child of container.nodes ?? []) {
    if (child.type === 'rule' && sanitizeRule(child, warnings)) {
      drop.add(child);
    } else if (child.type === 'atrule' && sanitizeAtRule(child, warnings)) {
      drop.add(child);
    } else if (child.type === 'decl') {
      warnStrayDeclaration(child, warnings);
      drop.add(child);
    }
  }

  removeNodes(container, drop);
};

/** @returns true when the at-rule must be removed; the caller removes it with its siblings. */
const sanitizeAtRule = (atRule: AtRule, warnings: SanitizeBrandingCssWarning[]): boolean => {
  const name = atRule.name.toLowerCase();
  const line = atRule.source?.start?.line;

  if (BLOCKED_AT_RULES.has(name)) {
    warnings.push({
      kind: 'at-rule',
      detail: `at-rule "@${atRule.name}" is not allowed`,
      line,
    });

    return true;
  }

  if (name !== 'media') {
    warnings.push({
      kind: 'at-rule',
      detail: `at-rule "@${atRule.name}" is not allowed`,
      line,
    });

    return true;
  }

  // Recurse into @media children.
  sanitizeChildren(atRule, warnings);

  return false;
};

/**
 * Defence in depth against `<style>` element breakout.
 *
 * The sanitised CSS is inlined into a `<style>` element via SSR
 * `dangerouslySetInnerHTML`. The browser's HTML parser (in RAWTEXT mode for
 * `<style>` content) terminates the element on a literal `</style` —
 * regardless of whether it appears inside a CSS string, comment, or at-rule
 * params. PostCSS's serializer escapes `<` to `\3c` whenever it would form
 * `</...`, which means a normal round-trip is already safe.
 *
 * That escape is implicit in PostCSS, not enforced by our own logic. If a
 * future PostCSS version, plugin, or alternative serializer regresses, we
 * still want the output to be safe to inline. This regex is the explicit
 * tripwire — case-insensitive `</style` anywhere in the final output is a
 * hard fail.
 */
const STYLE_CLOSE_TAG_REGEX = /<\s*\/\s*style/i;

/**
 * Control characters other than tab, LF, CR and FF are not CSS whitespace, but the value parser
 * splits on them, so a declaration the browser rejects could read as valid. Postgres also
 * refuses U+0000 in text columns. Any of them refuses the whole stylesheet before parsing.
 */
const findControlCharacter = (input: string): number | null => {
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    const isCssWhitespace = code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;

    if ((code < 0x20 && !isCssWhitespace) || code === 0x7f) {
      return code;
    }
  }

  return null;
};

const refuseStylesheet = (reason: string): SanitizeBrandingCssResult => ({
  css: '',
  warnings: [{ kind: 'parse-error', detail: reason }],
  refused: reason,
});

/**
 * Sanitises branding CSS. Any unexpected failure refuses the stylesheet rather than reaching the
 * caller, so neither a save nor a signing page can fail on it.
 */
export const sanitizeBrandingCss = (input: string): SanitizeBrandingCssResult => {
  try {
    return sanitize(input);
  } catch {
    return refuseStylesheet('the stylesheet could not be processed');
  }
};

const sanitize = (input: string): SanitizeBrandingCssResult => {
  const warnings = createWarningList();

  // The request limit, applied again so a row stored before it was lowered renders without CSS.
  if (input.length > BRANDING_CSS_MAX_LENGTH) {
    return refuseStylesheet(BRANDING_CSS_TOO_LONG);
  }

  // Before the empty check, which `trim()` would pass for a stylesheet of only U+000B.
  const control = findControlCharacter(input);

  if (control !== null) {
    const code = control.toString(16).toUpperCase().padStart(4, '0');

    return refuseStylesheet(`the stylesheet contains the control character U+${code}, which is not allowed`);
  }

  if (input.trim() === '') {
    return { css: '', warnings: [] };
  }

  const budgetProblem = findBrandingCssBudgetProblem(input);

  if (budgetProblem !== null) {
    return refuseStylesheet(budgetProblem.detail);
  }

  let root;

  try {
    root = postcss.parse(input);
  } catch (error) {
    return {
      css: '',
      warnings: [
        {
          kind: 'parse-error',
          detail: error instanceof Error ? error.message : 'failed to parse CSS',
        },
      ],
    };
  }

  if (exceedsBrandingCssDepth(root)) {
    return refuseStylesheet(`the stylesheet nests rules more than ${MAX_BRANDING_CSS_DEPTH} levels deep`);
  }

  sanitizeChildren(root, warnings);

  const output = root.toString();

  if (STYLE_CLOSE_TAG_REGEX.test(output)) {
    return {
      css: '',
      warnings: [
        ...finishWarnings(warnings),
        {
          kind: 'parse-error',
          detail: 'output contained a literal </style sequence and was rejected',
        },
      ],
    };
  }

  return { css: output, warnings: finishWarnings(warnings) };
};
