import { getCertificateStatus } from '@documenso/lib/server-only/cert/cert-status';
import { checkArchive } from '@documenso/lib/server-only/health/archive-filing';
import { checkJobsBackend } from '@documenso/lib/server-only/health/check-jobs-backend';
import {
  changedUnhealthyCheckDetails,
  toPublicHealthChecks,
} from '@documenso/lib/server-only/health/public-health-report';
import { checkWatchHeartbeat } from '@documenso/lib/server-only/health/upstream-watch-heartbeat';
import { logger } from '@documenso/lib/utils/logger';
import { prisma } from '@documenso/prisma';

type CheckStatus = 'ok' | 'warning' | 'error';

export const loader = async () => {
  const checks: {
    database: { status: CheckStatus };
    certificate: { status: CheckStatus };
    jobs: { status: CheckStatus; detail?: string };
    upstreamWatch: { status: CheckStatus; detail?: string; lastRunAt?: string | null; ageHours?: number | null };
    archive: { status: CheckStatus; detail?: string };
  } = {
    database: { status: 'ok' },
    certificate: { status: 'ok' },
    jobs: { status: 'ok' },
    upstreamWatch: { status: 'ok' },
    archive: { status: 'ok' },
  };

  let overallStatus: CheckStatus = 'ok';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.database = { status: 'error' };
    overallStatus = 'error';
  }

  try {
    const certStatus = await getCertificateStatus();

    if (certStatus.isAvailable) {
      checks.certificate = { status: 'ok' };
    } else {
      checks.certificate = { status: 'warning' };

      if (overallStatus === 'ok') {
        overallStatus = 'warning';
      }
    }
  } catch {
    checks.certificate = { status: 'error' };
    overallStatus = 'error';
  }

  // Sealing, reminders and expiry are cron jobs. They need the BullMQ provider
  // and a reachable Redis, and when they do not have one they fail silently:
  // the application keeps accepting signatures and never seals them. Checking
  // it here is what turns that into something a load balancer can see.
  const jobs = await checkJobsBackend();

  checks.jobs = { status: jobs.status, detail: jobs.detail };

  if (jobs.status === 'error') {
    overallStatus = 'error';
  } else if (jobs.status === 'warning' && overallStatus === 'ok') {
    overallStatus = 'warning';
  }

  // How long since the weekly upstream watch last reported. It used to prove
  // itself alive by mailing IT support every week whether or not it had found
  // anything, which made the liveness signal indistinguishable from the alert
  // and produced a ticket a week that nobody needed. The mail now goes out for
  // a finding only, and this is what says the watch is still running.
  //
  // It can raise the overall status no further than warning, by construction:
  // this endpoint answers 500 on error and ECS replaces a task that fails its
  // health check. A watch that stopped a fortnight ago is Monday's problem and
  // must never be able to tear down a working signing service.
  const watch = await checkWatchHeartbeat();

  checks.upstreamWatch = watch;

  if (watch.status === 'warning' && overallStatus === 'ok') {
    overallStatus = 'warning';
  }

  // Whether completed contracts are being filed. The archive is a deliberate
  // no-op when it is unconfigured, and a configured one can fail every upload,
  // so either way an instance that files nothing looks exactly like one that
  // files everything. The check reads the failures the archive records against
  // each document, which is what lets the canary probe and the monitor see it.
  const archive = await checkArchive();

  checks.archive = archive;

  if (archive.status === 'warning' && overallStatus === 'ok') {
    overallStatus = 'warning';
  }

  // The details name hosts, users and open advisories, and this endpoint is
  // public, so they go to the log and the response carries statuses only.
  // Only on a change of status, or the poll logs the same warning forever.
  const details = changedUnhealthyCheckDetails(checks);

  if (Object.keys(details).length > 0) {
    logger.warn({ source: 'health', status: overallStatus, details });
  }

  return Response.json(
    {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks: toPublicHealthChecks(checks),
    },
    { status: overallStatus === 'error' ? 500 : 200 },
  );
};
