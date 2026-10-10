import DocumentInviteEmailTemplate from '@documenso/email/templates/document-invite';
import { isRecipientEmailValidForSending } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import {
  DocumentSource,
  DocumentStatus,
  EnvelopeType,
  OrganisationType,
  RecipientRole,
  SendStatus,
} from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { isTemplateRecipientEmailPlaceholder } from '../../../constants/placeholder-recipients';
import { RECIPIENT_ROLE_TO_EMAIL_TYPE, RECIPIENT_ROLES_DESCRIPTION } from '../../../constants/recipient-roles';
import { AppError } from '../../../errors/app-error';
import { buildEnvelopeEmailHeaders } from '../../../server-only/email/build-envelope-email-headers';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { assertLegacyEnvelopeAcceptsPdf } from '../../../server-only/pdf/normalize-pdf';
import { assertOrganisationRatesAndLimits } from '../../../server-only/rate-limit/assert-organisation-rates-and-limits';
import { updateRecipientNextReminder } from '../../../server-only/recipient/update-recipient-next-reminder';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import { renderCustomEmailTemplate } from '../../../utils/render-custom-email-template';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendSigningEmailJobDefinition } from './send-signing-email';

/**
 * Emails one recipient the invitation to act on a PENDING document.
 *
 * A V1 document whose stored PDF fails `assertLegacyEnvelopeAcceptsPdf`, the
 * send path's check, gets no invitation, whichever path queued this job.
 */
