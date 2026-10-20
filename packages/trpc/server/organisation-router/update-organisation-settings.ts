import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { checkBrandingSave } from '@documenso/lib/server-only/branding/check-branding-save';
import { assertSignatureMethodsEnabled } from '@documenso/lib/server-only/document-meta/assert-signature-methods-enabled';
import { warnIgnoredEmailId } from '@documenso/lib/server-only/email/warn-ignored-email-id';
import { normalizeBrandingColors } from '@documenso/lib/utils/normalize-branding-colors';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { type SanitizeBrandingCssWarning, sanitizeBrandingCss } from '@documenso/lib/utils/sanitize-branding-css';
import { prisma } from '@documenso/prisma';
import { OrganisationType, Prisma } from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  ZUpdateOrganisationSettingsRequestSchema,
  ZUpdateOrganisationSettingsResponseSchema,
} from './update-organisation-settings.types';

export const updateOrganisationSettingsRoute = authenticatedProcedure
  .input(ZUpdateOrganisationSettingsRequestSchema)
  .output(ZUpdateOrganisationSettingsResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { user } = ctx;
    const { organisationId, data } = input;

    ctx.logger.info({
      input: {
        organisationId,
      },
    });

    const {
      // Document related settings.
      documentVisibility,
      documentLanguage,
      documentTimezone,
      documentDateFormat,
      includeSenderDetails,
      includeSigningCertificate,
      includeAuditLog,
      typedSignatureEnabled,
      uploadSignatureEnabled,
      drawSignatureEnabled,
      defaultRecipients,
      delegateDocumentOwnership,
      envelopeExpirationPeriod,
      reminderSettings,

      // Branding related settings.
      brandingEnabled,
      brandingUrl,
      brandingCompanyDetails,
      brandingColors,
      brandingCss,

      // Email related settings.
      emailId,
      emailReplyTo,
      // emailReplyToName,
      emailDocumentSettings,

      // AI features settings.
      aiFeaturesEnabled,
    } = data;

    if (Object.values(data).length === 0) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'No settings to update',
      });
    }

    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({
        organisationId,
        userId: user.id,
        roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
      }),
      include: {
        organisationGlobalSettings: true,
      },
    });

    if (!organisation) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You do not have permission to update this organisation.',
      });
    }

    warnIgnoredEmailId({ emailId, organisationId, logger: ctx.logger });

    const derivedTypedSignatureEnabled =
      typedSignatureEnabled ?? organisation.organisationGlobalSettings.typedSignatureEnabled;
    const derivedUploadSignatureEnabled =
      uploadSignatureEnabled ?? organisation.organisationGlobalSettings.uploadSignatureEnabled;
    const derivedDrawSignatureEnabled =
      drawSignatureEnabled ?? organisation.organisationGlobalSettings.drawSignatureEnabled;

    const derivedDelegateDocumentOwnership =
      delegateDocumentOwnership ?? organisation.organisationGlobalSettings.delegateDocumentOwnership;

    if (
      derivedTypedSignatureEnabled === false &&
      derivedUploadSignatureEnabled === false &&
      derivedDrawSignatureEnabled === false
    ) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'At least one signature type must be enabled',
      });
    }

    const isPersonalOrganisation = organisation.type === OrganisationType.PERSONAL;
    const currentIncludeSenderDetails = organisation.organisationGlobalSettings.includeSenderDetails;

    const isChangingIncludeSenderDetails =
      includeSenderDetails !== undefined && includeSenderDetails !== currentIncludeSenderDetails;

    // Personal teams cannot change the sender details — drop the field (no-op)
    // instead of rejecting the whole update.
    const derivedIncludeSenderDetails =
      isPersonalOrganisation && isChangingIncludeSenderDetails ? undefined : includeSenderDetails;

    // Sanitize custom branding CSS at write time so we can store the safe
    // result and skip per-render sanitisation. Warnings are returned to the
    // UI so the user can see what was dropped.
    let cssWarnings: SanitizeBrandingCssWarning[] | undefined;
    let sanitizedBrandingCss: string | undefined;

    if (brandingCss !== undefined) {
      const result = sanitizeBrandingCss(brandingCss);

      if (result.refused) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: `Branding stylesheet not saved: ${result.refused}.`,
        });
      }

      sanitizedBrandingCss = result.css;
      cssWarnings = result.warnings;
    }

    // Strip empty-string colour values; collapse to `null` when the payload
    // contains no overrides. Keeps the stored row clean and avoids storing
    // `{}` as a real "override of nothing" (matters more for teams, but the
    // org row stays tidy this way too).
    const normalizedBrandingColors = normalizeBrandingColors(brandingColors);

    // Unreadable colour pairs refuse the save; unreadable stylesheet pairs are dropped.
    const contrast = checkBrandingSave({
      css: sanitizedBrandingCss,
      colors: normalizedBrandingColors,
      storedCss: organisation.organisationGlobalSettings.brandingCss,
      storedColors: organisation.organisationGlobalSettings.brandingColors,
    });

    if (sanitizedBrandingCss !== undefined) {
      sanitizedBrandingCss = contrast.css ?? '';
      cssWarnings = [...(cssWarnings ?? []), ...contrast.warnings];
    }

    await prisma.$transaction(async (tx) => {
      // Locked in the order team.settings.update uses, the organisation's row and then its teams' rows, so the
      // merged methods checked here are the ones written: neither the organisation nor any team that inherits
      // from it can end with all three off (C94b).
      if (
        typedSignatureEnabled !== undefined ||
        uploadSignatureEnabled !== undefined ||
        drawSignatureEnabled !== undefined
      ) {
        const settingsId = organisation.organisationGlobalSettingsId;

        await tx.$queryRaw`SELECT "id" FROM "OrganisationGlobalSettings" WHERE "id" = ${settingsId} FOR UPDATE`;

        const stored = await tx.organisationGlobalSettings.findUniqueOrThrow({ where: { id: settingsId } });
        const merged = {
          typedSignatureEnabled: typedSignatureEnabled ?? stored.typedSignatureEnabled,
          uploadSignatureEnabled: uploadSignatureEnabled ?? stored.uploadSignatureEnabled,
          drawSignatureEnabled: drawSignatureEnabled ?? stored.drawSignatureEnabled,
        };

        if (!merged.typedSignatureEnabled && !merged.uploadSignatureEnabled && !merged.drawSignatureEnabled) {
          throw new AppError(AppErrorCode.INVALID_BODY, {
            message: 'At least one signature type must be enabled',
          });
        }

        const teamSettings = await tx.$queryRaw<
          Array<{
            typedSignatureEnabled: boolean | null;
            uploadSignatureEnabled: boolean | null;
            drawSignatureEnabled: boolean | null;
          }>
        >`SELECT s."typedSignatureEnabled", s."uploadSignatureEnabled", s."drawSignatureEnabled"
          FROM "TeamGlobalSettings" s JOIN "Team" t ON t."teamGlobalSettingsId" = s."id"
          WHERE t."organisationId" = ${organisationId} ORDER BY s."id" FOR UPDATE OF s`;

        for (const team of teamSettings) {
          assertSignatureMethodsEnabled({
            typedSignatureEnabled: team.typedSignatureEnabled ?? merged.typedSignatureEnabled,
            uploadSignatureEnabled: team.uploadSignatureEnabled ?? merged.uploadSignatureEnabled,
            drawSignatureEnabled: team.drawSignatureEnabled ?? merged.drawSignatureEnabled,
          });
        }
      }

      await tx.organisation.update({
        where: {
          id: organisationId,
        },
        data: {
          organisationGlobalSettings: {
            update: {
              // Document related settings.
              documentVisibility,
              documentLanguage,
              documentTimezone,
              documentDateFormat,
              includeSenderDetails: derivedIncludeSenderDetails,
              includeSigningCertificate,
              includeAuditLog,
              typedSignatureEnabled,
              uploadSignatureEnabled,
              drawSignatureEnabled,
              defaultRecipients: defaultRecipients === null ? Prisma.DbNull : defaultRecipients,
              delegateDocumentOwnership: derivedDelegateDocumentOwnership,
              envelopeExpirationPeriod: envelopeExpirationPeriod === null ? Prisma.DbNull : envelopeExpirationPeriod,
              reminderSettings: reminderSettings === null ? Prisma.DbNull : reminderSettings,

              // Branding related settings.
              brandingEnabled,
              brandingUrl,
              brandingCompanyDetails,
              brandingColors: normalizedBrandingColors === null ? Prisma.DbNull : normalizedBrandingColors,
              brandingCss: sanitizedBrandingCss,

              // Email related settings.
              emailReplyTo,
              // emailReplyToName,
              emailDocumentSettings,

              // AI features settings.
              aiFeaturesEnabled,
            },
          },
        },
      });
    });

    return {
      cssWarnings: cssWarnings && cssWarnings.length > 0 ? cssWarnings : undefined,
    };
  });
