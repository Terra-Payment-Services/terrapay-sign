import { describe, expect, it } from 'vitest';

import { sanitizeBrandingCss } from './sanitize-branding-css';

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

    it('keeps ::selection verbatim', () => {
      const result = sanitizeBrandingCss('p::selection { background: yellow; }');

      expect(normalize(result.css)).toBe('p::selection { background: yellow; }');
      expect(result.warnings).toEqual([]);
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
      ['border', '1px solid black'],
      ['border-radius', '4px'],
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

    it('preserves benign < not followed by /', () => {
      // `<script>` (no slash) is not a tag close; PostCSS leaves it as text
      // and the HTML parser treats it as text inside <style> rawtext mode.
      const result = sanitizeBrandingCss('.x { font-family: "<script>alert(1)</script>"; }');

      // The output keeps the literal `<script>` (harmless) but escapes the
      // `</script>` end tag's `<` for the same reason it'd escape `</style>`.
      expect(result.css).toContain('<script>');
      expect(result.css.toLowerCase()).not.toContain('</style');
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
      ['.btn { color: #123456; border-radius: 4px }', ['.btn', 'color: #123456', 'border-radius: 4px']],
      ['@media (max-width: 600px) { .btn { color: red } }', ['@media (max-width: 600px)', '.btn', 'color: red']],
      ['.btn:hover { background-color: rgb(1 2 3) }', ['.btn:hover', 'background-color: rgb(1 2 3)']],
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

    /**
     * The sanitiser keeps an allowlist of branding properties (colours,
     * backgrounds, borders, outlines, fonts) and checks values token by token.
     *
     * Bounds these tests choose: a border or outline width of at most 16px (or 1em) is kept;
     * anything wider is refused, since it can paint over the page. Large border-radius
     * values are harmless and are not asserted either way.
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
          'border: 2px solid #333',
          'border: 16px solid #333',
          'border-width: 1em',
          'border-radius: 8px',
          'border-radius: 50%',
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
          'border: 1px solid black',
          'border-color: #ccc',
          'border-radius: 4px',
          'outline: 2px solid red',
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
});
