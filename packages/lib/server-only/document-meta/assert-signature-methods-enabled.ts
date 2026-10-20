import type { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

export type SignatureMethodFlags = {
  typedSignatureEnabled?: boolean | null;
  drawSignatureEnabled?: boolean | null;
  uploadSignatureEnabled?: boolean | null;
};

/**
 * Refuses signature-method settings with no method enabled (#136). Saving such a
 * policy is refused everywhere; signing treats one already stored as all three
 * allowed (G4 decision D3).
 */
export const assertSignatureMethodsEnabled = (flags: SignatureMethodFlags) => {
  if (!flags.typedSignatureEnabled && !flags.drawSignatureEnabled && !flags.uploadSignatureEnabled) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'At least one signature type must be enabled',
    });
  }
};

/**
 * Locks a DocumentMeta row and refuses `incoming` when, merged over the stored
 * flags, it leaves no method enabled. Run inside the transaction that writes the
 * row, so two concurrent updates cannot together turn all three off (C94).
 */
export const assertMergedDocumentMetaMethodsEnabled = async (
  tx: Prisma.TransactionClient,
  documentMetaId: string,
  incoming: SignatureMethodFlags,
) => {
  if (
    incoming.typedSignatureEnabled === undefined &&
    incoming.drawSignatureEnabled === undefined &&
    incoming.uploadSignatureEnabled === undefined
  ) {
    return;
  }

  await tx.$queryRaw`SELECT "id" FROM "DocumentMeta" WHERE "id" = ${documentMetaId} FOR UPDATE`;

  const stored = await tx.documentMeta.findUniqueOrThrow({ where: { id: documentMetaId } });

  assertSignatureMethodsEnabled({
    typedSignatureEnabled: incoming.typedSignatureEnabled ?? stored.typedSignatureEnabled,
    drawSignatureEnabled: incoming.drawSignatureEnabled ?? stored.drawSignatureEnabled,
    uploadSignatureEnabled: incoming.uploadSignatureEnabled ?? stored.uploadSignatureEnabled,
  });
};
