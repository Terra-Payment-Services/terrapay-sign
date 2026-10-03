import { describe, expect, it } from 'vitest';

import { redactPathTokens } from './redact-path-tokens';

const TOKEN = 'Xq7_secretRecipientToken';

describe('redactPathTokens', () => {
  it.each([
    [`/sign/${TOKEN}`, '/sign/[redacted]'],
    [`/sign/${TOKEN}/complete`, '/sign/[redacted]/complete'],
    [`/sign/${TOKEN}.data`, '/sign/[redacted]'],
    [`/d/${TOKEN}`, '/d/[redacted]'],
    [`/report/${TOKEN}`, '/report/[redacted]'],
    [`/embed/sign/${TOKEN}`, '/embed/sign/[redacted]'],
    [`/embed/direct/${TOKEN}`, '/embed/direct/[redacted]'],
    [`/api/files/token/${TOKEN}/envelopeItem/item_1`, '/api/files/token/[redacted]/envelopeItem/item_1'],
    [`/verify-email/${TOKEN}`, '/verify-email/[redacted]'],
    [`/reset-password/${TOKEN}`, '/reset-password/[redacted]'],
    [`/organisation/invite/${TOKEN}`, '/organisation/invite/[redacted]'],
    [`/organisation/decline/${TOKEN}`, '/organisation/decline/[redacted]'],
    [`/team/verify/email/${TOKEN}`, '/team/verify/email/[redacted]'],
  ])('keeps the token in %s out of the log', (path, expected) => {
    const redacted = redactPathTokens(path);

    expect(redacted).toBe(expected);
    expect(redacted).not.toContain(TOKEN);
  });

  it.each([
    '/signin',
    '/signup',
    '/dashboard',
    '/documents',
    '/api/trpc/envelope.get',
    '/sign',
    '/t/team/documents/42',
  ])('leaves %s alone', (path) => {
    expect(redactPathTokens(path)).toBe(path);
  });
});
