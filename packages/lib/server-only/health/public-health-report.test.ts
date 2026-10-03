import { describe, expect, it } from 'vitest';

import { changedUnhealthyCheckDetails, toPublicHealthChecks } from './public-health-report';

const checks = {
  database: { status: 'ok' as const },
  jobs: { status: 'error' as const, detail: 'redis unreachable: NOPERM user sign-app has no access to key x' },
  upstreamWatch: {
    status: 'ok' as const,
    detail: 'the upstream watch ran 3h ago, reporting: [sign watch] 2 security advisories open',
    lastRunAt: '2026-09-14T02:03:11.000Z',
    ageHours: 3,
  },
  archive: { status: 'warning' as const, detail: 'failed with: AADSTS7000215 invalid client secret for tenant t' },
};

describe('toPublicHealthChecks', () => {
  it('keeps statuses and the watch age, and drops every detail', () => {
    expect(toPublicHealthChecks(checks)).toEqual({
      database: { status: 'ok' },
      jobs: { status: 'error' },
      upstreamWatch: { status: 'ok', lastRunAt: '2026-09-14T02:03:11.000Z', ageHours: 3 },
      archive: { status: 'warning' },
    });
  });

  it('leaves no error text or advisory count anywhere in the serialised response', () => {
    const body = JSON.stringify(toPublicHealthChecks(checks));

    expect(body).not.toContain('NOPERM');
    expect(body).not.toContain('AADSTS');
    expect(body).not.toContain('advisories');
  });
});

describe('changedUnhealthyCheckDetails', () => {
  it('logs a non-ok check on first sight and again only when its status changes', () => {
    const seen = new Map();
    const warn = { archive: { status: 'warning' as const, detail: 'archive unconfigured' } };

    expect(changedUnhealthyCheckDetails(warn, seen)).toEqual({ archive: 'archive unconfigured' });
    expect(changedUnhealthyCheckDetails(warn, seen)).toEqual({});

    expect(changedUnhealthyCheckDetails({ archive: { status: 'error', detail: 'down' } }, seen)).toEqual({
      archive: 'down',
    });

    expect(changedUnhealthyCheckDetails({ archive: { status: 'ok' } }, seen)).toEqual({});
    expect(changedUnhealthyCheckDetails(warn, seen)).toEqual({ archive: 'archive unconfigured' });
  });
});
