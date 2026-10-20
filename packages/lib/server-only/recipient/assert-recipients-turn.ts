import type { Prisma, Recipient } from '@prisma/client';
import { DocumentSigningOrder } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { isTspEnvelope } from '../../types/signature-level';
import { isRecipientTurnBySigningOrder } from '../../utils/recipient-groups';

export type RecipientTurnEnvelope = {
  signingOrder: DocumentSigningOrder | null | undefined;
  signatureLevel: string;
  recipients: Array<Pick<Recipient, 'id' | 'role' | 'signingStatus' | 'signingOrder'>>;
};

/**
 * The order rule (G4 section 3, #145): whether `recipientId` may act now. Outside SEQUENTIAL signing it always
 * may. Otherwise every non-CC recipient in an earlier step must have signed; members of one step do not block
 * each other, except on a TSP envelope, where they go one at a time by id.
 *
 * @param envelope The envelope's signing order, signature level and every recipient.
 * @param recipientId The recipient acting (for an assistant, the assistant).
 */
export const isEnvelopeRecipientsTurn = (envelope: RecipientTurnEnvelope, recipientId: number) => {
  if (envelope.signingOrder !== DocumentSigningOrder.SEQUENTIAL) {
    return true;
  }

  const current = envelope.recipients.find((recipient) => recipient.id === recipientId);

  if (!current) {
    return false;
  }

  return isRecipientTurnBySigningOrder(envelope.recipients, current, {
    strictlySequential: isTspEnvelope(envelope),
  });
};

/**
 * Refuses a recipient action taken before the recipient's turn, deciding from rows read in `tx`. Call it after
 * `lockEnvelopeForRecipientAction`, so a completion or a reorder that commits first is seen.
 *
 * @throws AppError RECIPIENT_OUT_OF_TURN (400) when it is not the recipient's turn.
 */
export const assertRecipientsTurn = async (
  tx: Prisma.TransactionClient,
  { envelopeId, recipientId }: { envelopeId: string; recipientId: number },
) => {
  const envelope = await tx.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    select: {
      signatureLevel: true,
      documentMeta: { select: { signingOrder: true } },
      recipients: { select: { id: true, role: true, signingStatus: true, signingOrder: true } },
    },
  });

  const isTurn = isEnvelopeRecipientsTurn(
    {
      signingOrder: envelope.documentMeta?.signingOrder,
      signatureLevel: envelope.signatureLevel,
      recipients: envelope.recipients,
    },
    recipientId,
  );

  if (!isTurn) {
    throw new AppError(AppErrorCode.RECIPIENT_OUT_OF_TURN, {
      message: `Recipient ${recipientId} cannot act before it is their turn to sign`,
      statusCode: 400,
    });
  }
};
