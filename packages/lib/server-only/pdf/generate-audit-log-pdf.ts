import type { TDocumentAuditLog } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import { i18n } from '@lingui/core';

import { ZSupportedLanguageCodeSchema } from '../../constants/i18n';
import { parseDocumentAuditLogData } from '../../utils/document-audit-logs';
import { getTranslations } from '../../utils/i18n';
import { getOrganisationClaimByTeamId } from '../organisation/get-organisation-claims';
import type { GenerateCertificatePdfOptions } from './generate-certificate-pdf';
import { type AuditLogSenderStandIn, hideSenderInAuditLogs } from './hide-sender-in-audit-logs';
import { renderAuditLogs } from './render-audit-logs';

type GenerateAuditLogPdfOptions = GenerateCertificatePdfOptions & {
  envelopeItems: string[];
  additionalAuditLogs?: TDocumentAuditLog[];
  /**
   * Set when sealing with "Send on Behalf of Team" off: the owner and other team members are shown as
   * this stand-in (the team). Leave unset for the owner's and admin's own audit-log downloads.
   */
  senderStandIn?: AuditLogSenderStandIn;
};

export const generateAuditLogPdf = async (options: GenerateAuditLogPdfOptions) => {
  const {
    envelope,
    envelopeOwner,
    envelopeItems,
    recipients,
    language,
    pageWidth,
    pageHeight,
    additionalAuditLogs = [],
    senderStandIn,
  } = options;

  const documentLanguage = ZSupportedLanguageCodeSchema.parse(language);

  const [organisationClaim, partialAuditLogs, messages] = await Promise.all([
    getOrganisationClaimByTeamId({ teamId: envelope.teamId }),
    getAuditLogs(envelope.id),
    getTranslations(documentLanguage),
  ]);

  i18n.loadAndActivate({
    locale: documentLanguage,
    messages,
  });

  const allAuditLogs: TDocumentAuditLog[] = [...additionalAuditLogs, ...partialAuditLogs];

  const auditLogs = senderStandIn
    ? hideSenderInAuditLogs(allAuditLogs, {
        recipientEmails: recipients.map((recipient) => recipient.email),
        ownerEmail: envelopeOwner.email,
        standIn: senderStandIn,
      })
    : allAuditLogs;

  const auditLogPages = await renderAuditLogs({
    envelope,
    envelopeOwner: senderStandIn ?? envelopeOwner,
    envelopeItems,
    recipients,
    auditLogs,
    hidePoweredBy: organisationClaim.flags.hidePoweredBy ?? false,
    pageWidth,
    pageHeight,
    i18n,
  });

  return await PDF.merge(auditLogPages, {
    includeAnnotations: true,
  });
};

const getAuditLogs = async (envelopeId: string) => {
  const auditLogs = await prisma.documentAuditLog.findMany({
    where: {
      envelopeId,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return auditLogs.map((auditLog) => parseDocumentAuditLogData(auditLog));
};
