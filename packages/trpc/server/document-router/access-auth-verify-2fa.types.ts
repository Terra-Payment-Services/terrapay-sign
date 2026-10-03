import { ZRecipientAccessAuthSchema } from '@documenso/lib/types/document-auth';
import { z } from 'zod';

export const ZAccessAuthVerify2FARequestSchema = z.object({
  token: z.string().min(1),
  authOptions: ZRecipientAccessAuthSchema,
});

export const ZAccessAuthVerify2FAResponseSchema = z.object({
  success: z.boolean(),
});

export type TAccessAuthVerify2FARequest = z.infer<typeof ZAccessAuthVerify2FARequestSchema>;
export type TAccessAuthVerify2FAResponse = z.infer<typeof ZAccessAuthVerify2FAResponseSchema>;
