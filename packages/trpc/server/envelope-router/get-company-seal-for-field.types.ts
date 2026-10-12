import { z } from 'zod';

export const ZGetCompanySealForFieldRequestSchema = z.object({
  token: z.string(),
  fieldId: z.number(),
});

export const ZGetCompanySealForFieldResponseSchema = z.object({
  name: z.string(),
  legalEntityName: z.string(),
  imageDataUrl: z.string(),
});

export type TGetCompanySealForFieldRequest = z.infer<typeof ZGetCompanySealForFieldRequestSchema>;
export type TGetCompanySealForFieldResponse = z.infer<typeof ZGetCompanySealForFieldResponseSchema>;
