import { describe, expect, it, vi } from 'vitest';

import type { JobDefinition } from '../../client/_internal/job';
import { ALERT_ORGANISATION_SEAT_DRIFT_JOB_DEFINITION } from './alert-organisation-seat-drift';
import { CANCEL_ORGANISATION_SUBSCRIPTION_JOB_DEFINITION } from './cancel-organisation-subscription';
import { SYNC_ORGANISATION_SEATS_JOB_DEFINITION } from './sync-organisation-seats';

/**
 * Stripe billing was removed, but jobs may still sit in the queue under these ids. The job
 * runner throws for an id with no definition and skips one marked disabled, so each id must
 * stay registered and disabled until the stubs are retired.
 */

const registered = vi.hoisted(() => ({ definitions: [] as JobDefinition[] }));

vi.mock('../../client/client', () => ({
  JobClient: function JobClient(definitions: JobDefinition[]) {
    registered.definitions = definitions;
  },
}));

const stubs = [
  ['internal.sync-organisation-seats', SYNC_ORGANISATION_SEATS_JOB_DEFINITION],
  ['internal.cancel-organisation-subscription', CANCEL_ORGANISATION_SUBSCRIPTION_JOB_DEFINITION],
  ['internal.alert-organisation-seat-drift', ALERT_ORGANISATION_SEAT_DRIFT_JOB_DEFINITION],
] as const;

describe('removed billing jobs', () => {
  it.each(stubs)('%s is still registered with the job client', async (id) => {
    await import('../../client');

    expect(registered.definitions.map((definition) => definition.id)).toContain(id);
  });

  it.each(stubs)('%s is disabled and does nothing when run', async (id, definition) => {
    expect(definition.id).toBe(id);
    expect(definition.trigger.name).toBe(id);
    expect(definition.enabled).toBe(false);

    await expect(definition.handler()).resolves.toBeUndefined();
  });
});
