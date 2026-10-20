import { describe, expect, it } from 'vitest';

import { renderStoredBrandingCss } from '../server-only/branding/branding-css-cache';
import { decodeCssEscapes, sanitizeBrandingCss } from './sanitize-branding-css';

const normalize = (css: string) => css.replace(/\s+/g, ' ').trim();

/**
 * The sanitiser does NOT scope selectors. Scoping is applied at render time
 * by wrapping the entire sanitised output in `.documenso-branded { ... }` via
 * native CSS nesting (see `RecipientBranding`). These tests assert that
 * selectors are preserved verbatim and only validated.
 */
describe('sanitizeBrandingCss', () => {
  describe('empty input', () => {
    it('returns empty output for an empty string', () => {
      const result = sanitizeBrandingCss('');

      expect(result.css).toBe('');
      expect(result.warnings).toEqual([]);
    });

    it('returns empty output for whitespace-only input', () => {
      const result = sanitizeBrandingCss('   \n\t  \n');

      expect(result.css).toBe('');
      expect(result.warnings).toEqual([]);
    });
  });

  describe('selector preservation', () => {
    it('preserves a bare class selector', () => {
      const result = sanitizeBrandingCss('.foo { color: red; }');

      expect(normalize(result.css)).toBe('.foo { color: red; }');
      expect(result.warnings).toEqual([]);
    });

    it('preserves a tag selector', () => {
      const result = sanitizeBrandingCss('h1 { color: red; }');

      expect(normalize(result.css)).toBe('h1 { color: red; }');
      expect(result.warnings).toEqual([]);
    });

    it('preserves combinators', () => {
      const result = sanitizeBrandingCss('.a > .b + .c ~ .d { color: red; }');

      expect(normalize(result.css)).toBe('.a > .b + .c ~ .d { color: red; }');
      expect(result.warnings).toEqual([]);
    });

    it('preserves comma-separated selectors', () => {
      const result = sanitizeBrandingCss('.a, .b { color: red; }');

      expect(normalize(result.css)).toBe('.a, .b { color: red; }');
      expect(result.warnings).toEqual([]);
    });

    it('preserves body/html/:root verbatim (will no-op once nested at render)', () => {
      const result = sanitizeBrandingCss('body { background: black; }');

      // Selector is left as-is. At render time this becomes
      // `.documenso-branded body { ... }`, which won't match anything since
      // <body> is an ancestor of the wrapper. Documented tradeoff.
      expect(normalize(result.css)).toBe('body { background: black; }');
      expect(result.warnings).toEqual([]);
    });
  });

  describe('pseudo-elements', () => {
    it('drops a rule containing ::before', () => {
      const result = sanitizeBrandingCss(".foo::before { content: 'x'; }");

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('selector');
    });

    it('drops a rule containing ::after', () => {
      const result = sanitizeBrandingCss(".foo::after { content: 'x'; }");

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
    });

    it('drops a rule containing ::backdrop', () => {
      const result = sanitizeBrandingCss('.foo::backdrop { color: red; }');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
    });

    it('drops a rule containing ::marker', () => {
      const result = sanitizeBrandingCss('li::marker { color: red; }');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
    });

    it('drops a rule using legacy single-colon :before', () => {
      const result = sanitizeBrandingCss(".foo:before { content: 'x'; }");

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('selector');
    });

    it('drops a rule using legacy single-colon :after', () => {
      const result = sanitizeBrandingCss(".foo:after { content: 'x'; }");

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
    });

    it('keeps ::placeholder verbatim', () => {
      const result = sanitizeBrandingCss('input::placeholder { color: gray; }');

      expect(normalize(result.css)).toBe('input::placeholder { color: gray; }');
      expect(result.warnings).toEqual([]);
    });

    it('drops ::selection (round 13 allowlist, C80)', () => {
      const result = sanitizeBrandingCss('p::selection { background: yellow; }');

      expect(normalize(result.css)).not.toContain('::selection');
      expect(result.warnings.filter((warning) => warning.kind === 'selector')).toHaveLength(1);
    });
  });

  describe('universal selector', () => {
    it('drops a bare * selector rule', () => {
      const result = sanitizeBrandingCss('* { color: red; }');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('selector');
    });

    it('drops a rule with * combined with descendant', () => {
      const result = sanitizeBrandingCss('* .x { color: red; }');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
    });

    it('keeps attribute selectors that include * inside', () => {
      const result = sanitizeBrandingCss('[class*="foo"] { color: red; }');

      expect(normalize(result.css)).toBe('[class*="foo"] { color: red; }');
      expect(result.warnings).toEqual([]);
    });
  });

  describe('blocked properties', () => {
    const blockedProperties = [
      'display',
      'visibility',
      'opacity',
      'pointer-events',
      'position',
      'inset',
      'top',
      'right',
      'bottom',
      'left',
      'z-index',
      'transform',
      'clip',
      'clip-path',
      'mask',
      'mask-image',
      'content',
      'width',
      'height',
      'min-width',
      'min-height',
      'max-width',
      'max-height',
      'overflow',
      'overflow-x',
      'overflow-y',
      'font-size',
      'letter-spacing',
      'word-spacing',
      'line-height',
      'text-indent',
    ];

    for (const prop of blockedProperties) {
      it(`strips the "${prop}" property`, () => {
        const result = sanitizeBrandingCss(`.x { ${prop}: 10px; color: red; }`);

        expect(result.css).not.toContain(`${prop}:`);
        expect(result.css).toContain('color: red');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].kind).toBe('property');
        expect(result.warnings[0].detail).toContain(prop);
      });
    }

    it('is case-insensitive on property names', () => {
      const result = sanitizeBrandingCss('.x { DISPLAY: none; color: red; }');

      expect(result.css).not.toMatch(/display/i);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('property');
    });

    const allowedProperties: Array<[string, string]> = [
      ['color', 'red'],
      ['background', '#fff'],
      // Round 19 (C110): border shorthands left the allowlist; see the round 19 block.
      ['border-color', 'black'],
      // Round 17 (C102): border-radius left the allowlist; its drop is asserted in the round 17 block.
      ['font-family', 'sans-serif'],
      ['font-weight', '600'],
    ];

    for (const [prop, value] of allowedProperties) {
      it(`keeps the "${prop}" property`, () => {
        const result = sanitizeBrandingCss(`.x { ${prop}: ${value}; }`);

        expect(result.css).toContain(`${prop}: ${value}`);
        expect(result.warnings).toEqual([]);
      });
    }
  });

  describe('blocked values', () => {
    it('drops a declaration containing url(', () => {
      const result = sanitizeBrandingCss('.x { background: url(http://evil); }');

      expect(result.css).not.toContain('url(');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('value');
    });

    it('drops a declaration containing expression(', () => {
      const result = sanitizeBrandingCss('.x { background: expression(alert(1)); }');

      expect(result.css).not.toContain('expression(');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('value');
    });

    it('drops a declaration containing javascript: in a quoted value', () => {
      // PostCSS would throw on bare `javascript:alert(1)` (looks like a
      // malformed selector inside a declaration). Use a quoted value to
      // exercise the substring match cleanly.
      const result = sanitizeBrandingCss('.x { font-family: "javascript:alert"; }');

      expect(result.css).not.toContain('javascript:');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('value');
    });
  });

  describe('!important stripping', () => {
    it('strips !important from a retained declaration', () => {
      const result = sanitizeBrandingCss('.x { color: red !important; }');

      expect(result.css).not.toContain('!important');
      expect(result.css).toContain('color: red');
      expect(result.warnings).toEqual([]);
    });
  });

  describe('at-rules', () => {
    it('drops @import', () => {
      const result = sanitizeBrandingCss('@import url("https://evil.example/x.css");');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('at-rule');
    });

    it('drops @font-face', () => {
      const result = sanitizeBrandingCss('@font-face { font-family: "X"; src: url("x.woff2"); }');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('at-rule');
    });

    it('drops @keyframes', () => {
      const result = sanitizeBrandingCss('@keyframes spin { to { transform: rotate(360deg); } }');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('at-rule');
    });

    it('drops @supports', () => {
      const result = sanitizeBrandingCss('@supports (display: grid) { .x { color: red; } }');

      expect(result.css.trim()).toBe('');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('at-rule');
    });

    it('keeps @media with min-width and preserves inner selectors verbatim', () => {
      const result = sanitizeBrandingCss('@media (min-width: 600px) { .x { color: red; } }');

      expect(normalize(result.css)).toBe('@media (min-width: 600px) { .x { color: red; } }');
      expect(result.warnings).toEqual([]);
    });

    it('keeps @media with prefers-color-scheme and preserves body inside', () => {
      const result = sanitizeBrandingCss('@media (prefers-color-scheme: dark) { body { background: black; } }');

      expect(normalize(result.css)).toBe('@media (prefers-color-scheme: dark) { body { background: black; } }');
      expect(result.warnings).toEqual([]);
    });

    it('strips blocked properties inside @media', () => {
      const result = sanitizeBrandingCss('@media (min-width: 600px) { .x { display: none; color: red; } }');

      expect(result.css).not.toContain('display');
      expect(result.css).toContain('color: red');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('property');
    });
  });

  describe('combined input', () => {
    it('keeps valid rules verbatim and reports each drop', () => {
      const input = `
        .ok { color: red !important; }
        .bad-prop { display: none; background: blue; }
        .bad-pseudo::before { content: 'x'; }
        * { color: red; }
        @import "evil.css";
        body { background: black; }
        @media (min-width: 600px) {
          .responsive { color: green; }
        }
      `;

      const result = sanitizeBrandingCss(input);

      // Valid bits present, unchanged.
      expect(result.css).toContain('.ok');
      expect(result.css).toContain('color: red');
      expect(result.css).toContain('.bad-prop');
      expect(result.css).toContain('background: blue');
      expect(result.css).toContain('body { background: black');
      expect(result.css).toContain('@media (min-width: 600px)');
      expect(result.css).toContain('.responsive');

      // Invalid bits gone.
      expect(result.css).not.toContain('!important');
      expect(result.css).not.toContain('display');
      expect(result.css).not.toContain('::before');
      expect(result.css).not.toContain('@import');

      // Warning kinds.
      const kinds = result.warnings.map((w) => w.kind).sort();
      expect(kinds).toEqual(['at-rule', 'property', 'selector', 'selector'].sort());
    });
  });

  describe('style-close-tag defence', () => {
    // The sanitised output is inlined into a `<style>` element via SSR. The
    // browser's HTML parser terminates the element on a literal `</style`
    // anywhere in the content. PostCSS's serializer normally escapes `<` to
    // `\3c` whenever it would form `</...`, so the literal sequence should
    // never reach the output for any of these inputs. These tests pin that
    // invariant.

    it('escapes </style> inside a string value', () => {
      const result = sanitizeBrandingCss('.x { font-family: "</style><img src=x onerror=alert(1)>"; }');

      expect(result.css.toLowerCase()).not.toContain('</style');
      // Whatever else happens, the canonical close-tag bytes must not appear.
    });

    it('escapes </style> inside a CSS comment', () => {
      const result = sanitizeBrandingCss('.x { color: red; /* </style><script>alert(1)</script> */ }');

      expect(result.css.toLowerCase()).not.toContain('</style');
    });

    it('escapes </style> inside an at-rule params block', () => {
      const result = sanitizeBrandingCss(
        '@media screen and (foo: bar)</style><script>x()</script> { .x { color: red; } }',
      );

      expect(result.css.toLowerCase()).not.toContain('</style');
    });

    it('escapes mixed-case </StYlE> in a value', () => {
      const result = sanitizeBrandingCss('.x { font-family: "</StYlE>foo"; }');

      expect(result.css.toLowerCase()).not.toContain('</style');
    });

    it('escapes </style> in an attribute selector value', () => {
      const result = sanitizeBrandingCss('[data-x="</style><script>alert(1)</script>"] { color: red; }');

      expect(result.css.toLowerCase()).not.toContain('</style');
    });

    // Round 19 (C110): the family "<script>alert(1)</script>" is not on the named list, so the
    // declaration is now dropped with a value warning rather than kept with its end tag escaped.
    it('drops the unlisted font-family "<script>alert(1)</script>" with a value warning', () => {
      const result = sanitizeBrandingCss('.x { font-family: "<script>alert(1)</script>"; }');

      expect(result.css.toLowerCase()).not.toContain('script');
      expect(result.css.toLowerCase()).not.toContain('</style');
      expect(result.warnings.map((warning) => warning.kind)).toEqual(['value']);
    });
  });

  describe('malformed CSS', () => {
    // PostCSS is forgiving; an empty value parses without throwing.
    it('handles a declaration with an empty value gracefully', () => {
      const result = sanitizeBrandingCss('.x { color: }');

      expect(result.warnings.filter((w) => w.kind === 'parse-error')).toEqual([]);
      expect(result.css).toContain('.x');
    });

    it('reports a parse-error for clearly broken CSS', () => {
      // Unclosed brace.
      const result = sanitizeBrandingCss('.x { color: red');

      // PostCSS may or may not throw on this; if it does, we get a
      // parse-error warning. If it tolerates it, the rule is sanitized.
      if (result.css === '') {
        expect(result.warnings.some((w) => w.kind === 'parse-error')).toBe(true);
      } else {
        expect(result.css).toContain('.x');
      }
    });
  });

  /**
   * Forms that slipped past the property and value checks. The output is
   * checked after decoding CSS escapes, since the browser decodes them before it applies the
   * declaration.
   */
  describe('bypass forms', () => {
    const BLOCKED_PROPERTIES = [
      'display',
      'visibility',
      'opacity',
      'pointer-events',
      'position',
      'inset',
      'top',
      'right',
      'bottom',
      'left',
      'z-index',
      'transform',
      'clip',
      'clip-path',
      'mask',
      'mask-image',
      'content',
      'width',
      'height',
      'min-width',
      'min-height',
      'max-width',
      'max-height',
      'overflow',
      'overflow-x',
      'overflow-y',
      'font-size',
      'letter-spacing',
      'word-spacing',
      'line-height',
      'text-indent',
    ];

    const BLOCKED_VALUE_TOKENS = ['url(', 'expression(', 'javascript:', '@import'];

    /**
     * Decodes CSS escapes: a backslash and 1 to 6 hex digits with one optional trailing
     * whitespace, or a backslash and any other character, which stands for that character.
     */
    const decodeCssEscapes = (css: string) =>
      css.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f]))/g, (_match, hex, char) => {
        if (hex === undefined) {
          return char;
        }

        const codePoint = parseInt(hex, 16);

        if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return '\uFFFD';
        }

        return String.fromCodePoint(codePoint);
      });

    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]-]/g, '\\$&');

    const expectNoBlockedConstructs = (css: string) => {
      const decoded = decodeCssEscapes(css).toLowerCase();

      for (const prop of BLOCKED_PROPERTIES) {
        expect(decoded, `blocked property "${prop}" in: ${css}`).not.toMatch(
          new RegExp(`(^|[{;\\s])${escapeRegExp(prop)}\\s*:`),
        );
      }

      for (const token of BLOCKED_VALUE_TOKENS) {
        expect(decoded, `blocked value "${token}" in: ${css}`).not.toContain(token);
      }

      expect(decoded, `!important in: ${css}`).not.toMatch(/!\s*important/);
    };

    it('decodes escapes in the test helper itself', () => {
      expect(decodeCssEscapes('displ\\61y')).toBe('display');
      expect(decodeCssEscapes('\\64 isplay')).toBe('display');
      expect(decodeCssEscapes('d\\isplay')).toBe('display');
      expect(decodeCssEscapes('\\55 RL(')).toBe('URL(');
      expect(decodeCssEscapes('\\000075rl(')).toBe('url(');
    });

    const bypassCases: Array<[string, string]> = [
      // Nested rules at any depth.
      ['a nested rule', '.card { .reject-button { display: none } }'],
      ['a rule nested four deep', '.a { .b { .c { .d { display: none } } } }'],
      ['a nested rule after an allowed declaration', '.a { color: red; .b { visibility: hidden } }'],
      ['an &-nested descendant rule', '.a { & .b { display: none } }'],
      ['an &-nested pseudo-class rule', '.a { &:hover { opacity: 0 } }'],
      ['a nested selector list', '.a { .b, .c { position: absolute } }'],
      ['a selector list holding a nested rule', '.a, .b { .c { transform: scale(0) } }'],
      ['a nested rule inside @media', '@media (min-width: 1px) { .a { .b { display: none } } }'],
      ['a blocked value in a nested rule', '.a { .b { background: url(https://x.example/a.png) } }'],
      ['an escaped property in a nested rule', '.a { .b { displ\\61y: none } }'],

      // Top-level declarations and declarations directly inside @media.
      ['a top-level declaration', 'display: none;'],
      ['a top-level declaration before a rule', 'display: none; .a { color: red }'],
      ['a top-level declaration after a rule', '.a { color: red } visibility: hidden;'],
      ['a top-level blocked value', 'background: url(https://x.example/a.png);'],
      ['a declaration directly inside @media', '@media (min-width: 1px) { display: none }'],
      ['a declaration directly inside @media print', '@media print { opacity: 0; }'],

      // Escaped property names.
      ['an escaped property name displ\\61y', '.x { displ\\61y: none }'],
      ['an escaped property name \\64 isplay', '.x { \\64 isplay: none }'],
      ['an escaped property name d\\isplay', '.x { d\\isplay: none }'],
      ['an escaped property name \\000064isplay', '.x { \\000064isplay: none }'],
      ['an escaped upper-case property name', '.x { DISPL\\41Y: none }'],
      ['an escaped property name v\\69sibility', '.x { v\\69sibility: hidden }'],

      // Escaped values.
      ['an escaped value \\75rl(', '.x { background: \\75rl(https://x.example/a.png) }'],
      ['an escaped value \\55 RL(', '.x { background: \\55 RL(https://x.example/a.png) }'],
      ['an escaped value u\\72l(', '.x { background: u\\72l(https://x.example/a.png) }'],
      ['an escaped value \\000075rl(', '.x { background: \\000075rl(https://x.example/a.png) }'],
      ['an escaped value e\\78pression(', '.x { background: e\\78pression(alert(1)) }'],
      ['an escaped value j\\61vascript: in a string', '.x { font-family: "j\\61vascript:alert" }'],
      ['an escaped value in a top-level declaration', 'background: \\75rl(https://x.example/a.png);'],

      // Nested at-rules inside a rule.
      ['@media nested inside a rule', '.a { @media print { display: none } }'],
      ['@media nested inside a rule holding a rule', '.a { @media print { .b { display: none } } }'],
      ['@supports nested inside a rule', '.a { @supports (color: red) { display: none } }'],
    ];

    for (const [label, input] of bypassCases) {
      it(`refuses ${label}`, () => {
        const result = sanitizeBrandingCss(input);

        expectNoBlockedConstructs(result.css);
        expect(result.warnings.length).toBeGreaterThan(0);
      });
    }

    // `!important` is stripped silently today (see '!important stripping'), so these cases
    // check only the output.
    const importantCases: Array<[string, string]> = [
      ['an escaped !\\69mportant', '.x { color: red !\\69mportant }'],
      ['an escaped !IMPORT\\41NT', '.x { color: red !IMPORT\\41NT }'],
      ['a spaced ! important', '.x { color: red ! important }'],
      ['an escaped !important in a nested rule', '.a { .b { color: red !\\69mportant } }'],
    ];

    for (const [label, input] of importantCases) {
      it(`strips ${label}`, () => {
        const result = sanitizeBrandingCss(input);

        expectNoBlockedConstructs(result.css);
      });
    }

    const ordinaryCases: Array<[string, string[]]> = [
      // Round 17 (C102): restated without border-radius, which is now dropped (see the round 17 block).
      ['.btn { color: #123456; border-color: #ccc }', ['.btn', 'color: #123456', 'border-color: #ccc']],
      ['@media (max-width: 600px) { .btn { color: red } }', ['@media (max-width: 600px)', '.btn', 'color: red']],
    ];

    for (const [input, kept] of ordinaryCases) {
      it(`keeps the ordinary input ${input} unchanged`, () => {
        const result = sanitizeBrandingCss(input);

        for (const fragment of kept) {
          expect(normalize(result.css)).toContain(fragment);
        }

        expect(result.warnings).toEqual([]);
      });
    }

    // Round 14 (C87): no pseudo-class is kept, so the hover rule this list once kept is dropped.
    it('drops the hover rule .btn:hover { background-color: rgb(1 2 3) } with a selector warning', () => {
      const result = sanitizeBrandingCss('.btn:hover { background-color: rgb(1 2 3) }');

      expect(normalize(result.css)).not.toContain('.btn');
      expect(result.warnings.filter((warning) => warning.kind === 'selector')).toHaveLength(1);
    });

    /**
     * The sanitiser keeps an allowlist of branding properties (colours,
     * backgrounds, borders, outlines, fonts) and checks values token by token.
     *
     * Bounds: since round 18 (C105) a border or outline width is kept only as a px length of at
     * most 3 or `thin`/`medium`; anything wider, `thick` or another unit is refused (round 18 block). Since round 17 (C102) every
     * radius property is refused; that is asserted in the round 17 block.
     */
    describe('allowlist', () => {
      const expectPropertyGone = (css: string, prop: string) => {
        const decoded = decodeCssEscapes(css).toLowerCase();

        expect(decoded, `property "${prop}" in: ${css}`).not.toMatch(
          new RegExp(`(^|[{;\\s])${escapeRegExp(prop)}\\s*:`),
        );
      };

      describe('C3: properties outside branding are refused', () => {
        const refusedDeclarations: Array<[string, string]> = [
          ['filter', 'filter: opacity(0)'],
          ['translate', 'translate: -99999px'],
          ['scale', 'scale: 0'],
          ['margin-left', 'margin-left: -99999px'],
          ['padding', 'padding: 0'],
          ['inline-size', 'inline-size: 0'],
          ['block-size', 'block-size: 0'],
          ['-webkit-mask', '-webkit-mask: linear-gradient(transparent, transparent)'],
          ['-webkit-box-reflect', '-webkit-box-reflect: below'],
          ['box-shadow', 'box-shadow: 0 0 0 9999px white'],
          ['all', 'all: unset'],
          ['animation', 'animation: x 1s'],
          ['animation-duration', 'animation-duration: 999999999s'],
          ['transition', 'transition: all 1s'],
          ['font', 'font: 0/0 sans-serif'],
          ['--tw-enter-opacity', '--tw-enter-opacity: 0'],
          ['--brand-anything', '--brand-anything: red'],
          ['cursor', 'cursor: none'],
          ['float', 'float: left'],
        ];

        for (const [prop, declaration] of refusedDeclarations) {
          it(`refuses "${declaration}"`, () => {
            const result = sanitizeBrandingCss(`.x { color: red; ${declaration}; }`);

            expectPropertyGone(result.css, prop);
            expect(result.css).toContain('color: red');
            expect(result.warnings.length).toBeGreaterThan(0);
          });
        }
      });

      describe('C4: values are checked token by token', () => {
        // [declaration, a fragment of the value that must not survive, decoded and lower-cased]
        const refusedValues: Array<[string, string | string[]]> = [
          ['background-image: image-set("https://x.example/a.png" 1x)', 'image-set('],
          ['background-image: -webkit-image-set("https://x.example/a.png" 1x)', 'image-set('],
          ['background-image: src("https://x.example/a.png")', 'src('],
          ['color: var(--x)', 'var('],
          ['color: transparent !/**/\\69mportant', 'important'],
          ['color: blue !ie', '!'],
          ['border: 9999px solid white', '9999px'],
          ['border-width: 50em', '50em'],
          ['border: 17px solid white', '17px'],
          ['border-left: 100vw solid white', '100vw'],
          ['outline: 9999px solid white', '9999px'],
          ['text-decoration: line-through solid white 9999px', '9999px'],
          ['text-decoration: underline 3px', '3px'],
          ['text-decoration: underline 0.5em', '0.5em'],
          ['outline: \\63\\61\\6c\\63 (1px * 99999) solid white', ['calc', '(']],
          ['border: \\63 alc(1px * 99999) solid white', ['calc', '(']],
          ['border-width: (1px * 99999)', '('],
          ['color: rgb(1 2 3) (4)', '('],
        ];

        for (const [declaration, fragment] of refusedValues) {
          it(`refuses "${declaration}"`, () => {
            const result = sanitizeBrandingCss(`.x { color: red; ${declaration}; }`);

            for (const token of [fragment].flat()) {
              expect(decodeCssEscapes(result.css).toLowerCase()).not.toContain(token);
            }
            expect(result.css).toContain('color: red');
            expect(result.warnings.length).toBeGreaterThan(0);
          });
        }

        const keptValues = [
          // Round 19 (C110): 'border: 2px solid #333' is now dropped (round 19 block).
          // Round 18 (C105): 'border: 16px solid #333' and 'border-width: 1em' are now dropped (round 18 block).
          // Round 17 (C102): 'border-radius: 8px' and 'border-radius: 50%' are now dropped (round 17 block).
        ];

        for (const declaration of keptValues) {
          it(`keeps "${declaration}"`, () => {
            const result = sanitizeBrandingCss(`.x { ${declaration}; }`);

            expect(normalize(result.css)).toContain(declaration);
            expect(result.warnings).toEqual([]);
          });
        }
      });

      describe('C5: selectors cannot reach outside the wrapper', () => {
        const nestingSelectorRules = [
          '& { color: red; }',
          'html:has(&) { color: red; }',
          ':is(&) .x { color: red; }',
          '.a, & { color: red; }',
          'body:has(&) button { border-color: red; }',
        ];

        for (const input of nestingSelectorRules) {
          it(`drops the rule "${input}"`, () => {
            const result = sanitizeBrandingCss(input);

            expect(decodeCssEscapes(result.css)).not.toContain('&');
            expect(result.warnings.length).toBeGreaterThan(0);
          });
        }

        const escapedPseudoElements = ['button::\\62 efore { color: red; }', 'button::\\000062efore { color: red; }'];

        for (const input of escapedPseudoElements) {
          it(`drops the escaped pseudo-element rule "${input}"`, () => {
            const result = sanitizeBrandingCss(input);

            expect(decodeCssEscapes(result.css).toLowerCase()).not.toContain('before');
            expect(result.warnings.length).toBeGreaterThan(0);
          });
        }
      });

      describe('C6: ordinary branding keeps working', () => {
        const keptDeclarations = [
          'color: red',
          'background-color: #fafafa',
          'background: #fff',
          'background: linear-gradient(#fff, #eee)',
          // Round 19 (C110): 'border: 1px solid black' is now dropped (round 19 block).
          'border-color: #ccc',
          // Round 17 (C102): 'border-radius: 4px' is now dropped (round 17 block).
          // Round 19 (C110): 'outline: 2px solid red' is now dropped (round 19 block).
          'font-family: "Inter", sans-serif',
          'font-weight: 600',
          'font-style: italic',
          'text-decoration: underline',
          'text-decoration: line-through wavy red',
          'text-decoration-color: red',
          'text-transform: uppercase',
          'fill: #000',
          'stroke: #000',
          'accent-color: #00aa00',
          'caret-color: blue',
          'color: rgb(1 2 3)',
          'color: rgba(1, 2, 3, 0.5)',
          'color: hsl(120 50% 50%)',
          'color: oklch(70% 0.1 200)',
          'color: color-mix(in srgb, red 50%, blue)',
          'color: rebeccapurple',
          'color: currentColor',
          'color: transparent',
          'color: inherit',
        ];

        for (const declaration of keptDeclarations) {
          it(`keeps "${declaration}"`, () => {
            const result = sanitizeBrandingCss(`.x { ${declaration}; }`);

            expect(normalize(result.css)).toContain(declaration);
            expect(result.warnings).toEqual([]);
          });
        }
      });
    });
  });

  /**
   * Round 14 (C86 and C87): each selector is checked on its raw characters before the selector
   * parser reads it. Only ASCII letters and digits, space, tab, LF, CR and `- _ . # [ ] = ~ ^ $ * " ' , > + :`
   * are allowed, and once every case-insensitive `::placeholder` is removed no colon may remain. A failing
   * selector drops its whole rule with one `selector` warning; the rest of the stylesheet is kept.
   */
  describe('round 14: selector characters and colons', () => {
    const KEEP = '.keep { font-weight: 700; }';

    const droppedByCharacter: Array<[string, string]> = [
      ['a backslash escape in a class', '.c-bs1.a\\62 c'],
      ['an escaped pseudo-class', '.c-bs2:\\61 ctive'],
      ["Codex round 13's escaped :is", 'input.c-cx1:i\\000073 (:checked)+textarea'],
      ['an escaped :where', 'input.c-cx2:wher\\000065 (:checked)+textarea'],
      ['an escaped :not', 'input.c-cx3:n\\00006f t(.zz)+textarea'],
      ['an escaped :nth-child', '.c-cx4 > input:nth-chil\\000064 (1)+textarea'],
      ['parentheses in :is', '.c-p1:is(.a)'],
      ['parentheses in :not', '.c-p2.a:not(.b)'],
      ['a comment', '.c-cm.a/**/.b'],
      ['a namespace', '*|button.c-ns1'],
      ['a dash-match operator', '.c-ns2[lang|=en]'],
      ['an at sign', '.c-at@x'],
      ['a percent sign', '.c-pc%x'],
      ['an ampersand', '& .c-amp'],
      ['an exclamation mark', '.c-ex!x'],
      ['a backtick', '.c-bt`x'],
      ['a question mark', '.c-q?x'],
      ['an accented letter', '.c-na1.é'],
      ['a fullwidth colon U+FF1A', '.c-na2.a：hover'],
      ['a zero-width space U+200B', '.c-na3.a​'],
      ['a no-break space U+00A0', '.c-na4.a .b'],
    ];

    for (const [label, selector] of droppedByCharacter) {
      it(`drops the rule with ${label} and keeps the rest`, () => {
        const id = selector.match(/c-[a-z0-9]+/)?.[0] ?? selector;
        const result = sanitizeBrandingCss(`${KEEP}\n${selector} { font-weight: 700; }`);

        expect(result.refused).toBeUndefined();
        expect(result.css).not.toContain(id);
        expect(normalize(result.css)).toContain(KEEP);
        expect(result.warnings.filter((warning) => warning.kind === 'selector')).toHaveLength(1);
      });
    }

    // Amended after the round 14 red run: a `;` in a selector stays a parse error for the whole stylesheet.
    it('treats a semicolon in a selector as a parse error for the whole stylesheet', () => {
      const result = sanitizeBrandingCss(`${KEEP}\n.c-sc;x { font-weight: 700; }`);

      expect(result.css.trim()).toBe('');
      expect(result.warnings.some((warning) => warning.kind === 'parse-error')).toBe(true);
    });

    // Amended after the round 14 red run: `*` is in the character set only for `*=`; the sanitiser still drops it.
    it('drops a universal selector as the sanitiser does', () => {
      const result = sanitizeBrandingCss(`${KEEP}\n.c-u > * { font-weight: 700; }`);

      expect(result.css).not.toContain('c-u');
      expect(normalize(result.css)).toContain(KEEP);
      expect(result.warnings.filter((warning) => warning.kind === 'selector')).toHaveLength(1);
    });

    const droppedByColon = [
      '.c-hover:hover',
      '.c-focus:focus',
      '.c-fv:focus-visible',
      '.c-fw:focus-within',
      '.c-fc:first-child',
      '.c-lc:last-child',
      '.c-oc:only-child',
      '.c-fot:first-of-type',
      '.c-lot:last-of-type',
      '.c-oot:only-of-type',
      '.c-empty:empty',
      ':root .c-root',
      '.c-nth:nth-child(2)',
      '.c-not:not(.a)',
      '.c-is:is(.a)',
      '.c-where:where(.a)',
      '.c-upper:HOVER',
      'input.c-ph:placeholder',
      'a.c-href[href^="https:"]',
      'input.c-ph3:::placeholder',
    ];

    for (const selector of droppedByColon) {
      it(`drops the rule ${selector} and keeps the rest`, () => {
        const id = selector.match(/c-[a-z0-9]+/)?.[0] ?? selector;
        const result = sanitizeBrandingCss(`${KEEP}\n${selector} { font-weight: 700; }`);

        expect(result.css).not.toContain(id);
        expect(normalize(result.css)).toContain(KEEP);
        expect(result.warnings.filter((warning) => warning.kind === 'selector')).toHaveLength(1);
      });
    }

    it('drops a rule inside @media by the same check', () => {
      const result = sanitizeBrandingCss(
        '@media (min-width: 600px) { .c-media:hover { font-weight: 700; } .ok { font-weight: 700; } }',
      );

      expect(result.css).not.toContain('c-media');
      expect(result.css).toContain('.ok');
      expect(result.warnings.filter((warning) => warning.kind === 'selector')).toHaveLength(1);
    });

    const kept = [
      'dfn',
      '.k-class',
      '#k-id',
      '[data-k]',
      '[data-k=x]',
      '[data-k~="x"]',
      '[data-k^="ab"]',
      "[data-k$='yz']",
      '[data-k*="mid"]',
      '.k-p .k-desc',
      '.k-p > .k-child',
      '.k-s1 + .k-adj',
      '.k-s1 ~ .k-sib',
      '.k-l1, .k-l2',
      'input.k-ph::placeholder',
      'input.k-ph::PLACEHOLDER',
      'input.k-ph::PlaceHolder',
    ];

    for (const selector of kept) {
      it(`keeps ${selector}`, () => {
        const result = sanitizeBrandingCss(`${selector} { font-weight: 700; }`);

        expect(normalize(result.css)).toBe(`${selector} { font-weight: 700; }`);
        expect(result.warnings).toEqual([]);
      });
    }
  });

  /**
   * Round 15 (C95): the character and colon check also covers what postcss stores between the
   * selector and its `{` (`rule.raws.between`). A comment, form feed or any character outside the set
   * there drops the rule with a `selector` warning; plain space and newline are kept.
   */
  describe('round 15: the selector trailer', () => {
    const KEEP = '.keep { font-weight: 700; }';

    const dropped: Array<[string, string]> = [
      ['a comment holding :hover', 'button/*:hover*/{font-weight:777}'],
      ['a form feed', 'button\f{font-weight:777}'],
      ['a no-break space U+00A0', 'button {font-weight:777}'],
    ];

    for (const [label, rule] of dropped) {
      it(`drops a rule with ${label} before its brace and keeps the rest`, () => {
        const result = sanitizeBrandingCss(`${KEEP}\n${rule}`);

        expect(result.css).not.toContain('777');
        expect(normalize(result.css)).toContain(KEEP);
        expect(result.warnings.filter((warning) => warning.kind === 'selector')).toHaveLength(1);
      });
    }

    // Amended after the round 15 red run: a vertical tab refuses the whole stylesheet, as today.
    it('refuses the whole stylesheet for a vertical tab before a brace', () => {
      const result = sanitizeBrandingCss(`${KEEP}\nbutton\v{font-weight:777}`);

      expect(result.css).toBe('');
      expect(result.refused).toBeDefined();
    });

    const kept: Array<[string, string]> = [
      ['a plain space', 'button {font-weight:777}'],
      ['a newline', 'button\n{font-weight:777}'],
    ];

    for (const [label, rule] of kept) {
      it(`keeps a rule with ${label} before its brace`, () => {
        const result = sanitizeBrandingCss(`${KEEP}\n${rule}`);

        expect(result.css).toContain('font-weight:777');
        expect(normalize(result.css)).toContain(KEEP);
        expect(result.warnings).toEqual([]);
      });
    }
  });

  /**
   * Round 16 (C97 and C98): a tenant `background-color` or `background` must resolve to an opaque
   * colour. Translucent and keyword values drop the declaration, the rule's other declarations stay.
   * The spec places the rule at save and in `renderStoredBrandingCss`, not necessarily in
   * `sanitizeBrandingCss` (the contrast pass is a separate step after it), so these cases go through the
   * render path, which always applies both. The save path and its warnings are covered end to end in
   * branding-contrast-round16.spec.ts. C99 is a guard behaviour with no lib surface.
   */
  describe('round 16: opaque tenant backgrounds', () => {
    const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
    const KEEP = '.keep{background-color:#fff;color:#000}';
    const squash = (css: string) => css.replace(/\s+/g, '');
    const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));

    it("drops Codex round 15's transparent dialog background and keeps its colour", () => {
      const rendered = render('[role=dialog]{background-color:transparent;color:#909090}');

      expect(rendered).not.toContain('transparent');
      expect(rendered).toContain('[role=dialog]{color:#909090}');
    });

    const dropped = [
      'transparent',
      'rgba(0,0,0,0.5)',
      'hsla(0,0%,0%,.5)',
      '#0008',
      '#00000080',
      'currentcolor',
      'inherit',
      'initial',
      'unset',
      'revert',
      'revert-layer',
    ];

    for (const property of ['background-color', 'background']) {
      for (const value of dropped) {
        it(`drops ${property}: ${value} and keeps the rule's other declarations`, () => {
          const text = value === 'transparent' ? '#808080' : '#fff';
          const rendered = render(`${KEEP}\n.d{${property}:${value};color:${text};border-color:rgb(1, 2, 3)}`);

          expect(rendered).toContain(KEEP);
          expect(rendered.toLowerCase()).not.toContain(squash(`${property}:${value}`).toLowerCase());
          expect(rendered).toContain('border-color:rgb(1,2,3)');
        });
      }
    }

    // C101: gradient stops must be opaque, and a `background` shorthand must paint something opaque.
    const droppedGradients = [
      'background:linear-gradient(transparent,transparent)',
      'background-image:linear-gradient(#0000,#0000)',
      'background:linear-gradient(#fff,rgba(0,0,0,.5))',
      'background:none',
    ];

    for (const declaration of droppedGradients) {
      it(`drops ${declaration} and keeps the rule's other declarations (C101)`, () => {
        const rendered = render(`${KEEP}\n.d{${declaration};color:#808080;border-color:rgb(1, 2, 3)}`);

        expect(rendered).toContain(KEEP);
        expect(rendered).not.toContain(squash(declaration));
        expect(rendered).toContain('border-color:rgb(1,2,3)');
      });
    }

    it('keeps background-image:none (C101)', () => {
      const rule = '.k{background-image:none;border-color:rgb(1, 2, 3)}';

      expect(render(rule)).toContain(squash(rule));
    });

    // C101 correction: the round 2 rule ("Gradients are not evaluated") still drops opaque gradients.
    for (const rule of [
      '.k{background:linear-gradient(#fff,#eee);color:#000}',
      '.k{background-image:linear-gradient(#fff,#eee);background-color:#fff;color:#000}',
    ]) {
      it(`still drops the opaque gradient in ${rule} under the round 2 rule (C101)`, () => {
        expect(render(rule)).not.toContain('gradient');
      });
    }

    const kept: Array<[string, string]> = [
      ['#fff', '#000'],
      ['#ffffffff', '#000'],
      ['rgb(0 0 0)', '#fff'],
      ['rgba(0,0,0,1)', '#fff'],
      ['hsl(0 0% 100% / 1)', '#000'],
    ];

    for (const property of ['background-color', 'background']) {
      for (const [value, text] of kept) {
        it(`keeps the opaque ${property}: ${value}`, () => {
          const rule = `.k{${property}:${value};color:${text}}`;

          expect(render(rule)).toContain(squash(rule));
          expect(sanitizeBrandingCss(rule).warnings).toEqual([]);
        });
      }
    }
  });
  /**
   * Round 17 (C102 and C103). The five radius properties leave the allowlist and are dropped with
   * the existing `property` warning, the rule's other declarations kept; stored rows lose them at render.
   * A background colour is kept only when the colour parser reads it and its alpha is 1; an unreadable
   * colour drops that declaration before the contrast check, so the rule's other declarations are judged
   * as if it were never written. The value gate runs with the contrast pass, so C103 goes through the
   * render path; its save warnings are covered in branding-contrast-round17.spec.ts.
   */
  describe('round 17: no tenant radii, and proven background opacity', () => {
    const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
    const KEEP = '.keep{background-color:#fff;color:#000}';
    const squash = (css: string) => css.replace(/\s+/g, '');
    const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));
    const RADII = [
      'border-radius',
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-left-radius',
      'border-bottom-right-radius',
    ];

    for (const property of RADII) {
      it(`drops ${property} with a property warning and keeps the rule's other declarations`, () => {
        const result = sanitizeBrandingCss(`.x { color: red; ${property}: 4px; }`);

        expect(decodeCssEscapes(result.css).toLowerCase()).not.toContain('radius');
        expect(result.css).toContain('color: red');
        expect(result.warnings.map((warning) => warning.kind)).toEqual(['property']);
      });

      it(`drops ${property} from a stored row at render and keeps .keep`, () => {
        const rendered = render(`${KEEP}\n.x{${property}:100%;border-color:rgb(1, 2, 3)}`);

        expect(rendered).toContain(KEEP);
        expect(rendered).not.toContain('radius');
        expect(rendered).toContain('border-color:rgb(1,2,3)');
      });
    }

    for (const input of ['.x { BORDER-RADIUS: 4px; color: red; }', '.x { border-\\72 adius: 4px; color: red; }']) {
      it(`drops the radius in ${input}`, () => {
        const result = sanitizeBrandingCss(input);

        expect(decodeCssEscapes(result.css).toLowerCase()).not.toContain('radius');
        expect(result.css).toContain('color: red');
        expect(result.warnings.length).toBeGreaterThan(0);
      });
    }

    // The radius declarations earlier blocks kept, restated as drops.
    for (const input of [
      '.btn { color: #123456; border-radius: 4px }',
      '.x { border-radius: 8px; color: red; }',
      '.x { border-radius: 50%; color: red; }',
    ]) {
      it(`drops the radius in the formerly kept ${input}`, () => {
        const result = sanitizeBrandingCss(input);

        expect(result.css).not.toContain('radius');
        expect(result.css).toMatch(/color: (#123456|red)/);
        expect(result.warnings.map((warning) => warning.kind)).toEqual(['property']);
      });
    }

    it("drops Codex round 16's corner radius and keeps the colour and the close-button rule", () => {
      const rendered = render(
        '[role=dialog]{border-top-left-radius:100%;color:#909090}\n[data-testid=btn-dialog-close]{background-color:#fff;color:#000}',
      );

      expect(rendered).not.toContain('radius');
      expect(rendered).toContain('[role=dialog]{color:#909090}');
      expect(rendered).toContain('[data-testid=btn-dialog-close]{background-color:#fff;color:#000}');
    });

    const unproven = [
      'color-mix(in srgb,white 10%,black 10%)',
      'rgb(from #fff r g b / 0.5)',
      'hwb(0 0% 0% / 0.5)',
      'lab(50 0 0 / 0.5)',
      'Canvas',
      '#fffff',
      'rgb(0 0 0 / none)',
    ];

    // A lone `color:#000` fails the dark themes, so "judged as if the declaration were never written"
    // drops it as well; the grey twin survives alone and carries "the rest of the rule is kept".
    const alone = (text: string) => render(`.x{color:${text};border-color:red}`);

    for (const value of unproven) {
      it(`drops background-color:${value} and judges the rest as if it were never written`, () => {
        const rendered = render(`.x{background-color:${value};color:#000;border-color:red}`);

        expect(rendered).not.toContain('background-color');
        expect(rendered).toBe(alone('#000'));
        expect(rendered).toContain('border-color:red');
      });

      it(`drops background-color:${value} and keeps color:#909090 and border-color:red`, () => {
        expect(render(`.x{background-color:${value};color:#909090;border-color:red}`)).toBe(
          '.x{color:#909090;border-color:red}',
        );
      });
    }

    for (const value of ['hwb(0 0% 0%)', 'lab(100 0 0)']) {
      it(`keeps background-color:${value} whole, or drops only it (control)`, () => {
        const rendered = render(`.x{background-color:${value};color:#000;border-color:red}`);
        const kept = squash(`.x{background-color:${value};color:#000;border-color:red}`);

        expect([kept, alone('#000')]).toContain(rendered);
      });
    }
  });
  /**
   * Round 18 (C105). A border or outline width is kept only as a `px` length of at most 3, or `thin`
   * or `medium`; `thick`, any other unit and any `px` above 3 drop the declaration with a `value`
   * warning. A shorthand with no width uses `medium` and is kept. C106 is a guard behaviour with no lib
   * surface. Round 19 (C110): border and outline shapes left the allowlist, so every case here is
   * now dropped with a `property` warning, the former kept list included.
   */
  describe('round 18: border widths at control scale', () => {
    const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
    const KEEP = '.keep{background-color:#fff;color:#000}';
    const squash = (css: string) => css.replace(/\s+/g, '');
    const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));

    const dropped = [
      'border:4px solid red',
      'border-width:thick',
      'border-width:0.5em',
      'outline:1rem solid red',
      'border-left:5px solid red',
      'border-top-width:4px',
      'outline-width:thick',
      'border:3.5px solid red',
      'border-width:1px 4px',
      'border-width:4PX',
      'border-bottom:1vw solid red',
      'outline:0.25in solid red',
      'border-right-width:2ch',
      'border:thick solid red',
      'border-width:10%',
      // Restated from the C4 kept list, where they were kept before round 18.
      'border: 16px solid #333',
      'border-width: 1em',
    ];

    for (const declaration of dropped) {
      it(`drops "${declaration}" with a property warning and keeps the rule's other declarations`, () => {
        const result = sanitizeBrandingCss(`.x { color: red; ${declaration}; }`);

        expect(normalize(result.css)).not.toContain(declaration);
        expect(result.css).toContain('color: red');
        expect(result.warnings.map((warning) => warning.kind)).toEqual(['property']);
      });

      it(`drops "${declaration}" from a stored row at render and keeps .keep`, () => {
        const rendered = render(`${KEEP}\n.x{${declaration};border-color:rgb(1, 2, 3)}`);

        expect(rendered).toContain(KEEP);
        expect(rendered).toContain('.x{border-color:rgb(1,2,3)}');
      });
    }

    it("drops Codex round 17's icon-consuming border", () => {
      const result = sanitizeBrandingCss('[data-testid=btn-dialog-close] svg{border:8px solid transparent}');

      expect(result.css).not.toContain('8px');
      expect(result.warnings.map((warning) => warning.kind)).toEqual(['property']);
      expect(render('[data-testid=btn-dialog-close] svg{border:8px solid transparent}')).not.toContain('8px');
    });

    const kept = [
      'border:3px solid red',
      'border:thin solid red',
      'border:medium solid red',
      'border:solid red',
      'outline:2px solid red',
      'border-width:1px 2px 3px',
      'outline-width:medium',
      'border-top:thin solid red',
      'border-left-width:3px',
    ];

    for (const declaration of kept) {
      it(`drops the formerly kept "${declaration}" with a property warning`, () => {
        const result = sanitizeBrandingCss(`.x { ${declaration}; }`);

        expect(squash(result.css)).not.toContain(squash(declaration));
        expect(result.warnings.map((warning) => warning.kind)).toEqual(['property']);
        expect(render(`.x{${declaration}}`)).not.toContain(squash(declaration));
      });
    }
  });
  /**
   * Round 19 (C108 and C109). Of the border and outline properties only the six colour properties
   * stay allowed; every shape property drops with the existing `property` warning, the rule's other
   * declarations kept. A `font-family` is kept only when every family in it is on the named list,
   * compared case-insensitively after removing quotes; any other family drops the declaration with a
   * `value` warning.
   */
  describe('round 19: colour-only borders and named fonts', () => {
    const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
    const KEEP = '.keep{background-color:#fff;color:#000}';
    const squash = (css: string) => css.replace(/\s+/g, '');
    const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));

    const removed = [
      'border: 1px solid red',
      'border-top: 1px solid red',
      'border-right: 1px solid red',
      'border-bottom: 1px solid red',
      'border-left: 1px solid red',
      'border-style: solid',
      'border-width: 1px',
      'border-top-style: dashed',
      'border-right-style: solid',
      'border-bottom-style: solid',
      'border-left-style: solid',
      'border-top-width: 1px',
      'border-right-width: 1px',
      'border-bottom-width: 1px',
      'border-left-width: 1px',
      'outline: 1px solid red',
      'outline-style: solid',
      'outline-width: 1px',
      'BORDER: 1px solid red',
      'border: none',
      'outline: none',
      // Restated from the allowlist, C4 and C6 kept lists.
      'border: 1px solid black',
      'border: 2px solid #333',
      'outline: 2px solid red',
    ];

    for (const declaration of removed) {
      it(`drops "${declaration}" with a property warning and keeps the rule's other declarations`, () => {
        const result = sanitizeBrandingCss(`.x { color: red; ${declaration}; }`);

        expect(normalize(result.css).toLowerCase()).not.toContain(declaration.toLowerCase());
        expect(result.css).toContain('color: red');
        expect(result.warnings.map((warning) => warning.kind)).toEqual(['property']);
      });

      it(`drops "${declaration}" from a stored row at render and keeps .keep`, () => {
        const rendered = render(`${KEEP}\n.x{${declaration};border-color:rgb(1, 2, 3)}`);

        expect(rendered).toContain(KEEP);
        expect(rendered).toContain('.x{border-color:rgb(1,2,3)}');
      });
    }

    it("drops Codex round 18's nested checkbox borders", () => {
      const css = '[role=checkbox],[role=checkbox] span,[role=checkbox] svg{border:3px solid transparent}';
      const result = sanitizeBrandingCss(css);

      expect(result.css).not.toContain('border');
      expect(result.warnings.map((warning) => warning.kind)).toEqual(['property']);
      expect(render(css)).not.toContain('border');
    });

    for (const declaration of [
      'border-color: #123456',
      'border-top-color: #123456',
      'border-right-color: #123456',
      'border-bottom-color: #123456',
      'border-left-color: #123456',
      'outline-color: #123456',
    ]) {
      it(`keeps "${declaration}" with no warning`, () => {
        const result = sanitizeBrandingCss(`.x { ${declaration}; }`);

        expect(normalize(result.css)).toContain(declaration);
        expect(result.warnings).toEqual([]);
        expect(render(`.x{${declaration}}`)).toContain(squash(declaration));
      });
    }

    const droppedFonts = [
      'Wingdings',
      '"Webdings"',
      'Symbol',
      "'Zapf Dingbats'",
      'Marlett',
      'Comic Sans MS',
      'Arial, Wingdings',
      'W\\69 ngdings',
      'WINGDINGS',
      'Webdings, serif',
      '"Wingdings "',
      'fantasy',
      'cursive',
    ];

    for (const value of droppedFonts) {
      it(`drops font-family: ${value} with a value warning and keeps the rule's other declarations`, () => {
        const result = sanitizeBrandingCss(`.x { color: red; font-family: ${value}; }`);

        expect(result.css).not.toContain('font-family');
        expect(result.css).toContain('color: red');
        expect(result.warnings.map((warning) => warning.kind)).toEqual(['value']);
        expect(render(`${KEEP}\n.x{font-family:${value};border-color:rgb(1, 2, 3)}`)).toContain(
          `${KEEP}.x{border-color:rgb(1,2,3)}`,
        );
      });
    }

    const keptFonts = [
      'Arial',
      '"Helvetica Neue", Arial, sans-serif',
      'GEORGIA',
      'system-ui',
      "'Times New Roman', serif",
      '"Inter", sans-serif',
      "'Segoe UI', Roboto, Helvetica, sans-serif",
      'Menlo, Monaco, Consolas, "Courier New", monospace',
      'ui-sans-serif, ui-serif, ui-monospace',
      'Verdana, Tahoma, "Trebuchet MS", "Open Sans", Lato, Garamond, Palatino, Times, Courier',
      // Amendment after the round 19 red run: exactly one CSS-wide keyword is kept.
      'inherit',
      'initial',
      'unset',
      'revert',
      'revert-layer',
    ];

    for (const value of keptFonts) {
      it(`keeps font-family: ${value} with no warning`, () => {
        const result = sanitizeBrandingCss(`.x { font-family: ${value}; }`);

        expect(normalize(result.css)).toContain(`font-family: ${value}`);
        expect(result.warnings).toEqual([]);
        expect(render(`.x{font-family:${value}}`)).toContain(squash(`font-family:${value}`));
      });
    }
  });
  /**
   * Round 20 (C112). A `font-family` value containing a backslash is dropped with a `value` warning,
   * whatever it escapes. Families are split at top-level commas on the raw value; a quoted string is
   * always a family name, so a quoted keyword drops; only an unquoted single keyword is the keyword.
   * C111 is a guard behaviour with no lib surface.
   */
  describe('round 20: font names as Chromium reads them', () => {
    const TOKENS = { primary: '#047857', primaryForeground: '#ffffff' };
    const KEEP = '.keep{background-color:#fff;color:#000}';
    const squash = (css: string) => css.replace(/\s+/g, '');
    const render = (css: string) => squash(renderStoredBrandingCss(css, TOKENS));

    const dropped = [
      'Arial\\,Georgia',
      '"inherit"',
      "'initial'",
      'Ari\\61l',
      '"Ari\\\nal"',
      '"unset"',
      "'revert-layer'",
      'Arial, "inherit"',
      'Arial\\ Black',
      '\\41rial',
    ];

    for (const value of dropped) {
      it(`drops font-family: ${JSON.stringify(value)} with a value warning and keeps the rule's other declarations`, () => {
        const result = sanitizeBrandingCss(`.x { color: red; font-family: ${value}; }`);

        expect(result.css).not.toContain('font-family');
        expect(result.css).toContain('color: red');
        expect(result.warnings.map((warning) => warning.kind)).toEqual(['value']);
        expect(render(`${KEEP}\n.x{font-family:${value};border-color:rgb(1, 2, 3)}`)).toContain(
          `${KEEP}.x{border-color:rgb(1,2,3)}`,
        );
      });
    }

    for (const value of ['inherit', '"Arial"', "'Times New Roman', serif", '"Segoe UI", sans-serif']) {
      it(`keeps font-family: ${value} with no warning`, () => {
        const result = sanitizeBrandingCss(`.x { font-family: ${value}; }`);

        expect(normalize(result.css)).toContain(`font-family: ${value}`);
        expect(result.warnings).toEqual([]);
        expect(render(`.x{font-family:${value}}`)).toContain(squash(`font-family:${value}`));
      });
    }
  });
});
