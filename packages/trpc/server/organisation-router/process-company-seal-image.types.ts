import { z } from 'zod';
import { zfd } from 'zod-form-data';

import { zodFormData } from '../../utils/zod-form-data';

export const ZProcessCompanySealImageRequestSchema = zodFormData({
  payload: zfd.json(
    z.object({
      organisationId: z.string(),
    }),
  ),
  // Size and declared type are checked by processCompanySealImage, so they are refused as INVALID_BODY.
  image: zfd.file(),
});

export const ZProcessCompanySealImageResponseSchema = z.object({
  imageDataUrl: z.string(),
});

export type TProcessCompanySealImageRequest = z.infer<typeof ZProcessCompanySealImageRequestSchema>;
export type TProcessCompanySealImageResponse = z.infer<typeof ZProcessCompanySealImageResponseSchema>;
