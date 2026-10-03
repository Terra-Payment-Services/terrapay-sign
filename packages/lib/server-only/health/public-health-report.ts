/**
 * What `/api/health` may tell somebody who has not signed in.
 *
 * The endpoint is unauthenticated, because the load balancer and the canary
 * probe have to reach it, and it used to return each check's `detail` text
 * verbatim. That carried raw Redis and SharePoint error messages, which name
 * hosts, users and key patterns, and the upstream watch's latest subject
 * line, which says how many security advisories are open against this build.
 * None of that helps a probe decide anything. The probe and the remote specs
 * read `status`, and the monitor reads the watch's `status` and `ageHours`.
 *
 * So the response keeps statuses, timestamps and ages, and the detail goes to
 * the server log instead, where whoever is investigating can read it.
 */

export type THealthCheckStatus = 'ok' | 'warning' | 'error';

export type THealthCheck = {
  status: THealthCheckStatus;
  detail?: string;
  lastRunAt?: string | null;
  ageHours?: number | null;
};

export type TPublicHealthCheck = Omit<THealthCheck, 'detail'>;

/**
 * @param checks - Every check as the health route computed it.
 * @returns The same checks with nothing but status, `lastRunAt` and `ageHours`.
 */
export const toPublicHealthChecks = <T extends Record<string, THealthCheck>>(
  checks: T,
): { [K in keyof T]: TPublicHealthCheck } => {
  const entries = Object.entries(checks).map(([name, check]) => {
    const publicCheck: TPublicHealthCheck = { status: check.status };

    if (check.lastRunAt !== undefined) {
      publicCheck.lastRunAt = check.lastRunAt;
    }

    if (check.ageHours !== undefined) {
      publicCheck.ageHours = check.ageHours;
    }

    return [name, publicCheck];
  });

  return Object.fromEntries(entries) as { [K in keyof T]: TPublicHealthCheck };
};

const lastStatuses = new Map<string, THealthCheckStatus>();

/**
 * The detail of every check that is not ok and whose status has changed since
 * this process last evaluated it, including the first evaluation.
 *
 * The load balancer polls health every few seconds, and a steady warning (an
 * unconfigured archive, a watch yet to run) would otherwise be logged on every
 * poll. Remembering each check's last status, ok included, means a check that
 * goes ok, then warning, is logged again when it degrades.
 *
 * @param seen - Last status per check name. The module's own map unless a test supplies one.
 * @returns An empty object when there is nothing new to log.
 */
export const changedUnhealthyCheckDetails = (
  checks: Record<string, THealthCheck>,
  seen: Map<string, THealthCheckStatus> = lastStatuses,
): Record<string, string> => {
  const details: Record<string, string> = {};

  for (const [name, check] of Object.entries(checks)) {
    const previous = seen.get(name);

    seen.set(name, check.status);

    if (check.status !== 'ok' && check.status !== previous) {
      details[name] = check.detail ?? 'no detail';
    }
  }

  return details;
};
