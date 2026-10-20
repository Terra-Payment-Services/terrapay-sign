import { SigningStatus } from '@prisma/client';

import { primaryClient } from '../database/primary-client';

/**
 * Whether any recipient of the envelope has rejected it.
 *
 * A rejection leaves the envelope PENDING until the seal job runs, so the envelope status alone does not stop an
 * invitation in that window. Every invitation path asks this, as close to the send as it can (#123). It reads the
 * primary, since a rejection committed there may not have reached a read replica yet (#122).
 */
export const hasEnvelopeRejection = async (envelopeId: string) => {
  const rejected = await primaryClient().recipient.findFirst({
    where: { envelopeId, signingStatus: SigningStatus.REJECTED },
    select: { id: true },
  });

  return rejected !== null;
};
