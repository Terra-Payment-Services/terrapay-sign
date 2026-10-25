import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BrandingProvider } from '../../email/providers/branding';
import { TemplateBrandingLogo } from '../../email/template-components/template-branding-logo';
import { TemplateFooter } from '../../email/template-components/template-footer';

// The email package compiles JSX with the classic runtime, which needs React in scope.
(globalThis as { React?: typeof React }).React = React;

const REFUSED = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'javascript&colon;alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'ftp://example.com',
  '//evil.example',
  '/relative/path',
  'example.com',
  'http:/example.com',
  'https://',
  '%6A%61%76%61script:alert(1)',
  'https:\\\\evil.example',
  '\\\\evil.example',
  'https:/\\\\evil.example',
  'java\nscript:alert(1)',
  '\u0000javascript:alert(1)',
  'javascript\u0000:alert(1)',
  'ｊａｖａｓｃｒｉｐｔ:alert(1)',
  'https：//evil.example',
];

describe('C5: renderers still drop an unsafe stored value', () => {
  const branding = (brandingUrl: string) => ({
    brandingEnabled: true,
    brandingUrl,
    brandingLogo: 'https://example.com/logo.png',
    brandingCompanyDetails: '',
    brandingHidePoweredBy: false,
  });

  const render = (brandingUrl: string, child: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(
      // biome-ignore lint/correctness/noChildrenProp: the provider's props type requires children, so they cannot go in the third argument.
      createElement(BrandingProvider, { branding: branding(brandingUrl), children: child }),
    );

  // The WHATWG parser would repair http:/example.com to http://example.com/. The renderer delegates to the shared
  // validator (spec Amendment 1), so it refuses that value and renders no link, like every other unsafe value.
  for (const value of REFUSED) {
    it(`footer and logo render no link for ${JSON.stringify(value)}`, () => {
      const footer = render(value, createElement(TemplateFooter, { isDocument: false }));
      const logo = render(value, createElement(TemplateBrandingLogo, { assetBaseUrl: 'https://example.com' }));

      expect(footer).not.toMatch(/<a\b[^>]*href=/i);
      expect(logo).not.toMatch(/<a\b[^>]*href=/i);
    });
  }

  it('footer and logo still link a safe value', () => {
    const footer = render('https://example.com', createElement(TemplateFooter, { isDocument: false }));
    const logo = render(
      'https://example.com',
      createElement(TemplateBrandingLogo, { assetBaseUrl: 'https://example.com' }),
    );

    expect(footer).toContain('href="https://example.com/"');
    expect(logo).toContain('href="https://example.com/"');
  });
});
