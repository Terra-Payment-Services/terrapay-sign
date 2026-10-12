import { z } from 'zod';

import { ZCompanySealListItemSchema } from './find-company-seals.types';

export const ZFindCompanySealsForEnvelopeRequestSchema = z.object({
  envelopeId: z.string(),
});

export const ZFindCompanySealsForEnvelopeResponseSchema = z.object({
  data: z.array(ZCompanySealListItemSchema),
  /** Recipients whose email does not belong to a member of the organisation, so cannot apply a seal. */
  nonMemberRecipientIds: z.array(z.number()),
});

export type TFindCompanySealsForEnvelopeRequest = z.infer<typeof ZFindCompanySealsForEnvelopeRequestSchema>;
export type TFindCompanySealsForEnvelopeResponse = z.infer<typeof ZFindCompanySealsForEnvelopeResponseSchema>;
