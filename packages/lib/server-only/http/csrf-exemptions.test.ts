import { describe, expect, it } from 'vitest';

import { isCsrfExemptRequest } from './csrf-exemptions';

/**
 * The same-origin guard runs in front of every route. These are the only
 * requests it must wave through, because machines that authenticate some
 * other way send them.
 */
describe('isCsrfExemptRequest', () => {
  it.each([
    '/api/v1/documents',
    '/api/jobs/send.signing.email',
    '/api/webhook/trigger',
    '/api/upstream-watch/heartbeat',
  ])('exempts %s', (path) => {
    expect(isCsrfExemptRequest({ path, hasAuthorizationHeader: false })).toBe(true);
  });

  it.each(['/api/v2/envelope/create', '/api/v2-beta/document/create'])('exempts %s when it carries a token', (path) => {
    expect(isCsrfExemptRequest({ path, hasAuthorizationHeader: true })).toBe(true);
  });

  it.each([
    '/api/v2/envelope/create',
    '/api/v2-beta/document/create',
  ])('guards %s when it would fall back to the session cookie', (path) => {
    expect(isCsrfExemptRequest({ path, hasAuthorizationHeader: false })).toBe(false);
  });

  it.each([
    '/api/trpc/team.update',
    '/api/auth/signout',
    '/api/files/upload-pdf',
    '/api/theme',
    '/api/locale',
    '/api/preferred-team',
    '/sign/abc',
  ])('guards %s even with an Authorization header', (path) => {
    expect(isCsrfExemptRequest({ path, hasAuthorizationHeader: true })).toBe(false);
  });
});
