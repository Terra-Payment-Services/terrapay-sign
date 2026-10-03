import { prisma } from '@documenso/prisma';
import { OrganisationType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

/**
 * TerraPay Sign holds exactly one organisation. A new one may be created only
 * while none exists, so that a fresh install can be bootstrapped. Personal
 * organisations do not count, so one made at signup cannot block the real one.
 */
export const isOrganisationCreationAllowed = async () => {
  const organisationCount = await prisma.organisation.count({
    where: { type: OrganisationType.ORGANISATION },
  });

  return organisationCount === 0;
};

export const assertOrganisationCreationAllowed = async () => {
  if (!(await isOrganisationCreationAllowed())) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: 'An organisation already exists, and this instance holds only one',
    });
  }
};
