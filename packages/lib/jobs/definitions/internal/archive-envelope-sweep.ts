import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION_ID = 'internal.archive-envelope-sweep';

const ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TArchiveEnvelopeSweepJobDefinition = z.infer<typeof ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION_SCHEMA>;

/**
 * Find completed documents that have not reached the SharePoint contract
 * library and queue them for filing.
 *
 * This is what makes the archive a guarantee rather than a best effort. The
 * completion trigger in `seal-document` is timelier, but an event is lost to a
 * crash between the seal and the enqueue, to a deploy that drops an in-flight
 * job, to a queue eviction, and to a SharePoint outage that outlives the job's
 * retries. Every one of those leaves a contract unfiled with nothing to say so.
 * A sweep is idempotent by construction: it asks the database what is still
 * unfiled, so it cannot miss what an event missed, and running it after a
 * successful event costs one query.
 *
 * This is a cron job, and cron only runs under the BullMQ jobs provider, which
 * requires Redis (see `packages/lib/jobs/client/bullmq.ts`). On the `local`
 * provider the schedule is served by an in-process poller, and on `inngest` it
 * is inert. Deploying this without a provider that runs cron leaves the archive
 * dependent on the completion event alone.
 */
export const ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION = {
  id: ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION_ID,
  name: 'Archive Envelope Sweep',
  version: '1.0.0',
  trigger: {
    name: ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION_ID,
    schema: ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION_SCHEMA,
    // Every 20 minutes, off the quarter hour so it does not queue behind the
    // seal sweep. Filing is an archival copy that nobody is waiting on, so the
    // interval is set by how much Graph traffic is reasonable rather than by
    // how quickly anybody needs the file.
    cron: '7,27,47 * * * *',
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./archive-envelope-sweep.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<typeof ARCHIVE_ENVELOPE_SWEEP_JOB_DEFINITION_ID, TArchiveEnvelopeSweepJobDefinition>;
