import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION_ID = 'internal.reconcile-directory-access';

const RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION_SCHEMA = z.object({});

export type TReconcileDirectoryAccessJobDefinition = z.infer<typeof RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION_SCHEMA>;

/**
 * Disable Documenso accounts for people who have left the Microsoft Entra ID
 * directory.
 *
 * There is no SCIM endpoint, so offboarding someone in Entra leaves their
 * Documenso account active until somebody remembers to disable it. This job
 * closes that window by asking Microsoft Graph who is entitled and disabling
 * enabled non-admin accounts whose email address is no longer among them. The
 * entitled set is the transitive membership of the access group when one is
 * configured, and otherwise every enabled member (non-guest) user in the tenant.
 *
 * This is a cron job, and cron only runs under the BullMQ jobs provider, which
 * requires Redis (see `packages/lib/jobs/client/bullmq.ts`). On the `local` or
 * `inngest` providers the schedule below is inert and nothing reconciles.
 * Deploying this without `NEXT_PRIVATE_JOBS_PROVIDER=bullmq` and a reachable
 * `NEXT_PRIVATE_REDIS_URL` gets you a job that never runs.
 *
 * The job is also inert until the three Entra credential variables are set, and it
 * runs in dry run until `NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN` is set to the
 * exact string `false`.
 */
export const RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION = {
  id: RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION_ID,
  name: 'Reconcile Directory Access',
  version: '1.0.0',
  trigger: {
    name: RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION_ID,
    schema: RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION_SCHEMA,
    // Hourly, off the quarter-hour so it does not queue behind the sweeps.
    // Offboarding tolerates an hour; a tighter schedule buys little and puts
    // more load on Graph.
    cron: '35 * * * *',
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./reconcile-directory-access.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof RECONCILE_DIRECTORY_ACCESS_JOB_DEFINITION_ID,
  TReconcileDirectoryAccessJobDefinition
>;
