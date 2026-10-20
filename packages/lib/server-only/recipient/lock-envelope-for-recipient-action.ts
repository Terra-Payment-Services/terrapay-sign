import type { Prisma } from '@prisma/client';
import { DocumentStatus, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

export type LockEnvelopeForRecipientActionOptions = {
  envelopeId: string;
  recipientId: number;
  /**
   * The recipient who owns the field being written, when it may differ from the actor (an assistant
   * filling in another recipient's field). Refused once that recipient has signed.
   */
  fieldRecipientId?: number | null;
};

/**
 * Takes the envelope row lock and refuses once any recipient has rejected. Returns the acting
 * recipient's current row, read under the lock, for the caller's own status checks.
 *
 * A rejection leaves the envelope PENDING until the seal job runs, so a status check alone lets other
 * recipients keep signing, completing or rejecting in between. Every recipient write takes this lock
 * first inside its transaction, so a rejection and any other write are serialised and the later one
 * sees the earlier.
 */
export const lockEnvelopeForRecipientAction = async (
  tx: Prisma.TransactionClient,
  { envelopeId, recipientId, fieldRecipientId }: LockEnvelopeForRecipientActionOptions,
) => {
  // FOR NO KEY UPDATE still serialises these actions against each other, but not against the key-share
  // lock a foreign key takes, so an owner's field edit that holds Field rows and writes an audit row
  // cannot deadlock against a signer waiting on one of those fields.
  const [envelope] = await tx.$queryRaw<{ status: DocumentStatus }[]>`
    SELECT "status" FROM "Envelope" WHERE "id" = ${envelopeId} FOR NO KEY UPDATE
  `;

  // Callers check PENDING before their transaction; a cancel that commits while they wait here must still stop
  // them (#134).
  if (envelope?.status !== DocumentStatus.PENDING) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Document is no longer pending',
    });
  }

  const recipients = await tx.recipient.findMany({
    where: { envelopeId },
    select: { id: true, signingStatus: true },
  });

  if (recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Document has been rejected',
    });
  }

  const actor = recipients.find((recipient) => recipient.id === recipientId);

  if (!actor) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Recipient not found',
    });
  }

  const fieldRecipient = recipients.find((recipient) => recipient.id === fieldRecipientId);

  if (fieldRecipient?.signingStatus === SigningStatus.SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Recipient ${fieldRecipient.id} has already signed`,
    });
  }

  return actor;
};
