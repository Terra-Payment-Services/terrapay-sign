import { useCurrentOrganisation } from '../providers/organisation';

/**
 * How many items one envelope may hold, from the current organisation's claim.
 */
export const useMaximumEnvelopeItemCount = () => {
  const organisation = useCurrentOrganisation();

  return organisation.organisationClaim.envelopeItemCount;
};
