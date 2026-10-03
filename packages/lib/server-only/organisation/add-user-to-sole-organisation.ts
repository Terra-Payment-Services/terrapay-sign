import { prisma } from '@documenso/prisma';
import { OrganisationMemberRole, OrganisationType } from '@prisma/client';

import { logger } from '../../utils/logger';
import { addUserToOrganisation } from './accept-organisation-invitation';

export type AddUserToSoleOrganisationOptions = {
  userId: number;
};

export type AddUserToSoleOrganisationResult = 'added' | 'already-member' | 'skipped';

/**
 * Makes a newly signed-in staff member an ordinary MEMBER of the deployment's
 * organisation, so they reach its teams without waiting for an invitation.
 *
 * This deployment is meant to hold exactly one organisation. When it holds none
 * or several there is no safe way to pick, so nobody is added and a warning is
 * logged. Personal organisations are left out of the count, since users created
 * before personal organisations were switched off may still own one.
 *
 * Safe to call more than once for the same user.
 */
export const addUserToSoleOrganisation = async ({
  userId,
}: AddUserToSoleOrganisationOptions): Promise<AddUserToSoleOrganisationResult> => {
  const organisations = await prisma.organisation.findMany({
    where: {
      type: OrganisationType.ORGANISATION,
    },
    include: {
      groups: true,
    },
  });

  if (organisations.length !== 1) {
    logger.warn({
      msg: 'Not adding the new user to an organisation, because there is not exactly one',
      userId,
      organisationCount: organisations.length,
    });

    return 'skipped';
  }

  const [organisation] = organisations;

  const existingMember = await prisma.organisationMember.findFirst({
    where: {
      userId,
      organisationId: organisation.id,
    },
  });

  if (existingMember) {
    return 'already-member';
  }

  try {
    await addUserToOrganisation({
      userId,
      organisationId: organisation.id,
      organisationGroups: organisation.groups,
      organisationMemberRole: OrganisationMemberRole.MEMBER,
      // Every new staff member joins this way, so admins are not mailed for each.
      bypassEmail: true,
    });
  } catch (err) {
    // A concurrent call won the unique (userId, organisationId) constraint.
    if (err instanceof Object && 'code' in err && err.code === 'P2002') {
      return 'already-member';
    }

    throw err;
  }

  return 'added';
};
