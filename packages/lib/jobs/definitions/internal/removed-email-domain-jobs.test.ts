import { describe, expect, it, vi } from 'vitest';

import type { JobDefinition } from '../../client/_internal/job';
import { SYNC_EMAIL_DOMAINS_JOB_DEFINITION } from './sync-email-domains';

/**
 * Organisation email domains were removed, but the hourly scheduler for this job is already
 * in Redis and keeps firing. The job runner throws for an id with no definition and skips one
 * marked disabled, so the id must stay registered and disabled until the stub is retired.
 */

const registered = vi.hoisted(() => ({ definitions: [] as JobDefinition[] }));

vi.mock('../../client/client', () => ({
  JobClient: function JobClient(definitions: JobDefinition[]) {
    registered.definitions = definitions;
  },
}));

const ID = 'internal.sync-email-domains';

describe('removed email domain jobs', () => {
  it(`${ID} is still registered with the job client`, async () => {
    await import('../../client');

    expect(registered.definitions.map((definition) => definition.id)).toContain(ID);
  });

  it(`${ID} is disabled, keeps its hourly cron and does nothing when run`, async () => {
    expect(SYNC_EMAIL_DOMAINS_JOB_DEFINITION.id).toBe(ID);
    expect(SYNC_EMAIL_DOMAINS_JOB_DEFINITION.trigger.name).toBe(ID);
    expect(SYNC_EMAIL_DOMAINS_JOB_DEFINITION.trigger.cron).toBe('0 * * * *');
    expect(SYNC_EMAIL_DOMAINS_JOB_DEFINITION.enabled).toBe(false);

    await expect(SYNC_EMAIL_DOMAINS_JOB_DEFINITION.handler()).resolves.toBeUndefined();
  });
});
