import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { fileEnvelopeToSharePoint } from '../../../server-only/archive/file-envelope-to-sharepoint';
import {
  getSharePointArchiveConfig,
  SHAREPOINT_ARCHIVE_UNCONFIGURED_MESSAGE,
} from '../../../server-only/archive/sharepoint-archive-config';
import { uploadFileToSharePoint } from '../../../server-only/microsoft-graph/sharepoint-upload';
import { generateDatabaseId } from '../../../universal/id';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import type { JobRunIO } from '../../client/_internal/job';
import type { TArchiveEnvelopeJobDefinition } from './archive-envelope';

/**
 * How long one run's claim on a document holds before another may take it.
 *
 * The claim is a lease rather than a lock because the holder can die without
 * releasing anything, and a contract that nobody will ever pick up again is the
 * failure this whole feature exists to prevent. Long enough to cover a chunked
 * upload of a large contract through Graph's own retries, and shorter than the
 * sweep interval, so a lapsed claim is taken on the sweep after next rather than
 * by the run that is still uploading.
 */
const ARCHIVE_CLAIM_LEASE_MINUTES = 15;

export const run = async ({ payload, io }: { payload: TArchiveEnvelopeJobDefinition; io: JobRunIO }) => {
  const config = getSharePointArchiveConfig();

  if (!config) {
    io.logger.info(SHAREPOINT_ARCHIVE_UNCONFIGURED_MESSAGE);

    return;
  }

  const envelope = await prisma.envelope.findFirst({
    where: {
      id: payload.envelopeId,
      type: EnvelopeType.DOCUMENT,
    },
    select: {
      id: true,
      title: true,
      status: true,
      completedAt: true,
      envelopeItems: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          title: true,
          documentData: true,
        },
      },
    },
  });

  if (!envelope) {
    io.logger.warn(`[sharepoint-archive] Envelope ${payload.envelopeId} no longer exists, nothing to file.`);

    return;
  }

  // Only executed contracts are filed. A rejected or cancelled envelope has a
  // sealed PDF too, but it is not a contract and filing it into a library under
  // contract retention would misrepresent it.
  if (envelope.status !== DocumentStatus.COMPLETED) {
    io.logger.info(
      `[sharepoint-archive] Envelope ${envelope.id} is ${envelope.status} rather than COMPLETED, not filing.`,
    );

    return;
  }

  const result = await fileEnvelopeToSharePoint({
    envelope: {
      id: envelope.id,
      title: envelope.title,
      completedAt: envelope.completedAt,
      items: envelope.envelopeItems.map((item) => ({ id: item.id, title: item.title })),
    },
    folderPathTemplate: config.folderPathTemplate,
    logger: io.logger,
    findExistingArchive: async (envelopeItemId) =>
      await prisma.envelopeArchive.findUnique({
        where: { envelopeItemId },
        // `path` comes back so that a run taking over a lapsed claim files the
        // document where the previous run was filing it, rather than working
        // the name out again and possibly arriving somewhere else.
        select: { archivedAt: true, attempts: true, path: true },
      }),
    readItemContent: async (item) => {
      const envelopeItem = envelope.envelopeItems.find((candidate) => candidate.id === item.id);

      if (!envelopeItem) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: `Envelope item ${item.id} disappeared while filing envelope ${envelope.id}`,
        });
      }

      return await getFileServerSide(envelopeItem.documentData);
    },
    uploadFile: async ({ folderPath, fileName, content }) =>
      await uploadFileToSharePoint({
        target: config.target,
        credentials: config.credentials,
        folderPath,
        fileName,
        content,
      }),
    claimForArchive: async ({ envelopeItemId, path }) => {
      // Taking the claim is one statement, and every clock in it is the
      // database's own.
      //
      // Doing this through Prisma stamped `updatedAt` from whichever
      // application server wrote the row and compared it against whichever
      // application server read it. A server running ahead therefore wrote a
      // claim dated in the future, and no conditional update matched it until
      // real time caught up. The document stayed unfiled for the length of the
      // skew while the sweep selected it over and over and could never take it.
      // Skew between two app servers is not a tidiness question when one side
      // of the comparison is a lease: it is the difference between a lease that
      // expires and one that does not. Postgres has one clock, and NOW() on
      // both sides of the comparison means the lease is measured against it.
      //
      // The upsert also collapses what were two round trips. `envelopeItemId`
      // is unique, so of two runs arriving together one inserts and the other
      // falls to the conflict branch, which takes the claim only if the
      // document is still unfiled and the holder has been quiet for longer than
      // the lease. The row count says whether this run was the one that won.
      const claimed = await prisma.$executeRaw`
        INSERT INTO "EnvelopeArchive" ("id", "envelopeId", "envelopeItemId", "attempts", "path", "createdAt", "updatedAt")
        VALUES (${generateDatabaseId('envelope_archive')}, ${envelope.id}, ${envelopeItemId}, 1, ${path}, NOW(), NOW())
        ON CONFLICT ("envelopeItemId") DO UPDATE
          SET "attempts" = "EnvelopeArchive"."attempts" + 1,
              "path" = EXCLUDED."path",
              "updatedAt" = NOW()
          WHERE "EnvelopeArchive"."archivedAt" IS NULL
            AND "EnvelopeArchive"."updatedAt" < NOW() - make_interval(mins => ${ARCHIVE_CLAIM_LEASE_MINUTES}::int)
      `;

      return claimed === 1;
    },
    recordSuccess: async ({ envelopeItemId, upload }) => {
      await prisma.envelopeArchive.update({
        where: { envelopeItemId },
        data: {
          archivedAt: new Date(),
          driveId: config.target.driveId,
          itemId: upload.itemId,
          webUrl: upload.webUrl,
          path: upload.path,
          lastError: null,
        },
      });
    },
    recordFailure: async ({ envelopeItemId, message }) => {
      await prisma.envelopeArchive.update({
        where: { envelopeItemId },
        data: { lastError: message },
      });
    },
  });

  io.logger.info(
    `[sharepoint-archive] Envelope ${envelope.id}: filed ${result.filed.length}, ` +
      `already filed ${result.alreadyFiled.length}, held by another run ${result.claimedElsewhere.length}, ` +
      `failed ${result.failed.length}`,
  );

  if (result.failed.length > 0) {
    // Throwing takes the job system's retry and shows the failure in Bull
    // Board. The documents stay unfiled either way, so the sweep files them
    // even if every retry here is exhausted.
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message:
        `Failed to file ${result.failed.length} document(s) of envelope ${envelope.id} into SharePoint: ` +
        result.failed.map((failure) => `${failure.envelopeItemId} (${failure.message})`).join('; '),
    });
  }
};
