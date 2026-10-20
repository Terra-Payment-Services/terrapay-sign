import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { isEnvelopeRecipientsTurn } from './assert-recipients-turn';

export type GetIsRecipientTurnOptions = {
  token: string;
};

/**
 * Whether the recipient holding `token` may act now, by the order rule the signing routes apply (#145).
 */
export async function getIsRecipientsTurnToSign({ token }: GetIsRecipientTurnOptions) {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      type: EnvelopeType.DOCUMENT,
      recipients: {
        some: {
          token,
        },
      },
    },
    include: {
      documentMeta: true,
      recipients: true,
    },
  });

  const currentRecipient = envelope.recipients.find((recipient) => recipient.token === token);

  if (!currentRecipient) {
    return false;
  }

  return isEnvelopeRecipientsTurn(
    {
      signingOrder: envelope.documentMeta?.signingOrder,
      signatureLevel: envelope.signatureLevel,
      recipients: envelope.recipients,
    },
    currentRecipient.id,
  );
}
