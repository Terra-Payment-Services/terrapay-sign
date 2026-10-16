import type { AtRule, ChildNode, Container, Declaration, Rule } from 'postcss';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { z } from 'zod';

export const ZSanitizeBrandingCssWarningSchema = z.object({
  kind: z.enum(['selector', 'property', 'value', 'at-rule', 'parse-error']),
  detail: z.string(),
  line: z.number().optional(),
});

export type SanitizeBrandingCssWarning = z.infer<typeof ZSanitizeBrandingCssWarningSchema>;

export type SanitizeBrandingCssResult = {
  css: string;
  warnings: SanitizeBrandingCssWarning[];
};

/**
 * The class name the sanitised CSS will be wrapped in at render time using
 * CSS nesting (`.documenso-branded { <user css> }`). The sanitiser itself
 * does NOT prefix selectors — the wrapper is applied by `RecipientBranding`
 * on every render so we keep the user's original CSS intact in the database.
 */
export const SANITIZE_BRANDING_SCOPE_CLASS = 'documenso-branded';

/**
 * The properties branding may set: colours, backgrounds, borders, outlines and fonts. A
 * blocklist cannot keep up with every property that hides, moves or resizes a control
 * (`filter`, `translate`, negative margins, `all`, custom properties the app reads), so
 * anything else is refused.
 */
