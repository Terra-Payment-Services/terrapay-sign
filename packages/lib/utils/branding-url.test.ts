import { describe, expect, it } from 'vitest';

import { getSafeBrandingUrl } from '../../email/utils/branding-url';
// The shared validator the fix must create (#155). It does not exist yet, so this import fails.
import { isSafeBrandingUrl, ZBrandingUrlSchema } from './branding-url';

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

const ACCEPTED = [
  'https://example.com',
  'http://example.com/path?q=1#frag',
  'HTTPS://EXAMPLE.COM',
  'https://xn--bcher-kva.example/',
];

// C7: no value with a control character or whitespace, so the parser never removes characters the admin typed.
const CONTROL_REFUSED = [
  'https://example.com\t.evil.com',
  'https://example.com\r.evil.com',
  'https://example.com\n.evil.com',
  'https://example.com\u0000.evil.com',
  'https://example.com/pa\tth',
  'https://example.com/pa\rth',
  'https://example.com/pa\nth',
  'https://example.com/pa\u0000th',
  'https://example.com\t',
  'https://example.com\r',
  'https://example.com\n',
  'https://example.com\u0000',
  'https://exam ple.com',
  'https://example.com ',
];

// C8: no username or password in the URL.
const USERINFO_REFUSED = [
  'https://trusted.com@evil.com',
  'https://user:pass@example.com',
  'https://@example.com',
  'https://user@evil.example',
];

// C9 and C14: ASCII hosts only. Each expected hostname is the typed host lower-cased, written out by hand.
const ACCEPTED_HOSTS: Array<{ input: string; hostname: string; port?: string }> = [
  { input: 'https://example.com', hostname: 'example.com' },
  { input: 'HTTPS://EXAMPLE.COM', hostname: 'example.com' },
  { input: 'https://xn--bcher-kva.example/', hostname: 'xn--bcher-kva.example' },
  { input: 'http://example.com/path?q=1#frag', hostname: 'example.com' },
  { input: 'https://example.com:8443/', hostname: 'example.com', port: '8443' },
  { input: 'https://example.com/u/@name', hostname: 'example.com' },
  { input: 'https://example.com/?a=@b', hostname: 'example.com' },
  { input: 'https://example.com/#@x', hostname: 'example.com' },
];

// C7 amended: Unicode White_Space, Cc and Cf characters, in the path and in the host.
const UNICODE_SPACES: Array<[string, string]> = [
  ['U+0085', '\u0085'],
  ['U+00A0', '\u00a0'],
  ['U+2028', '\u2028'],
  ['U+200B', '\u200b'],
  ['U+FEFF', '\ufeff'],
];

const UNICODE_SPACE_REFUSED = UNICODE_SPACES.flatMap(([, character]) => [
  `https://example.com/pa${character}th`,
  `https://exam${character}ple.com`,
]);

// C10: the host as typed must be dotted Unicode letter, digit and hyphen labels.
const HOST_REFUSED = [
  'https://%65vil.com',
  'https://127.1',
  'https://2130706433',
  'https://0x7f000001',
  'https://1.0x7f',
  'https://127.0.0.1',
  'https://[::1]',
  'https://localhost',
  'https://example.com\u200b.evil.com',
];

// C11: a port is a colon and 1 to 5 digits.
const PORT_REFUSED = ['https://example.com:', 'https://example.com:99999'];

// C12: a backslash anywhere is refused.
const BACKSLASH_REFUSED = ['https://example.com\\evil.com', 'https://example.com\\path@someone'];

// C13: no IDNA remapping. Labels that IDNA maps to a different label are refused.
const IDNA_REMAPPING_REFUSED = [
  'https://ｅｖｉｌ.com',
  'https://ＥＶＩＬ.com',
  'https://xn--ｅvil.com',
  'https://ﬁle.com',
  'https://éxample.com',
];

// C14 (amendment 4): the host is ASCII only. IDNA can substitute or drop characters that survive NFKC,
// so an internationalised domain is entered in its xn-- form. Escapes keep each character unambiguous.
const NON_ASCII_HOST_REFUSED = [
  'https://b\u00fccher.example',
  'https://\u00df.de',
  'https://a\u0345.de',
  'https://a\u034f\u00df.de',
  'https://b\u00fc\ufe0fcher.example',
  'https://www.terrapay.com.',
];

const expectRefused = (value: string) => {
  expect(isSafeBrandingUrl(value)).toBe(false);
  expect(ZBrandingUrlSchema.safeParse(value).success).toBe(false);
  expect(getSafeBrandingUrl(value)).toBeNull();
};

describe('C7 amended: Unicode whitespace and format characters', () => {
  for (const value of UNICODE_SPACE_REFUSED) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expectRefused(value);
    });
  }
});

describe('C10: typed host allowlist', () => {
  for (const value of HOST_REFUSED) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expectRefused(value);
    });
  }
});

describe('C11: port', () => {
  for (const value of PORT_REFUSED) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expectRefused(value);
    });
  }
});

describe('C12: no backslash', () => {
  for (const value of BACKSLASH_REFUSED) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expectRefused(value);
    });
  }
});

describe('C13: no IDNA remapping', () => {
  for (const value of IDNA_REMAPPING_REFUSED) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expectRefused(value);
    });
  }
});

describe('C14: ASCII host only', () => {
  for (const value of NON_ASCII_HOST_REFUSED) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expectRefused(value);
    });
  }
});

describe('C9 amended: rendered host equals typed host', () => {
  for (const { input, hostname, port } of ACCEPTED_HOSTS) {
    it(`renders ${JSON.stringify(input)} to host ${hostname}${port ? ` port ${port}` : ''}`, () => {
      const rendered = getSafeBrandingUrl(input);

      expect(rendered).not.toBeNull();

      const renderedUrl = new URL(rendered as string);

      expect(['http:', 'https:']).toContain(renderedUrl.protocol);
      expect(hostname).toMatch(/^[a-z0-9.:-]+$/);
      expect(renderedUrl.hostname).toBe(hostname);

      if (port) {
        expect(renderedUrl.port).toBe(port);
      }
    });
  }
});

describe('C7 and C8: no parser repair and no userinfo', () => {
  for (const value of [...CONTROL_REFUSED, ...USERINFO_REFUSED]) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expect(isSafeBrandingUrl(value)).toBe(false);
      expect(ZBrandingUrlSchema.safeParse(value).success).toBe(false);
      expect(getSafeBrandingUrl(value)).toBeNull();
    });
  }
});

describe('C4: one rule for save and render', () => {
  for (const value of REFUSED) {
    it(`refuses ${JSON.stringify(value)} at save and renders null`, () => {
      expect(isSafeBrandingUrl(value)).toBe(false);
      expect(ZBrandingUrlSchema.safeParse(value).success).toBe(false);
      expect(getSafeBrandingUrl(value)).toBeNull();
    });
  }

  for (const value of ACCEPTED) {
    it(`accepts ${JSON.stringify(value)} at save and renders non-null`, () => {
      expect(isSafeBrandingUrl(value)).toBe(true);
      expect(ZBrandingUrlSchema.safeParse(value).success).toBe(true);
      expect(getSafeBrandingUrl(value)).not.toBeNull();
    });
  }

  it('accepts the empty string', () => {
    expect(ZBrandingUrlSchema.safeParse('').success).toBe(true);
  });
});
