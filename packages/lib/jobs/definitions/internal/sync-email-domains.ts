import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const SYNC_EMAIL_DOMAINS_JOB_DEFINITION_ID = 'internal.sync-email-domains';

const SYNC_EMAIL_DOMAINS_JOB_DEFINITION_SCHEMA = z.object({});

export type TSyncEmailDomainsJobDefinition = z.infer<typeof SYNC_EMAIL_DOMAINS_JOB_DEFINITION_SCHEMA>;

export const SYNC_EMAIL_DOMAINS_JOB_DEFINITION = {
  id: SYNC_EMAIL_DOMAINS_JOB_DEFINITION_ID,
  name: 'Sync Email Domains',
  version: '1.0.0',
  trigger: {
    name: SYNC_EMAIL_DOMAINS_JOB_DEFINITION_ID,
    schema: SYNC_EMAIL_DOMAINS_JOB_DEFINITION_SCHEMA,
    cron: '0 * * * *', // Every hour, on the hour.
  },
  // Organisation email domains were removed. The definition stays, disabled, because the
  // hourly scheduler already registered in Redis keeps firing under this id; the job runner
  // skips a disabled definition but throws for a missing one.
  enabled: false,
  handler: async () => {},
} as const satisfies JobDefinition<typeof SYNC_EMAIL_DOMAINS_JOB_DEFINITION_ID, TSyncEmailDomainsJobDefinition>;
