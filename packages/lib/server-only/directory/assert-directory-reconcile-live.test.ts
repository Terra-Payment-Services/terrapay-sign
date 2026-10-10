import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENTRA_RECONCILE_EXEMPT_EMAILS,
  ENTRA_RECONCILE_MAX_DISABLE_RATIO,
  ENTRA_RECONCILE_MINIMUM_MEMBERS,
} from '../../constants/app';
import { assertDirectoryReconcileIsLive } from './assert-directory-reconcile-live';

const LIVE = {
  NODE_ENV: 'production',
  NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq',
  NEXT_PRIVATE_ENTRA_TENANT_ID: 'tenant',
  NEXT_PRIVATE_ENTRA_CLIENT_ID: 'client',
  NEXT_PRIVATE_ENTRA_CLIENT_SECRET: 'secret',
  NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN: 'false',
  NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS: '700',
};

describe('a production server', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED', '');

    for (const [key, value] of Object.entries(LIVE)) {
      vi.stubEnv(key, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts when the reconcile will disable leavers', () => {
    expect(() => assertDirectoryReconcileIsLive()).not.toThrow();
  });

  it.each([
    ['the reconcile is still in dry run', 'NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN', 'true'],
    ['dry run is left unset, which means on', 'NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN', ''],
    ['cron cannot fire outside BullMQ', 'NEXT_PRIVATE_JOBS_PROVIDER', 'local'],
    ['the Entra secret is missing', 'NEXT_PRIVATE_ENTRA_CLIENT_SECRET', ''],
    ['the minimum membership is left at its default', 'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', ''],
    ['the minimum membership is zero', 'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '0'],
    ['the minimum membership is only whitespace', 'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '   '],
    ['the minimum membership is not a number', 'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', 'garbage'],
    ['the minimum membership is fractional', 'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '700.5'],
    ['the minimum membership is negative', 'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '-700'],
    [
      'the minimum membership is beyond exact integers',
      'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS',
      '9007199254740993',
    ],
    [
      'the minimum membership is too long to be a number',
      'NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS',
      '9'.repeat(400),
    ],
    ['the disable ratio is infinite', 'NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', 'Infinity'],
    ['the disable ratio is hexadecimal', 'NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '0x0'],
    ['the disable ratio is zero', 'NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '0'],
    ['the disable ratio would allow most accounts to go', 'NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '0.6'],
    ['the disable ratio is not a number', 'NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', 'garbage'],
    ['the disable ratio is only whitespace', 'NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '  '],
  ])('refuses to start when %s', (_reason, key, value) => {
    vi.stubEnv(key, value);

    expect(() => assertDirectoryReconcileIsLive()).toThrow(new RegExp(`Refusing to start.*${key}`));
  });

  it('starts with a disable ratio at the upper bound of one half', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '0.5');

    expect(() => assertDirectoryReconcileIsLive()).not.toThrow();
  });
});

describe('the thresholds the reconcile job reads', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the defaults when nothing is set', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '');
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '');

    expect(ENTRA_RECONCILE_MINIMUM_MEMBERS()).toBe(10);
    expect(ENTRA_RECONCILE_MAX_DISABLE_RATIO()).toBe(0.1);
  });

  it('uses the configured figures', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '700');
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '0.05');

    expect(ENTRA_RECONCILE_MINIMUM_MEMBERS()).toBe(700);
    expect(ENTRA_RECONCILE_MAX_DISABLE_RATIO()).toBe(0.05);
  });

  it('accepts the largest exact integer as a minimum', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '9007199254740991');

    expect(ENTRA_RECONCILE_MINIMUM_MEMBERS()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses a minimum too long to be a number rather than reading it as infinity', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', '9'.repeat(400));

    expect(() => ENTRA_RECONCILE_MINIMUM_MEMBERS()).toThrow('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS');
  });

  it('refuses a minimum it cannot read rather than falling back to ten', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS', 'garbage');

    expect(() => ENTRA_RECONCILE_MINIMUM_MEMBERS()).toThrow('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS');
  });

  it('refuses a disable ratio out of bounds rather than falling back to a tenth', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO', '0.9');

    expect(() => ENTRA_RECONCILE_MAX_DISABLE_RATIO()).toThrow('NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO');
  });

  it('reads the exempt addresses as a comma separated list, ignoring case and blanks', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_EXEMPT_EMAILS', ' Scanner@Example.com, ,ops-bot@example.com ');

    expect(ENTRA_RECONCILE_EXEMPT_EMAILS()).toEqual(['scanner@example.com', 'ops-bot@example.com']);
  });

  it('exempts nobody when the list is unset', () => {
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_EXEMPT_EMAILS', '');

    expect(ENTRA_RECONCILE_EXEMPT_EMAILS()).toEqual([]);
  });
});

describe('a production build run outside a deployment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts when it declares the reconcile not required', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED', 'true');
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN', '');

    expect(() => assertDirectoryReconcileIsLive()).not.toThrow();
  });
});

describe('a development server', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts without any reconcile configuration', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN', '');

    expect(() => assertDirectoryReconcileIsLive()).not.toThrow();
  });
});
