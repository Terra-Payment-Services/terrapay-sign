import { prisma } from '@documenso/prisma';
import type { DocumentDataType, Prisma } from '@prisma/client';

/**
 * Who the bytes belong to, recorded as they are written.
 *
 * At least one of the two has to be there, which is what the union shape
 * enforces. Neither is available at every creation site. `POST
 * /api/files/upload-pdf` authenticates a person and is told no team. The
 * sealing job and the direct-link template path run with no signed-in person
 * and know only the team the envelope sits in. Passing both is the common case
 * and is allowed.
 *
 * There is deliberately no shape that satisfies this with nothing, because a
 * row carrying no identity is a row `assertDocumentDataAccess` has to refuse to
 * everybody.
 */
export type DocumentDataOwner = { userId: number; teamId: number | null } | { userId: number | null; teamId: number };

export type CreateDocumentDataOptions = {
  type: DocumentDataType;
  data: string;

  /**
   * The initial data that was used to create the document data.
   *
   * If not provided, the current data will be used.
   */
  initialData?: string;

  /** Who these bytes belong to. Required, so no caller can leave it open. */
  owner: DocumentDataOwner;

  /** Create the row in this transaction, so it rolls back with it. Defaults to no transaction. */
  tx?: Prisma.TransactionClient;
};

/**
 * Creates a document data record for bytes already stored, inside `tx` when one is given.
 */
export const createDocumentData = async ({ type, data, initialData, owner, tx }: CreateDocumentDataOptions) => {
  return await (tx ?? prisma).documentData.create({
    data: {
      type,
      data,
      initialData: initialData || data,
      userId: owner.userId ?? null,
      teamId: owner.teamId ?? null,
    },
  });
};
