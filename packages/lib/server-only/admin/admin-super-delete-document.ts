import DocumentCancelTemplate from '@documenso/email/templates/document-cancel';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { DocumentStatus, SendStatus, SigningStatus } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { isRecipientEmailValidForSending } from '../../utils/recipients';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { getEmailContext } from '../email/get-email-context';

export type AdminSuperDeleteDocumentOptions = {
  envelopeId: string;
  requestMetadata?: RequestMetadata;
};

export const adminSuperDeleteDocument = async ({ envelopeId, requestMetadata }: AdminSuperDeleteDocumentOptions) => {
  const envelope = await prisma.envelope.findUnique({
    where: {
      id: envelopeId,
    },
    include: {
      recipients: true,
      documentMeta: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  const { branding, settings, senderEmail, replyToEmail, emailTransport } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  const { user } = envelope;

  const isDocumentDeletedEmailEnabled = extractDerivedDocumentEmailSettings(envelope.documentMeta).documentDeleted;

  // Always hard delete if deleted from admin. Whether to tell the recipients is decided under the envelope lock that
  // rejection also takes, on the rows read under it, and the emails go out only after the purge commits. A pending
  // document a recipient has rejected was not cancelled, so nobody is told it was (#122).
  const { deleted, recipientsToNotify } = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ status: DocumentStatus }>>`
      SELECT "status" FROM "Envelope" WHERE "id" = ${envelopeId} FOR NO KEY UPDATE
    `;

    if (!locked) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Document not found',
      });
    }

    const lockedRecipients = await tx.recipient.findMany({ where: { envelopeId } });

    const hasRejection = lockedRecipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED);

    const notify =
      locked.status === DocumentStatus.PENDING && !hasRejection && isDocumentDeletedEmailEnabled
        ? lockedRecipients.filter(
            (recipient) => recipient.sendStatus === SendStatus.SENT && isRecipientEmailValidForSending(recipient),
          )
        : [];

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        envelopeId,
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_DELETED,
        user,
        requestMetadata,
        data: {
          type: 'HARD',
        },
      }),
    });

    return { deleted: await tx.envelope.delete({ where: { id: envelopeId } }), recipientsToNotify: notify };
  });

  await Promise.all(
    recipientsToNotify.map(async (recipient) => {
      const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';
      const template = createElement(DocumentCancelTemplate, {
        documentName: envelope.title,
        inviterName: user.name || undefined,
        inviterEmail: user.email,
        assetBaseUrl,
      });

      const lang = envelope.documentMeta?.language ?? settings.documentLanguage;

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, { lang, branding }),
        renderEmailWithI18N(template, {
          lang,
          branding,
          plainText: true,
        }),
      ]);

      const i18n = await getI18nInstance(lang);

      await emailTransport.sendMail({
        to: {
          address: recipient.email,
          name: recipient.name,
        },
        from: senderEmail,
        replyTo: replyToEmail,
        subject: i18n._(msg`Document Cancelled`),
        html,
        text,
      });
    }),
  );

  return deleted;
};
