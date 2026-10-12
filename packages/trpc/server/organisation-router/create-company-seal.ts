import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { buildCompanySealImageData } from '@documenso/lib/server-only/company-seal/build-company-seal-image-data';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import { ZCreateCompanySealRequestSchema, ZCreateCompanySealResponseSchema } from './create-company-seal.types';

/**
 * Creates a company seal. Managers and admins of the organisation only. A seal
 * cannot be changed or removed afterwards, so the creator, IP address and user
 * agent recorded on the row are its whole audit record.
 */
export const createCompanySealRoute = authenticatedProcedure
  .input(ZCreateCompanySealRequestSchema)
  .output(ZCreateCompanySealResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { user, metadata } = ctx;
    const { payload, image } = input;
    const { organisationId, name, legalEntityName } = payload;

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

    const { imageData, imageSha256 } = await buildCompanySealImageData(image);

    const seal = await prisma.companySeal.create({
      data: {
        organisationId: organisation.id,
        name,
        legalEntityName,
        imageData,
        imageSha256,
        createdByUserId: user.id,
        createdByName: user.name ?? '',
        createdByEmail: user.email,
        createdFromIp: metadata.requestMetadata.ipAddress ?? null,
        createdUserAgent: metadata.requestMetadata.userAgent ?? null,
      },
    });

    return { id: seal.id };
  });
