import { DocumentCompletedEmailTemplate } from '@documenso/email/templates/document-completed';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { DocumentSource, EnvelopeType, RecipientRole } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { assertOrganisationRatesAndLimits } from '../../../server-only/rate-limit/assert-organisation-rates-and-limits';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import { isRecipientEmailValidForSending } from '../../../utils/recipients';
import { renderCustomEmailTemplate } from '../../../utils/render-custom-email-template';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import { formatDocumentsPath } from '../../../utils/teams';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendDocumentCompletedEmailsJobDefinition } from './send-document-completed-emails';

/**
 * Completion emails for an executed contract, sent to the owner and to every
 * recipient.
 *
 * ## Which way this fails
 *
 * Sending an email and recording that it was sent cannot be made one atomic
 * step, so one of two bad outcomes has to be accepted. This code accepts the
 * duplicate. Writing a marker ahead of the send would mean a transport failure
 * right afterwards leaves a recipient marked as mailed when nothing reached
 * them, and nobody finds out, because the failure was recorded as a success.
 * Transports fail often, through throttling or a reset connection. The write
 * that follows a successful send fails only when the database has gone away,
 * and that fails the whole job anyway. So every marker here goes after the
 * send, and a rare second copy is the price of never losing a first one.
 *
 * ## Why the audit row and not only the job marker
 *
 * `runTask` namespaces its markers by job id. A second enqueue of this job for
 * the same envelope, which a retried parent or a duplicated trigger produces,
 * starts with a clean set of markers and mails everybody all over again. The
 * audit row this handler writes after each send does not move with the job, so
 * it is read first and a party who already holds their copy is passed over.
 * That covers the narrower case too, where the marker write fails after a send
 * that succeeded.
 *
 * What it cannot cover is the audit insert failing after the send. Nothing
 * can: the email has gone and there is no record that it went. That window is
 * one database write wide and it fails towards the duplicate, which is the
 * side chosen above.
 */

/**
 * Has the completed-document email for one party already gone out for this
 * envelope?
 *
 * Read from the audit log rather than from the job runtime, because the audit
 * log survives the job that wrote it. `recipientRole` is part of the test so
 * that the owner, whose row carries a user id, cannot be confused with a
 * recipient whose row carries a recipient id.
 */
const hasCompletionEmailBeenSent = async (envelopeId: string, recipientId: number, recipientRole: string) => {
  const sent = await prisma.documentAuditLog.findFirst({
    where: {
      envelopeId,
      type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
      AND: [
        { data: { path: ['emailType'], equals: 'DOCUMENT_COMPLETED' } },
        { data: { path: ['recipientId'], equals: recipientId } },
        { data: { path: ['recipientRole'], equals: recipientRole } },
      ],
    },
    select: { id: true },
  });

  return sent !== null;
};

