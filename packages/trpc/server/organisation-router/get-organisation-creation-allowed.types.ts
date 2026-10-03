import { z } from 'zod';

export const ZGetOrganisationCreationAllowedRequestSchema = z.void();

export const ZGetOrganisationCreationAllowedResponseSchema = z.object({
  isAllowed: z.boolean(),
});

export type TGetOrganisationCreationAllowedResponse = z.infer<typeof ZGetOrganisationCreationAllowedResponseSchema>;
