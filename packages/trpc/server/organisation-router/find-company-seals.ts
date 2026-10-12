import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { listCompanySeals } from '@documenso/lib/server-only/company-seal/company-seal-field';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import { ZFindCompanySealsRequestSchema, ZFindCompanySealsResponseSchema } from './find-company-seals.types';

/** Every seal of the organisation with its image, for its managers and admins. */
export const findCompanySealsRoute = authenticatedProcedure
  .input(ZFindCompanySealsRequestSchema)
  .output(ZFindCompanySealsResponseSchema)
  .query(async ({ ctx, input }) => {
    const { organisationId } = input;

    ctx.logger.info({
      input: {
        organisationId,
      },
    });

    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({
        organisationId,
        userId: ctx.user.id,
        roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
      }),
    });

    if (!organisation) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You do not have permission to view the company seals of this organisation.',
      });
    }

    ctx.resHeaders?.set('Cache-Control', 'private, no-store');

    return { data: await listCompanySeals(organisation.id) };
  });
