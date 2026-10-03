import { isOrganisationCreationAllowed } from '@documenso/lib/server-only/organisation/organisation-creation-allowed';
import { authenticatedProcedure } from '../trpc';
import {
  ZGetOrganisationCreationAllowedRequestSchema,
  ZGetOrganisationCreationAllowedResponseSchema,
} from './get-organisation-creation-allowed.types';

/**
 * Whether the UI should offer to create an organisation, which it does only
 * while none exists.
 */
export const getOrganisationCreationAllowedRoute = authenticatedProcedure
  .input(ZGetOrganisationCreationAllowedRequestSchema)
  .output(ZGetOrganisationCreationAllowedResponseSchema)
  .query(async () => {
    return {
      isAllowed: await isOrganisationCreationAllowed(),
    };
  });
