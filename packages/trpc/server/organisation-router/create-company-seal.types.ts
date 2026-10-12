import { z } from 'zod';
import { zfd } from 'zod-form-data';

import { zodFormData } from '../../utils/zod-form-data';

export const ZCreateCompanySealRequestSchema = zodFormData({
  payload: zfd.json(
    z.object({
      organisationId: z.string(),
      name: z.string().trim().min(1).max(100),
      legalEntityName: z.string().trim().min(1).max(200),
    }),
  ),
  // Size and declared type are checked by processCompanySealImage, so they are refused as INVALID_BODY.
  image: zfd.file(),
});

export const ZCreateCompanySealResponseSchema = z.object({
  id: z.string(),
});

export type TCreateCompanySealRequest = z.infer<typeof ZCreateCompanySealRequestSchema>;
export type TCreateCompanySealResponse = z.infer<typeof ZCreateCompanySealResponseSchema>;
