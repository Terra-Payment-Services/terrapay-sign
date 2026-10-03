import { ZNameSchema } from '@documenso/lib/types/name';
import { z } from 'zod';

// export const createOrganisationMeta: TrpcOpenApiMeta = {
//   openapi: {
//     method: 'POST',
//     path: '/organisation',
//     summary: 'Create organisation',
//     description: 'Create an organisation',
//     tags: ['Organisation'],
//   },
// };

export const ZCreateOrganisationRequestSchema = z.object({
  name: ZNameSchema,
});

export const ZCreateOrganisationResponseSchema = z.object({
  paymentRequired: z.literal(false),
});

export type TCreateOrganisationResponse = z.infer<typeof ZCreateOrganisationResponseSchema>;
