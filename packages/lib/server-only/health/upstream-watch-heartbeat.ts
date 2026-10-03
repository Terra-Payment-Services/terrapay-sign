import { redisKeyPrefix } from '../../utils/redis-connection';
import { getRedisClient, withTimeout } from './redis-client';

export type WatchHeartbeat = {
  /** When the watch last finished a run, as an ISO 8601 instant. */
  at: string;
  /** Whether that run's checks all completed. */
  ok: boolean;
  /** The subject line it produced, so the check can say what it found. */
  subject?: string;
};

export type WatchHeartbeatCheck = {
  status: 'ok' | 'warning';
  detail: string;
  lastRunAt: string | null;
  ageHours: number | null;
};

/**
 * Where the heartbeat lives, under the same namespace as everything else.
 *
 * It was an unprefixed `upstream-watch:last-run` until 2026-09-22, when the
 * deployed health endpoint answered `NOPERM No permissions to access a key`:
 * the shared cache scopes our user to one key pattern, and this key fell
 * outside it. Reading it is what turned a silent hole into a visible one.
 */
const key = (): string => `${redisKeyPrefix()}:upstream-watch:last-run`;

/**
 * The watch runs weekly, early on Monday, Dubai time. A run that has not
 * arrived within nine days has missed its slot by more than a day, which is
 * long enough to be a fault rather than a late runner.
 */
const STALE_AFTER_HOURS = 9 * 24;

/**
 * Record that the upstream watch completed a run.
 *
 * The watch runs in CI on a build runner and the application runs on Fargate,
 * so they share no database. Redis is the one thing both can reach, and the
 * heartbeat is a single key with no history: the question being answered is
 * "has it run lately", and everything else is already in the job log, the
 * ninety day artifact and any issue the run raised.
 */
export const recordWatchHeartbeat = async (heartbeat: WatchHeartbeat): Promise<void> => {
  const redis = await getRedisClient();

  if (!redis) {
    throw new Error('NEXT_PRIVATE_REDIS_URL is not set, so the watch heartbeat cannot be recorded');
  }

  await withTimeout(redis.set(key(), JSON.stringify(heartbeat)));
};

/**
 * Report how long it has been since the upstream watch last ran.
 *
 * Never an error, always at worst a warning, and the reason is worth being
 * plain about. The health endpoint answers 500 on `error`, and ECS replaces a
 * task whose health check fails. A watch that has stopped reporting is a thing
 * somebody should look at on Monday; it is not a reason to tear down a running
 * signing service and it must never be able to. The monitor alerts on this
 * check's own status and `ageHours`, not on the HTTP status code.
 */
export const checkWatchHeartbeat = async (): Promise<WatchHeartbeatCheck> => {
  // Every path inside, including acquiring the client, is inside the try. An
  // earlier version called getRedisClient() outside it, so a failed dynamic
  // import or a malformed NEXT_PRIVATE_REDIS_URL made this function reject
  // rather than return. /api/health has no try around the call, so Remix
  // answered 500 and ECS replaced the task. A watch that stopped reporting
  // would have taken down a working signing service, which is the one thing
  // this check is written never to do.
  try {
    const redis = await getRedisClient();

    if (!redis) {
      return {
        status: 'warning',
        detail: 'no redis configured, so the upstream watch heartbeat cannot be read',
        lastRunAt: null,
        ageHours: null,
      };
    }

    const heartbeat = parse(await withTimeout(redis.get(key())));

    if (!heartbeat) {
      return {
        status: 'warning',
        // Expected on a freshly deployed service, until the first Monday.
        detail: 'the upstream watch has not reported a run yet',
        lastRunAt: null,
        ageHours: null,
      };
    }

    const ageHours = Math.round((Date.now() - Date.parse(heartbeat.at)) / 3_600_000);

    if (ageHours > STALE_AFTER_HOURS) {
      return {
        status: 'warning',
        detail: `the upstream watch last ran ${Math.floor(ageHours / 24)} days ago; it is scheduled weekly`,
        lastRunAt: heartbeat.at,
        ageHours,
      };
    }

    const found = heartbeat.subject ? `, reporting: ${heartbeat.subject}` : '';

    return {
      status: heartbeat.ok ? 'ok' : 'warning',
      detail: heartbeat.ok
        ? `the upstream watch ran ${ageHours}h ago${found}`
        : `the upstream watch ran ${ageHours}h ago but some of its checks failed${found}`,
      lastRunAt: heartbeat.at,
      ageHours,
    };
  } catch (error) {
    return {
      status: 'warning',
      detail: `could not read the watch heartbeat: ${error instanceof Error ? error.message : String(error)}`,
      lastRunAt: null,
      ageHours: null,
    };
  }
};

/**
 * @param raw - Whatever was in Redis, which may be nothing or may be rubbish.
 * @returns The heartbeat, or null when it cannot be trusted.
 */
const parse = (raw: string | null): WatchHeartbeat | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const { at, ok, subject } = parsed as Record<string, unknown>;

    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      return null;
    }

    return { at, ok: ok === true, subject: typeof subject === 'string' ? subject : undefined };
  } catch {
    return null;
  }
};
