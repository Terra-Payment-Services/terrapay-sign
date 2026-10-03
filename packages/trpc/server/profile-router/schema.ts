import { ZNameSchema } from '@documenso/lib/types/name';
import { z } from 'zod';

export const ZFindUserSecurityAuditLogsSchema = z.object({
  page: z.number().optional(),
  perPage: z.number().optional(),
});

export type TFindUserSecurityAuditLogsSchema = z.infer<typeof ZFindUserSecurityAuditLogsSchema>;

export const ZUpdateProfileMutationSchema = z.object({
  name: ZNameSchema,
  signature: z.string(),
});

export type TUpdateProfileMutationSchema = z.infer<typeof ZUpdateProfileMutationSchema>;

export const ZSetProfileImageMutationSchema = z.object({
  bytes: z.string().nullish(),
  teamId: z.number().min(1).nullable(),
  organisationId: z.string().nullable(),
});

export type TSetProfileImageMutationSchema = z.infer<typeof ZSetProfileImageMutationSchema>;