const ALLOWED_PROPERTIES = new Set([
  'color',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-style',
  'border-width',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'outline',
  'outline-color',
  'outline-style',
  'outline-width',
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

/**
 * A border or outline wide enough could cover the page, so widths are held to a button's
 * scale: at most 16px, or 1em/1rem.
 */
const MAX_WIDTH_BY_UNIT: Record<string, number> = { px: 16, em: 1, rem: 1 };

const BLOCKED_VALUE_SUBSTRINGS = ['url(', 'expression(', '@import', 'javascript:'];

const BLOCKED_PSEUDO_ELEMENTS = new Set([
  '::before',
  '::after',
  '::backdrop',
  '::marker',
  // Single-colon legacy forms.
  ':before',
  ':after',
]);

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
const decodeCssEscapes = (raw: string): string =>
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
 * Validate a selector for the rules we care about, but DO NOT rewrite it.
 * The sanitised output is later wrapped in `.documenso-branded { ... }` via
 * native CSS nesting by `RecipientBranding`, so scoping happens at render.
 */
const validateSelector = (rawSelector: string): SelectorValidationResult => {
  let dropReason: string | null = null;

  const transform = selectorParser((selectors) => {
    selectors.each((selector) => {
      selector.walk((node) => {
        // Pseudo-element check (works at any depth — even nested pseudos like
        // `:is(::before)` should be rejected).
        if (node.type === 'pseudo') {
          const value = decodeCssEscapes(node.value).toLowerCase();

          if (BLOCKED_PSEUDO_ELEMENTS.has(value)) {
            dropReason = `pseudo-element "${value}" not allowed`;
          }
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
 * Why a value is refused, or null. The value is parsed into tokens so a function, a width or
 * a stray `!` is seen however it is spelt.
 */
const findValueProblem = (prop: string, rawValue: string): string | null => {
  const isWidth = (prop.startsWith('border') || prop.startsWith('outline')) && !prop.endsWith('radius');
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

    if (!isWidth || !dimension || dimension.unit === '') {
      return;
    }

    const max = MAX_WIDTH_BY_UNIT[dimension.unit.toLowerCase()];

    if (max === undefined || Math.abs(Number(dimension.number)) > max) {
      problem = `width "${word}" is too large`;
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
  const toRemove: ChildNode[] = [];

  container.each((node) => {
    if (node.type === 'rule') {
      warnings.push({
        kind: 'selector',
        detail: `nested rule "${node.selector}" is not allowed`,
        line: node.source?.start?.line,
      });
      toRemove.push(node);

      return;
    }

    if (node.type === 'atrule') {
      warnings.push({
        kind: 'at-rule',
        detail: `nested at-rule "@${node.name}" is not allowed`,
        line: node.source?.start?.line,
      });
      toRemove.push(node);

      return;
    }

    if (node.type !== 'decl') {
      return;
    }

    const decl = node;
    const propLower = decodeCssEscapes(decl.prop).toLowerCase();

    if (!ALLOWED_PROPERTIES.has(propLower)) {
      warnings.push({
        kind: 'property',
        detail: `property "${decl.prop}" is not allowed`,
        line: decl.source?.start?.line,
      });
      toRemove.push(decl);

      return;
    }

    if (valueIsBlocked(decl.value)) {
      warnings.push({
        kind: 'value',
        detail: `value of "${decl.prop}" contains a disallowed token`,
        line: decl.source?.start?.line,
      });
      toRemove.push(decl);

      return;
    }

    const valueProblem = findValueProblem(propLower, decl.value);

    if (valueProblem !== null) {
      warnings.push({
        kind: 'value',
        detail: `value of "${decl.prop}": ${valueProblem}`,
        line: decl.source?.start?.line,
      });
      toRemove.push(decl);

      return;
    }

    if (decl.important) {
      decl.important = false;
    }
  });

  for (const node of toRemove) {
    node.remove();
  }
};

const sanitizeRule = (rule: Rule, warnings: SanitizeBrandingCssWarning[]): void => {
  const line = rule.source?.start?.line;
  const validation = validateSelector(rule.selector);

  if (validation.kind === 'drop') {
    warnings.push({ kind: 'selector', detail: validation.reason, line });
    rule.remove();

    return;
  }

  // Selector is left as-is. Scoping is applied at render time by wrapping
  // the entire sanitised CSS in `.documenso-branded { ... }` (CSS nesting).

  sanitizeDeclarations(rule, warnings);

  // If the rule has no declarations left, leave the empty rule in place — the
  // output is still valid CSS and the user can see what happened. (Removing
  // it would also be acceptable; we keep it to make warnings easier to map.)
};

/**
 * A declaration outside any rule, at the top level or directly inside `@media`, would apply
 * to the wrapper element itself once the CSS is nested in it, so it is dropped.
 */
const dropStrayDeclaration = (decl: Declaration, warnings: SanitizeBrandingCssWarning[]): void => {
  warnings.push({
    kind: 'property',
    detail: `declaration "${decl.prop}" must be inside a rule`,
    line: decl.source?.start?.line,
  });
  decl.remove();
};

const sanitizeAtRule = (atRule: AtRule, warnings: SanitizeBrandingCssWarning[]): void => {
  const name = atRule.name.toLowerCase();
  const line = atRule.source?.start?.line;

  if (BLOCKED_AT_RULES.has(name)) {
    warnings.push({
      kind: 'at-rule',
      detail: `at-rule "@${atRule.name}" is not allowed`,
      line,
    });
    atRule.remove();

    return;
  }

  if (name !== 'media') {
    warnings.push({
      kind: 'at-rule',
      detail: `at-rule "@${atRule.name}" is not allowed`,
      line,
    });
    atRule.remove();

    return;
  }

  // Recurse into @media children.
  const children = atRule.nodes ? [...atRule.nodes] : [];

  for (const child of children) {
    if (child.type === 'rule') {
      sanitizeRule(child, warnings);
    } else if (child.type === 'atrule') {
      sanitizeAtRule(child, warnings);
    } else if (child.type === 'decl') {
      dropStrayDeclaration(child, warnings);
    }
  }
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

export const sanitizeBrandingCss = (input: string): SanitizeBrandingCssResult => {
  const warnings: SanitizeBrandingCssWarning[] = [];

  if (input.trim() === '') {
    return { css: '', warnings };
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

  // Iterate over a snapshot of top-level children so removal during the loop
  // is safe.
  const topLevelChildren = root.nodes ? [...root.nodes] : [];

  for (const node of topLevelChildren) {
    if (node.type === 'rule') {
      sanitizeRule(node, warnings);
    } else if (node.type === 'atrule') {
      sanitizeAtRule(node, warnings);
    } else if (node.type === 'decl') {
      dropStrayDeclaration(node, warnings);
    }
  }

  const output = root.toString();

  if (STYLE_CLOSE_TAG_REGEX.test(output)) {
    return {
      css: '',
      warnings: [
        ...warnings,
        {
          kind: 'parse-error',
          detail: 'output contained a literal </style sequence and was rejected',
        },
      ],
    };
  }

  return { css: output, warnings };
};
