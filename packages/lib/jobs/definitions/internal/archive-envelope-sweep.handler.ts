import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { SHAREPOINT_ARCHIVE_FLOOR } from '../../../constants/app';
import {
  getSharePointArchiveConfig,
  SHAREPOINT_ARCHIVE_UNCONFIGURED_MESSAGE,
} from '../../../server-only/archive/sharepoint-archive-config';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TArchiveEnvelopeSweepJobDefinition } from './archive-envelope-sweep';

/**
 * Envelopes queued per run. Bounded so that enabling the archive on an instance
 * with years of history backfills steadily rather than in one burst that Graph
 * would throttle anyway. Anything left over is picked up on the next run.
 */
const SWEEP_BATCH_SIZE = 100;

export const run = async ({ io }: { payload: TArchiveEnvelopeSweepJobDefinition; io: JobRunIO }) => {
  if (!getSharePointArchiveConfig()) {
    io.logger.info(SHAREPOINT_ARCHIVE_UNCONFIGURED_MESSAGE);

    return;
  }

  const floor = SHAREPOINT_ARCHIVE_FLOOR();

  const unfiledEnvelopes = await prisma.envelope.findMany({
    where: {
      type: EnvelopeType.DOCUMENT,
      status: DocumentStatus.COMPLETED,
      deletedAt: null,
      ...(floor ? { completedAt: { gte: floor } } : {}),
      // Unfiled means either never attempted or attempted without reaching a
      // confirmed store. Both are the sweep's business; a row that exists but
      // carries no `archivedAt` is a failed attempt, not a filed document.
      envelopeItems: {
        some: {
          OR: [{ archive: { is: null } }, { archive: { archivedAt: null } }],
        },
      },
    },
    select: {
      id: true,
    },
    // Oldest first, so a backfill drains in the order contracts were executed
    // and a document cannot be starved indefinitely by newer arrivals.
    orderBy: {
      completedAt: 'asc',
    },
    take: SWEEP_BATCH_SIZE,
  });

  if (unfiledEnvelopes.length === 0) {
    io.logger.info('[sharepoint-archive] No unfiled completed documents found');

    return;
  }

  io.logger.info(`[sharepoint-archive] Found ${unfiledEnvelopes.length} envelope(s) with unfiled documents`);

  await Promise.allSettled(
    unfiledEnvelopes.map(async (envelope) => {
      await jobs.triggerJob({
        name: 'internal.archive-envelope',
        payload: {
          envelopeId: envelope.id,
        },
      });
    }),
  );
};
