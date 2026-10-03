import { trpc } from '@documenso/trpc/react';
import { OrganisationType } from '@prisma/client';

import { isAdmin } from '../../utils/is-admin';
import { useSession } from '../providers/session';

/**
 * Whether to offer creating an organisation. The instance holds only one, so
 * this is true only for an admin while none exists. An admin who already
 * belongs to one answers the question without asking the server; personal
 * organisations do not count.
 */
export const useIsOrganisationCreationAllowed = () => {
  const { user, organisations } = useSession();

  // Creation is for admins only, which the server enforces too.
  const isAsked =
    isAdmin(user) && !organisations.some((organisation) => organisation.type === OrganisationType.ORGANISATION);

  const { data } = trpc.organisation.getCreationAllowed.useQuery(undefined, {
    enabled: isAsked,
  });

  return isAsked && data?.isAllowed === true;
};
