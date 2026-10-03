import { env } from '../../utils/env';
import { getRedisClient, withTimeout } from './redis-client';

export type JobsBackendCheck = {
  status: 'ok' | 'warning' | 'error';
  detail: string;
};

/**
 * Check that the background job backend is actually able to run.
 *
 * This exists because the failure it detects is silent. Document sealing,
 * signing reminders and recipient expiry are all cron jobs, and cron only runs
 * under the BullMQ provider, which needs Redis. Configure the provider without
 * Redis, or lose Redis later, and the application keeps serving pages and
 * accepting signatures while quietly never sealing any of them. Nothing in the
 * user interface says so.
 *
 * Reported as an error only when the deployment has asked for BullMQ and Redis
 * cannot be reached, because that is a broken deployment rather than a choice.
 * Running without BullMQ is a legitimate local configuration, so that is a
 * warning: correct for a laptop, wrong for production.
 */
export const checkJobsBackend = async (): Promise<JobsBackendCheck> => {
  const provider = env('NEXT_PRIVATE_JOBS_PROVIDER');

  if (provider !== 'bullmq') {
    return {
      status: 'warning',
      detail:
        `jobs provider is "${provider ?? 'local'}", so scheduled work does not run. ` +
        'Document sealing, reminders and expiry need NEXT_PRIVATE_JOBS_PROVIDER=bullmq.',
    };
  }

  const redis = await getRedisClient();

  if (!redis) {
    return {
      status: 'error',
      detail: 'NEXT_PRIVATE_JOBS_PROVIDER is bullmq but NEXT_PRIVATE_REDIS_URL is not set',
    };
  }

  try {
    const pong = await withTimeout(redis.ping());

    if (pong !== 'PONG') {
      return { status: 'error', detail: `redis answered "${pong}" rather than PONG` };
    }

    return { status: 'ok', detail: 'bullmq provider, redis reachable' };
  } catch (error) {
    return {
      status: 'error',
      detail: `redis unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
