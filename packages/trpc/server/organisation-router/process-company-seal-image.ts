import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { processCompanySealImage } from '@documenso/lib/server-only/company-seal/build-company-seal-image-data';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZProcessCompanySealImageRequestSchema,
  ZProcessCompanySealImageResponseSchema,
} from './process-company-seal-image.types';

/**
 * Returns the PNG a seal image would be stored as, and stores nothing. The
 * create form previews it and then uploads the same source image, which
 * create processes identically, so the image the creator confirms is the
 * image that is stored. Managers and admins only, as for create.
 */
export const processCompanySealImageRoute = authenticatedProcedure
  .input(ZProcessCompanySealImageRequestSchema)
  .output(ZProcessCompanySealImageResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { user } = ctx;
    const { payload, image } = input;
    const { organisationId } = payload;

    ctx.logger.info({
      input: {
        organisationId,
      },
    });

    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({
        organisationId,
        userId: user.id,
        roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
      }),
    });

    if (!organisation) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You do not have permission to create company seals for this organisation.',
      });
    }

    const png = await processCompanySealImage(image);

    return { imageDataUrl: `data:image/png;base64,${png.toString('base64')}` };
  });
