import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';

export type AssertDocumentDataAccessOptions = {
  /** The team the caller has already been authorised against. */
  teamId: number;
  /** The signed-in person making the request. */
  userId: number;
  /** Document data IDs that arrived from the client rather than being minted server-side. */
  documentDataIds: string[];
};

/**
 * Refuse a client-supplied DocumentData ID the caller has no claim on.
 *
 * Two things can establish a claim. If an envelope item holds the row, the
 * bytes belong to that envelope's team and the caller's team has to be it.
 * If nothing holds the row it is a bare upload, and the claim comes from the
 * identity stamped on the row when it was written: the caller's own team, or
 * the caller themselves on a row uploaded with no team.
 *
 * A row carrying neither is refused to everybody. That covers rows written
 * before `DocumentData` had an owner and rows the backfill could not resolve,
 * and it is the conservative answer, since the alternative is the hole this
 * check exists to close.
 *
 * Everything is refused as missing rather than as forbidden, which keeps the
 * endpoint from confirming that an ID exists somewhere the caller cannot see.
 *
 * @param teamId - the team the caller is creating within
 * @param userId - the person the caller is acting as
 * @param documentDataIds - the IDs the client asked to use
 * @throws {AppError} NOT_FOUND when an ID is unknown or the caller has no claim on it
 */
export const assertDocumentDataAccess = async ({
  teamId,
  userId,
  documentDataIds,
}: AssertDocumentDataAccessOptions): Promise<void> => {
  const ids = [...new Set(documentDataIds.filter((id) => id.length > 0))];

  if (ids.length === 0) {
    return;
  }

  const documentData = await prisma.documentData.findMany({
    where: {
      id: {
        in: ids,
      },
    },
    select: {
      id: true,
      userId: true,
      teamId: true,
      envelopeItem: {
        select: {
          envelope: {
            select: {
              teamId: true,
            },
          },
        },
      },
    },
  });

  const rowById = new Map(documentData.map((row) => [row.id, row] as const));

  const notFound = () =>
    new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document data not found',
    });

  for (const id of ids) {
    const row = rowById.get(id);

    if (!row) {
      throw notFound();
    }

    const holdingTeamId = row.envelopeItem?.envelope.teamId ?? null;

    if (holdingTeamId !== null) {
      if (holdingTeamId !== teamId) {
        throw notFound();
      }

      continue;
    }

    // Nothing holds the row, so the stamp is all there is.
    if (row.teamId !== null) {
      if (row.teamId !== teamId) {
        throw notFound();
      }

      continue;
    }

    // No team was knowable when it was uploaded, so only the uploader may
    // attach it, and they may do so in any team they are authorised for.
    if (row.userId === null || row.userId !== userId) {
      throw notFound();
    }
  }
};
