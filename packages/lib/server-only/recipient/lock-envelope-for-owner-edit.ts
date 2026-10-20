import type { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { canRecipientFieldsBeModified } from '../../utils/recipients';

/**
 * Takes the envelope row lock for an owner's recipient edit and returns the envelope's recipients and fields read
 * under it.
 *
 * Rejection, completion and every field writer take the same lock (lockEnvelopeForRecipientAction), so a
 * modifiability check made on these rows is serialised against them: a rejection that commits after the caller's
 * first read is seen here, rather than overwritten by the edit (#121).
 */
export const lockEnvelopeForOwnerEdit = async (tx: Prisma.TransactionClient, envelopeId: string) => {
  await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR NO KEY UPDATE`;

  const [recipients, fields] = await Promise.all([
    tx.recipient.findMany({ where: { envelopeId } }),
    tx.field.findMany({ where: { envelopeId }, select: { id: true, recipientId: true, inserted: true } }),
  ]);

  return { recipients, fields };
};

/**
 * Takes the envelope row lock for an owner's field edit and refuses unless every recipient whose fields it touches
 * can still have them modified, judged on rows read under the lock. A rejection or a signature that commits after
 * the caller's first read is seen here rather than raced (#121).
 */
export const assertRecipientFieldsModifiableUnderLock = async (
  tx: Prisma.TransactionClient,
  envelopeId: string,
  recipientIds: Array<number | null>,
) => {
  const { recipients, fields } = await lockEnvelopeForOwnerEdit(tx, envelopeId);

  for (const recipientId of new Set(recipientIds)) {
    const recipient = recipients.find((candidate) => candidate.id === recipientId);

    if (!recipient || !canRecipientFieldsBeModified(recipient, fields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot modify a field where the recipient has already interacted with the document',
      });
    }
  }
};