export const run = async ({ payload, io }: { payload: TSendDocumentCompletedEmailsJobDefinition; io: JobRunIO }) => {
  const { envelopeId, requestMetadata } = payload;

  const envelope = await prisma.envelope.findUnique({
    where: unsafeBuildEnvelopeIdQuery({ type: 'envelopeId', id: envelopeId }, EnvelopeType.DOCUMENT),
    include: {
      envelopeItems: {
        include: {
          documentData: {
            select: {
              type: true,
              id: true,
              data: true,
            },
          },
        },
      },
      documentMeta: true,
      recipients: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          disabled: true,
        },
      },
      team: {
        select: {
          id: true,
          url: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  const isDirectTemplate = envelope?.source === DocumentSource.TEMPLATE_DIRECT_LINK;

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  const { branding, emailLanguage, senderEmail, replyToEmail, organisationId, claims, emailsDisabled, emailTransport } =
    await getEmailContext({
      emailType: 'RECIPIENT',
      source: {
        type: 'team',
        teamId: envelope.teamId,
      },
      meta: envelope.documentMeta,
    });

  // Don't send completion emails if the organisation has email sending disabled or the owner is disabled (e.g. banned).
  if (envelope.user.disabled || emailsDisabled) {
    return;
  }

  const { user: owner } = envelope;

  const completedDocumentEmailAttachments = await Promise.all(
    envelope.envelopeItems.map(async (envelopeItem) => {
      const file = await getFileServerSide(envelopeItem.documentData);

      // Use the envelope title for version 1, and the envelope item title for version 2.
      const fileNameToUse = envelope.internalVersion === 1 ? envelope.title : envelopeItem.title + '.pdf';

      return {
        filename: fileNameToUse.endsWith('.pdf') ? fileNameToUse : fileNameToUse + '.pdf',
        content: Buffer.from(file),
        contentType: 'application/pdf',
      };
    }),
  );

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  let documentOwnerDownloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(
    envelope.team?.url,
  )}/${envelope.id}`;

  if (envelope.team?.url) {
    documentOwnerDownloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}/t/${envelope.team.url}/documents/${envelope.id}`;
  }

  const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);
  const isDocumentCompletedEmailEnabled = emailSettings.documentCompleted;
  const isOwnerDocumentCompletedEmailEnabled = emailSettings.ownerDocumentCompleted;

  // Send email to document owner if:
  // 1. Owner document completed emails are enabled AND
  // 2. Either:
  //    - The owner is not a recipient, OR
  //    - Recipient emails are disabled
  if (
    isOwnerDocumentCompletedEmailEnabled &&
    (!envelope.recipients.find((recipient) => recipient.email === owner.email) || !isDocumentCompletedEmailEnabled)
  ) {
    // One task per email, so a retry of this job resumes where it stopped.
    // Without it a transport failure part way through sends everybody who
    // already had their copy a second one.
    await io.runTask('send-document-completed-emails:owner', async () => {
      if (await hasCompletionEmailBeenSent(envelope.id, owner.id, 'OWNER')) {
        return;
      }

      const template = createElement(DocumentCompletedEmailTemplate, {
        documentName: envelope.title,
        assetBaseUrl,
        downloadLink: documentOwnerDownloadLink,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, { lang: emailLanguage, branding }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      const i18n = await getI18nInstance(emailLanguage);

      await emailTransport.sendMail({
        to: [
          {
            name: owner.name || '',
            address: owner.email,
          },
        ],
        from: senderEmail,
        replyTo: replyToEmail,
        subject: i18n._(msg`Signing Complete!`),
        html,
        text,
        attachments: completedDocumentEmailAttachments,
      });

      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
          envelopeId: envelope.id,
          user: null,
          requestMetadata,
          data: {
            emailType: 'DOCUMENT_COMPLETED',
            recipientEmail: owner.email,
            recipientName: owner.name ?? '',
            recipientId: owner.id,
            recipientRole: 'OWNER',
            isResending: false,
          },
        }),
      });
    });
  }

  if (!isDocumentCompletedEmailEnabled) {
    return;
  }

  const recipientsToNotify = envelope.recipients.filter((recipient) => isRecipientEmailValidForSending(recipient));

  await Promise.all(
    recipientsToNotify.map(async (recipient) => {
      // One task per recipient, keyed on the recipient rather than the batch.
      // The job system retries this handler from the top, so without a marker
      // of its own a transport failure on the fifth signer sends the first four
      // their completion email all over again.
      await io.runTask(`send-document-completed-emails:recipient:${recipient.id}`, async () => {
        if (await hasCompletionEmailBeenSent(envelope.id, recipient.id, recipient.role)) {
          return;
        }

        // A CC recipient never asked to be part of this document, so their completion
        // email is effectively unsolicited. Meter it against the organisation email
        // quota/stats so it is correctly logged.
        if (recipient.role === RecipientRole.CC) {
          try {
            await assertOrganisationRatesAndLimits({
              organisationId,
              organisationClaim: claims,
              type: 'email',
              count: 1,
            });
          } catch (_err) {
            io.logger.warn({
              msg: 'CC completion email dropped: org email limit exceeded',
              organisationId,
              recipientId: recipient.id,
              envelopeId: envelope.id,
            });

            // On rate/quota exceeded, early return to allow other recipients to be processed.
            // The task is marked done, so a later retry of this job does not
            // meter the same CC recipient against the quota a second time.
            return;
          }
        }

        const customEmailTemplate = {
          'signer.name': recipient.name,
          'signer.email': recipient.email,
          'document.name': envelope.title,
        };

        const downloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}/complete`;
        const reportUrl =
          recipient.role === RecipientRole.CC ? `${NEXT_PUBLIC_WEBAPP_URL()}/report/${recipient.token}` : undefined;

        const template = createElement(DocumentCompletedEmailTemplate, {
          documentName: envelope.title,
          assetBaseUrl,
          downloadLink: recipient.email === owner.email ? documentOwnerDownloadLink : downloadLink,
          customBody:
            isDirectTemplate && envelope.documentMeta?.message
              ? renderCustomEmailTemplate(envelope.documentMeta.message, customEmailTemplate)
              : undefined,
          reportUrl,
        });

        const [html, text] = await Promise.all([
          renderEmailWithI18N(template, { lang: emailLanguage, branding }),
          renderEmailWithI18N(template, {
            lang: emailLanguage,
            branding,
            plainText: true,
          }),
        ]);

        const i18n = await getI18nInstance(emailLanguage);

        await emailTransport.sendMail({
          to: [
            {
              name: recipient.name,
              address: recipient.email,
            },
          ],
          from: senderEmail,
          replyTo: replyToEmail,
          subject:
            isDirectTemplate && envelope.documentMeta?.subject
              ? renderCustomEmailTemplate(envelope.documentMeta.subject, customEmailTemplate)
              : i18n._(msg`Signing Complete!`),
          html,
          text,
          attachments: completedDocumentEmailAttachments,
        });

        await prisma.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
            envelopeId: envelope.id,
            user: null,
            requestMetadata,
            data: {
              emailType: 'DOCUMENT_COMPLETED',
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientId: recipient.id,
              recipientRole: recipient.role,
              isResending: false,
            },
          }),
        });
      });
    }),
  );
};
