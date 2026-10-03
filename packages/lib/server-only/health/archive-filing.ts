import { getSharePointArchiveConfig } from '../archive/sharepoint-archive-config';

export type ArchiveCheck = {
  status: 'ok' | 'warning';
  detail: string;
};

/**
 * What the archive has recorded about documents it keeps failing to file.
 */
export type ArchiveFailures = {
  /** Unfiled documents whose last attempt failed and which have been tried at least the minimum. */
  failing: number;
  /** The most recently attempted of them, or null when there are none. */
  latest: { lastError: string; attempts: number; at: Date } | null;
};

/**
 * Attempts a document must have failed before the check warns.
 *
 * One failure is not a fault: Graph throttles, and the next sweep twenty
 * minutes later usually files the document. A second failure of the same
 * document is, so a broken archive shows here within about forty minutes.
 */
export const FAILED_ATTEMPTS_BEFORE_WARNING = 2;

/**
 * Read the failures from the archive's own records. Two indexed queries on a
 * table that holds one row per document the archive has tried to file, so it is cheap enough for every
 * load balancer probe and it never calls Graph.
 *
 * Documents of deleted envelopes are left out, because the sweep leaves them
 * out too and nothing would ever clear their warning.
 */
const readFailuresFromDatabase = async (minAttempts: number): Promise<ArchiveFailures> => {
  const { prisma } = await import('@documenso/prisma');

  const where = {
    archivedAt: null,
    lastError: { not: null },
    attempts: { gte: minAttempts },
    envelope: { deletedAt: null },
  };

  const [failing, latest] = await Promise.all([
    prisma.envelopeArchive.count({ where }),
    prisma.envelopeArchive.findFirst({
      where,
      orderBy: { updatedAt: 'desc' },
      select: { lastError: true, attempts: true, updatedAt: true },
    }),
  ]);

  return {
    failing,
    latest: latest ? { lastError: latest.lastError ?? '', attempts: latest.attempts, at: latest.updatedAt } : null,
  };
};

/**
 * Whether the SharePoint contract archive is filing completed contracts.
 *
 * Until 2026-09-25 this asked only whether the five settings were present, and
 * for two days it answered ok while every upload failed with a Graph 403,
 * because the service authenticated as a registration with no grant on the
 * site. Settings being present says nothing about whether filing works. The
 * archive already records every attempt and its failure against the document,
 * so the check now reads that.
 *
 * An unconfigured archive is still a warning: it is a deliberate no-op so that
 * a missing setting can never interfere with signing, and an instance that
 * files nothing would otherwise look healthy.
 *
 * Warning rather than error, on purpose and for the same reason as the watch
 * heartbeat: /api/health answers 500 on error and ECS replaces a task that
 * fails its health check. An archive that cannot file is a thing to fix on
 * Monday. It must never tear down a running signing service, so a failure to
 * read the records is a warning as well and this function never rejects.
 *
 * @param readFailures - Source of the recorded failures; the database unless a test supplies one.
 * @returns Whether the archive is filing, and why not if it is not.
 */
export const checkArchive = async (
  readFailures: (minAttempts: number) => Promise<ArchiveFailures> = readFailuresFromDatabase,
): Promise<ArchiveCheck> => {
  if (!getSharePointArchiveConfig()) {
    return {
      status: 'warning',
      detail:
        'the SharePoint contract archive is not configured, so completed contracts are not being filed; ' +
        'set NEXT_PRIVATE_SHAREPOINT_TENANT_ID, NEXT_PRIVATE_SHAREPOINT_CLIENT_ID, ' +
        'NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET, NEXT_PRIVATE_SHAREPOINT_SITE_ID and ' +
        'NEXT_PRIVATE_SHAREPOINT_DRIVE_ID',
    };
  }

  try {
    const { failing, latest } = await readFailures(FAILED_ATTEMPTS_BEFORE_WARNING);

    if (failing === 0 || !latest) {
      return { status: 'ok', detail: 'the contract archive is configured and no document is failing to file' };
    }

    return {
      status: 'warning',
      detail:
        `${failing} completed document(s) have failed to file at least ${FAILED_ATTEMPTS_BEFORE_WARNING} times; ` +
        `the latest, after ${latest.attempts} attempts at ${latest.at.toISOString()}, failed with: ${latest.lastError}`,
    };
  } catch (error) {
    return {
      status: 'warning',
      detail: `could not read the archive's filing records: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
