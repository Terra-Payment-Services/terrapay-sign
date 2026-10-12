import { z } from 'zod';

/** A seal as listed to managers and editors, with its stored PNG as a data URL. */
export const ZCompanySealListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalEntityName: z.string(),
  imageDataUrl: z.string(),
  createdAt: z.date(),
  createdByName: z.string(),
  createdByEmail: z.string(),
});

export type TCompanySealListItem = z.infer<typeof ZCompanySealListItemSchema>;

export const ZFindCompanySealsRequestSchema = z.object({
  organisationId: z.string(),
});

export const ZFindCompanySealsResponseSchema = z.object({
  data: z.array(ZCompanySealListItemSchema),
});

export type TFindCompanySealsRequest = z.infer<typeof ZFindCompanySealsRequestSchema>;
export type TFindCompanySealsResponse = z.infer<typeof ZFindCompanySealsResponseSchema>;