export const run = async ({ payload, io }: { payload: TSendSigningEmailJobDefinition; io: JobRunIO }) => {
  const { userId, documentId, recipientId, requestMetadata } = payload;

  const [user, envelope, recipient] = await Promise.all([
    prisma.user.findFirstOrThrow({
      where: {
        id: userId,
      },
      select: {
        id: true,
        email: true,
        name: true,
      },
    }),
    prisma.envelope.findFirstOrThrow({
      where: {
        ...unsafeBuildEnvelopeIdQuery(
          {
            type: 'documentId',
            id: documentId,
          },
          EnvelopeType.DOCUMENT,
        ),
        status: DocumentStatus.PENDING,
      },
      include: {
        documentMeta: true,
        envelopeItems: {
          select: {
            documentData: {
              select: {
                type: true,
                id: true,
                data: true,
                initialData: true,
              },
            },
          },
        },
        user: {
          select: {
            disabled: true,
          },
        },
        team: {
          select: {
            teamEmail: true,
            name: true,
          },
        },
      },
    }),
    prisma.recipient.findFirstOrThrow({
      where: {
        id: recipientId,
      },
    }),
  ]);

  const { documentMeta, team } = envelope;

  if (recipient.role === RecipientRole.CC) {
    return;
  }

  const isRecipientSigningRequestEmailEnabled = extractDerivedDocumentEmailSettings(
    envelope.documentMeta,
  ).recipientSigningRequest;

  if (!isRecipientSigningRequestEmailEnabled) {
    return;
  }

  const {
    branding,
    emailLanguage,
    settings,
    organisationType,
    senderEmail,
    replyToEmail,
    organisationId,
    claims,
    emailsDisabled,
    emailTransport,
  } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  // Don't send signing invitations if the organisation has email sending disabled or the owner is disabled (e.g. banned).
  if (envelope.user.disabled || emailsDisabled) {
    return;
  }

  // The callers check the PDF before queuing this job, but it may have changed
  // since (a two-step upload URL still accepts a new file), so check the bytes
  // stored now. Errors fetching the file are not refusals and propagate.
  if (envelope.internalVersion === 1) {
    for (const envelopeItem of envelope.envelopeItems) {
      const pdf = await getFileServerSide(envelopeItem.documentData);
      const refusal = await assertLegacyEnvelopeAcceptsPdf(pdf).then(
        () => null,
        (err: unknown) => AppError.parseError(err),
      );

      if (refusal) {
        io.logger.warn({
          msg: 'Signing invitation dropped: the document PDF fails the send check',
          envelopeId: envelope.id,
          recipientId: recipient.id,
          code: refusal.code,
        });

        return;
      }
    }
  }

  const customEmail = envelope?.documentMeta;
  const isDirectTemplate = envelope.source === DocumentSource.TEMPLATE_DIRECT_LINK;

  const recipientEmailType = RECIPIENT_ROLE_TO_EMAIL_TYPE[recipient.role];

  const { email, name } = recipient;
  const selfSigner = email === user.email;

  const i18n = await getI18nInstance(emailLanguage);

  const recipientActionVerb = i18n._(RECIPIENT_ROLES_DESCRIPTION[recipient.role].actionVerb).toLowerCase();

  let emailMessage = customEmail?.message || '';
  let emailSubject = i18n._(msg`Please ${recipientActionVerb} this document`);

  if (selfSigner) {
    emailMessage = i18n._(
      msg`You have initiated the document ${`"${envelope.title}"`} that requires you to ${recipientActionVerb} it.`,
    );
    emailSubject = i18n._(msg`Please ${recipientActionVerb} your document`);
  }

  if (isDirectTemplate) {
    emailMessage = i18n._(
      msg`A document was created by your direct template that requires you to ${recipientActionVerb} it.`,
    );
    emailSubject = i18n._(msg`Please ${recipientActionVerb} this document created by your direct template`);
  }

  if (organisationType === OrganisationType.ORGANISATION) {
    emailSubject = i18n._(msg`${team.name} invited you to ${recipientActionVerb} a document`);
    emailMessage = customEmail?.message ?? '';

    if (!emailMessage) {
      const inviterName = user.name || '';

      emailMessage = i18n._(
        settings.includeSenderDetails
          ? msg`${inviterName} on behalf of "${team.name}" has invited you to ${recipientActionVerb} the document "${envelope.title}".`
          : msg`${team.name} has invited you to ${recipientActionVerb} the document "${envelope.title}".`,
      );
    }
  }

  const customEmailTemplate = {
    'signer.name': name,
    'signer.email': email,
    'document.name': envelope.title,
  };

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';
  const signDocumentLink = `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`;
  const reportUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/report/${recipient.token}`;

  const template = createElement(DocumentInviteEmailTemplate, {
    documentName: envelope.title,
    inviterName: user.name || undefined,
    inviterEmail:
      organisationType === OrganisationType.ORGANISATION ? team?.teamEmail?.email || user.email : user.email,
    assetBaseUrl,
    signDocumentLink,
    customBody: renderCustomEmailTemplate(emailMessage, customEmailTemplate),
    role: recipient.role,
    selfSigner,
    organisationType,
    teamName: team?.name,
    teamEmail: team?.teamEmail?.email,
    includeSenderDetails: settings.includeSenderDetails,
    reportUrl,
  });

  // An in-person signer is allowed to have no email address, and the schema permits it.
  // Nothing is mailed to them, so nothing about a mail may be written down afterwards.
  // A placeholder address is never mailed. sendDocument refuses these, so reaching
  // here means a path that skipped it.
  const isPlaceholderRecipient = isTemplateRecipientEmailPlaceholder(recipient.email);

  if (isPlaceholderRecipient) {
    io.logger.warn({
      msg: 'Not mailing a signing request to a placeholder recipient',
      envelopeId: envelope.id,
      recipientId: recipient.id,
    });
  }

  const willSendEmail = !isPlaceholderRecipient && isRecipientEmailValidForSending(recipient);

  if (willSendEmail) {
    try {
      await assertOrganisationRatesAndLimits({
        organisationId,
        organisationClaim: claims,
        type: 'email',
        count: 1,
      });
    } catch (_err) {
      io.logger.warn({
        msg: 'Recipient signing email dropped: org rate limit exceeded',
        organisationId,
        recipientId: recipient.id,
        envelopeId: envelope.id,
      });

      // Job is consumed and NOT retried.
      return;
    }

    await io.runTask('send-signing-email', async () => {
      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, { lang: emailLanguage, branding }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      await emailTransport.sendMail({
        to: {
          name: recipient.name,
          address: recipient.email,
        },
        from: senderEmail,
        replyTo: replyToEmail,
        subject: renderCustomEmailTemplate(documentMeta?.subject || emailSubject, customEmailTemplate),
        html,
        text,
        headers: buildEnvelopeEmailHeaders({
          userId,
          envelopeId: envelope.id,
          teamId: envelope.teamId,
        }),
      });
    });
  }

  const sentAt = new Date();

  await io.runTask('update-recipient', async () => {
    await prisma.recipient.update({
      where: {
        id: recipient.id,
      },
      data: {
        sendStatus: SendStatus.SENT,
        sentAt,
      },
    });
  });

  // Compute the first reminder time based on the envelope's effective settings.
  await updateRecipientNextReminder({
    recipientId: recipient.id,
    envelopeId: envelope.id,
    sentAt,
    lastReminderSentAt: null,
  });

  // The EMAIL_SENT rows reach the signing certificate, which is the evidence produced
  // when a counterparty disputes a signature. A row here for a recipient who was never
  // mailed puts a false assertion on that document, so it is written only when an email
  // went out. Where there is no row the certificate falls back to the DOCUMENT_SENT
  // timestamp, which says the document was distributed without claiming a notification.
  if (!willSendEmail) {
    return;
  }

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
      envelopeId: envelope.id,
      user,
      requestMetadata,
      data: {
        emailType: recipientEmailType,
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        recipientRole: recipient.role,
        isResending: false,
      },
    }),
  });
};
