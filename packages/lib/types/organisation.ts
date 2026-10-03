import OrganisationClaimSchema from '@documenso/prisma/generated/zod/modelSchema/OrganisationClaimSchema';
import { OrganisationSchema } from '@documenso/prisma/generated/zod/modelSchema/OrganisationSchema';
import { z } from 'zod';

export const ZOrganisationSchema = OrganisationSchema.pick({
  id: true,
  createdAt: true,
  updatedAt: true,
  type: true,
  name: true,
  url: true,
  avatarImageId: true,
  customerId: true,
  ownerUserId: true,
}).extend({
  organisationClaim: OrganisationClaimSchema.pick({
    id: true,
    createdAt: true,
    updatedAt: true,
    originalSubscriptionClaimId: true,
    teamCount: true,
    memberCount: true,
    envelopeItemCount: true,
    recipientCount: true,
    flags: true,
  }),
});

export type TOrganisation = z.infer<typeof ZOrganisationSchema>;

export const ZOrganisationLiteSchema = OrganisationSchema.pick({
  id: true,
  createdAt: true,
  updatedAt: true,
  type: true,
  name: true,
  url: true,
  avatarImageId: true,
  customerId: true,
  ownerUserId: true,
});

/**
 * A version of the organisation response schema when returning multiple organisations at once from a single API endpoint.
 */
export const ZOrganisationManySchema = ZOrganisationLiteSchema;

export const ZOrganisationAccountLinkMetadataSchema = z.object({
  type: z.enum(['link', 'create']),
  userId: z.number(),
  organisationId: z.string(),
  oauthConfig: z.object({
    providerAccountId: z.string(),
    accessToken: z.string(),
    expiresAt: z.number(),
    idToken: z.string(),
    // The authority the token was verified against when the link was offered.
    // Required, so that no Account row is written from a link token without
    // one. Link tokens minted before this field existed stop parsing, which
    // costs the holder another sign in and nothing else.
    issuer: z.string().min(1),
  }),
});

export type TOrganisationAccountLinkMetadata = z.infer<typeof ZOrganisationAccountLinkMetadataSchema>;
