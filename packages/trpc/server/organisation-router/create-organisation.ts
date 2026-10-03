import { createOrganisation } from '@documenso/lib/server-only/organisation/create-organisation';
import { assertOrganisationCreationAllowed } from '@documenso/lib/server-only/organisation/organisation-creation-allowed';
import { getSubscriptionClaim } from '@documenso/lib/server-only/subscription/get-subscription-claim';
import { INTERNAL_CLAIM_ID } from '@documenso/lib/types/subscription';
import { OrganisationType } from '@prisma/client';
import { adminProcedure } from '../trpc';
import { ZCreateOrganisationRequestSchema, ZCreateOrganisationResponseSchema } from './create-organisation.types';

export const createOrganisationRoute = adminProcedure
  // .meta(createOrganisationMeta)
  .input(ZCreateOrganisationRequestSchema)
  .output(ZCreateOrganisationResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { name } = input;
    const { user } = ctx;

    // Only admins, and only while none exists: the instance holds one organisation.
    await assertOrganisationCreationAllowed();

    const freeSubscriptionClaim = await getSubscriptionClaim(INTERNAL_CLAIM_ID.FREE);

    await createOrganisation({
      userId: user.id,
      name,
      type: OrganisationType.ORGANISATION,
      claim: freeSubscriptionClaim,
    });

    return {
      paymentRequired: false,
    };
  });
