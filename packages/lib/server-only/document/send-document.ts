import { resolveExpiresAt } from '@documenso/lib/constants/envelope-expiration';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { checkboxValidationSigns } from '@documenso/ui/primitives/document-flow/field-items-advanced-settings/constants';
import type { DocumentData, Envelope, EnvelopeItem, Field, Prisma, Recipient } from '@prisma/client';
import {
  DocumentDataType,
  DocumentSigningOrder,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SendStatus,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';

import { validateCheckboxLength } from '../../advanced-fields-validation/validate-checkbox';
import { isDirectTemplateRecipientEmail } from '../../constants/direct-templates';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import {
  ZCheckboxFieldMeta,
  ZDropdownFieldMeta,
  ZFieldAndMetaSchema,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZTextFieldMeta,
} from '../../types/field-meta';
import { SignatureLevel } from '../../types/signature-level';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import { deleteFile } from '../../universal/upload/delete-file';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { putFileServerSide, putNormalizedPdfFileServerSide } from '../../universal/upload/put-file.server';
import { isDocumentCompleted } from '../../utils/document';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { type EnvelopeIdOptions, mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { toCheckboxCustomText, toRadioCustomText } from '../../utils/fields';
import { logger } from '../../utils/logger';
import {
  assertNoPlaceholderRecipients,
  getRecipientsWithMissingFields,
  isRecipientEmailValidForSending,
} from '../../utils/recipients';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { insertFormValuesInPdf } from '../pdf/insert-form-values-in-pdf';
import { assertLegacyEnvelopeAcceptsPdf, normalizePdf } from '../pdf/normalize-pdf';
import { assertUserNotDisabledById } from '../user/assert-user-not-disabled';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export type SendDocumentOptions = {
  id: EnvelopeIdOptions;
  userId: number;
  teamId: number;
  sendEmail?: boolean;
  requestMetadata: ApiRequestMetadata;
};

/**
 * Sends a document for signing, or sends it again while it is PENDING.
 *
 * A V1 document's PDF is checked with `assertLegacyEnvelopeAcceptsPdf` on every
 * call, whatever the status, and a PDF that fails is refused before any
 * recipient is notified.
 */
export const sendDocument = async ({ id, userId, teamId, sendEmail, requestMetadata }: SendDocumentOptions) => {
  // Refuse to send on behalf of a disabled account. Guards distribute /
  // redistribute / template-use routes, the bulk-send job, and direct
  // templates that auto-send on creation.
  await assertUserNotDisabledById({ userId });

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: {
        orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      },
      fields: true,
      documentMeta: true,
      envelopeItems: {
        select: {
          id: true,
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
      team: {
        select: {
          organisation: {
            select: {
              organisationClaim: {
                select: {
                  recipientCount: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  // A recipientCount of 0 means unlimited recipients are allowed.
  const maximumRecipientCount = envelope.team.organisation.organisationClaim.recipientCount;

  if (maximumRecipientCount > 0 && envelope.recipients.length > maximumRecipientCount) {
    throw new AppError('RECIPIENT_LIMIT_EXCEEDED', {
      message: `You cannot send a document with more than ${maximumRecipientCount} recipients`,
      statusCode: 400,
    });
  }

  if (isDocumentCompleted(envelope.status)) {
    throw new Error('Can not send completed document');
  }

  // Only the simple level can be signed and sealed. Remote signing through a
  // trust service provider has been removed, so an AES or QES envelope is
  // refused here rather than sent to recipients who could never complete it.
  if (envelope.signatureLevel !== SignatureLevel.SES) {
    logger.error({
      msg: 'Refusing to send an envelope that is not SES',
      envelopeId: envelope.id,
      signatureLevel: envelope.signatureLevel,
    });

    throw new AppError(AppErrorCode.CSC_INSTANCE_MODE_MISMATCH, {
      message: `Envelope ${envelope.id} has signature level ${envelope.signatureLevel}, which this instance cannot send.`,
    });
  }

  assertNoPlaceholderRecipients(envelope.recipients);

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  const signingOrder = envelope.documentMeta?.signingOrder || DocumentSigningOrder.PARALLEL;

  let recipientsToNotify = envelope.recipients;

  if (signingOrder === DocumentSigningOrder.SEQUENTIAL) {
    // Get the currently active recipient.
    recipientsToNotify = envelope.recipients
      .filter((r) => r.signingStatus === SigningStatus.NOT_SIGNED && r.role !== RecipientRole.CC)
      .slice(0, 1);
  }

  if (envelope.envelopeItems.length === 0) {
    throw new Error('Missing envelope items');
  }

  // Two-step creation stores a V1 document before its file is uploaded, so the
  // check made at creation proves nothing about the bytes stored now. Make it on
  // every send, a repeat send of a PENDING document included, before anyone is
  // emailed. Every item is checked before anything is written, and the bytes
  // checked are the ones stored at the send below, never a second read.
  const checkedPdfs: Array<{ envelopeItem: (typeof envelope.envelopeItems)[number]; pdf: Uint8Array }> = [];

  const isPdfStoredAtSend = envelope.status === DocumentStatus.DRAFT && Boolean(envelope.formValues);

  for (const envelopeItem of envelope.envelopeItems) {
    if (envelope.internalVersion !== 1 && !isPdfStoredAtSend) {
      continue;
    }

    const pdf = await getFileServerSide(envelopeItem.documentData);

    if (envelope.internalVersion === 1) {
      await assertLegacyEnvelopeAcceptsPdf(pdf);
    }

    checkedPdfs.push({ envelopeItem, pdf });
  }

  // Validate that recipients with auth requirements have a valid email.
  envelope.recipients.forEach((recipient) => {
    const auth = extractDocumentAuthMethods({
      documentAuth: envelope.authOptions,
      recipientAuth: recipient.authOptions,
    });

    if (
      recipient.role !== RecipientRole.CC &&
      (auth.recipientAccessAuthRequired || auth.recipientActionAuthRequired) &&
      !isRecipientEmailValidForSending(recipient)
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} requires an email because they have auth requirements.`,
      });
    }
  });

  // Validate that recipients who require fields (e.g., signers need signature fields) have them.
  const recipientsWithMissingFields = getRecipientsWithMissingFields(envelope.recipients, envelope.fields);

  if (recipientsWithMissingFields.length > 0) {
    const missingRecipientDescriptions = recipientsWithMissingFields
      .map((r) => (r.name ? `${r.name} (${r.email}, id: ${r.id})` : `${r.email} (id: ${r.id})`))
      .join(', ');

    throw new AppError(AppErrorCode.MISSING_SIGNATURE_FIELD, {
      message: `The following recipients are missing required fields: ${missingRecipientDescriptions}. Signers must have at least one signature field.`,
    });
  }

  // Stored only once every refusal above has been made, so a refused send
  // leaves the upload where its owner can replace it.
  const stagedPdfs = envelope.status === DocumentStatus.DRAFT ? await stagePdfsForSend(envelope, checkedPdfs) : [];

  const allRecipientsHaveNoActionToTake = envelope.recipients.every(
    (recipient) => recipient.role === RecipientRole.CC || recipient.signingStatus === SigningStatus.SIGNED,
  );

  if (allRecipientsHaveNoActionToTake) {
    if (stagedPdfs.length > 0) {
      await prisma
        .$transaction(async (tx) => commitStagedPdfs(tx, envelope.id, stagedPdfs))
        .catch(async (error) => {
          await deleteStagedPdfs(stagedPdfs);

          throw error;
        });
    }

    await jobs.triggerJob({
      name: 'internal.seal-document',
      payload: {
        documentId: legacyDocumentId,
        requestMetadata: requestMetadata?.requestMetadata,
      },
    });

    // Keep the return type the same for the `sendDocument` method
    return await prisma.envelope.findFirstOrThrow({
      where: {
        id: envelope.id,
      },
      include: {
        documentMeta: true,
        recipients: true,
      },
    });
  }

  const fieldsToAutoInsert: { fieldId: number; customText: string }[] = [];

  // Validate and autoinsert fields for V2 envelopes.
  if (envelope.internalVersion === 2) {
    for (const unknownField of envelope.fields) {
      const recipient = envelope.recipients.find((r) => r.id === unknownField.recipientId);

      if (!recipient) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Recipient not found',
        });
      }

      const fieldToAutoInsert = extractFieldAutoInsertValues(unknownField, recipient);

      // Only auto-insert fields if the recipient has not been sent the document yet.
      if (fieldToAutoInsert && recipient.sendStatus !== SendStatus.SENT) {
        fieldsToAutoInsert.push(fieldToAutoInsert);
      }
    }
  }

  const updatedEnvelope = await prisma
    .$transaction(async (tx) => {
      await commitStagedPdfs(tx, envelope.id, stagedPdfs);

      if (envelope.status === DocumentStatus.DRAFT) {
        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT,
            envelopeId: envelope.id,
            metadata: requestMetadata,
            data: {},
          }),
        });
      }

      if (envelope.internalVersion === 2) {
        const autoInsertedFields = await Promise.all(
          fieldsToAutoInsert.map(async (field) => {
            // Warning: Only auto-insert fields if the recipient has not been sent the document yet.
            return await tx.field.update({
              where: {
                id: field.fieldId,
              },
              data: {
                customText: field.customText,
                inserted: true,
              },
            });
          }),
        );

        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELDS_AUTO_INSERTED,
            envelopeId: envelope.id,
            data: {
              fields: autoInsertedFields.map((field) => ({
                fieldId: field.id,
                fieldType: field.type,
                recipientId: field.recipientId,
              })),
            },
            // Don't put metadata or user here since it's a system event.
          }),
        });
      }

      const expiresAt = resolveExpiresAt(envelope.documentMeta?.envelopeExpirationPeriod ?? null);

      // Set expiresAt on each recipient that hasn't already signed/rejected.
      // Exclude CC recipients since they don't sign and shouldn't be subject to expiry.
      if (expiresAt) {
        await tx.recipient.updateMany({
          where: {
            envelopeId: envelope.id,
            signingStatus: {
              notIn: [SigningStatus.SIGNED, SigningStatus.REJECTED],
            },
            role: {
              not: RecipientRole.CC,
            },
          },
          data: {
            expiresAt,
            expirationNotifiedAt: null,
          },
        });
      }

      return await tx.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          status: DocumentStatus.PENDING,
        },
        include: {
          documentMeta: true,
          recipients: true,
        },
      });
    })
    .catch(async (error) => {
      await deleteStagedPdfs(stagedPdfs);

      throw error;
    });

  const isRecipientSigningRequestEmailEnabled = extractDerivedDocumentEmailSettings(
    envelope.documentMeta,
  ).recipientSigningRequest;

  // Only send email if one of the following is true:
  // - It is explicitly set
  // - The email is enabled for signing requests AND sendEmail is undefined
  if (sendEmail || (isRecipientSigningRequestEmailEnabled && sendEmail === undefined)) {
    await Promise.all(
      recipientsToNotify.map(async (recipient) => {
        if (recipient.sendStatus === SendStatus.SENT || recipient.role === RecipientRole.CC) {
          return;
        }

        await jobs.triggerJob({
          name: 'send.signing.requested.email',
          payload: {
            userId,
            documentId: legacyDocumentId,
            recipientId: recipient.id,
            requestMetadata: requestMetadata?.requestMetadata,
          },
        });
      }),
    );
  }

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_SENT,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(updatedEnvelope)),
    userId,
    teamId,
  });

  return updatedEnvelope;
};

type SendEnvelopeItem = Pick<EnvelopeItem, 'id'> & {
  documentData: Pick<DocumentData, 'id' | 'type' | 'data' | 'initialData'>;
};

/** A PDF written to a fresh key at send, not yet named by any row. */
type StagedPdf = {
  envelopeItemId: string;
  documentDataId: string;
  previousData: string;
  previousInitialData: string;
  data: string;
  initialData: string;
};

/**
 * Writes the PDFs a DRAFT document is sent with, from the bytes the send checked.
 *
 * A V1 document in object storage may name the key of a presigned upload URL,
 * which accepts a new file for an hour whatever the document's status.
 * Its checked bytes, prefilled when it has form values, are written to a key
 * that was never presigned and returned as staged; `commitStagedPdfs` points
 * the existing row at them inside the send's transaction. The uploaded object
 * itself is not deleted here: other rows (a duplicate, a template, a sealed
 * version) can name the same key, and deleting it safely needs the
 * reference-aware cleanup planned separately. Once no row names it nothing reads it, so a
 * late PUT has no effect.
 *
 * Any other document keeps the existing behaviour: only form values are
 * written, to a new row the item is pointed at.
 *
 * @param envelope the envelope being sent
 * @param checkedPdfs each item with the bytes the send read and checked for it
 * @returns the staged PDFs, empty when nothing was staged
 */
const stagePdfsForSend = async (
  envelope: Envelope,
  checkedPdfs: Array<{ envelopeItem: SendEnvelopeItem; pdf: Uint8Array }>,
) => {
  const staged: StagedPdf[] = [];

  try {
    for (const { envelopeItem, pdf } of checkedPdfs) {
      const { documentData } = envelopeItem;
      const isUploadKeyReplaced = envelope.internalVersion === 1 && documentData.type === DocumentDataType.S3_PATH;

      if (!envelope.formValues && !isUploadKeyReplaced) {
        continue;
      }

      const fileName = envelope.title.endsWith('.pdf') ? envelope.title : `${envelope.title}.pdf`;

      let stored = Buffer.from(pdf);

      if (envelope.formValues) {
        stored = await insertFormValuesInPdf({
          pdf: stored,
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          formValues: envelope.formValues as Record<string, string | number | boolean>,
        });
      }

      if (!isUploadKeyReplaced) {
        const newDocumentData = await putNormalizedPdfFileServerSide(
          { name: fileName, type: 'application/pdf', arrayBuffer: async () => Promise.resolve(stored) },
          { owner: { userId: envelope.userId, teamId: envelope.teamId } },
        );

        await prisma.envelopeItem.update({
          where: { id: envelopeItem.id },
          data: { documentDataId: newDocumentData.id },
        });

        continue;
      }

      const bytes = envelope.formValues ? await normalizePdf(stored) : stored;

      const { data } = await putFileServerSide({
        name: fileName,
        type: 'application/pdf',
        arrayBuffer: async () => Promise.resolve(bytes),
      });

      // Prefilled bytes replace both versions, as the new row did before.
      // Otherwise an initialData that differs from data (a document made from a
      // template) is left as it is.
      const initialData =
        envelope.formValues || documentData.initialData === documentData.data ? data : documentData.initialData;

      staged.push({
        envelopeItemId: envelopeItem.id,
        documentDataId: documentData.id,
        previousData: documentData.data,
        previousInitialData: documentData.initialData,
        data,
        initialData,
      });
    }

    return staged;
  } catch (error) {
    await deleteStagedPdfs(staged);

    throw error;
  }
};

/**
 * Points each staged item's existing DocumentData row at its staged key, in
 * the caller's transaction.
 *
 * The envelope row is taken first while it is still DRAFT, so a concurrent
 * send of the same document waits here and then finds it sent. Each item and
 * row must still be the revision the send checked; anything else is a
 * conflict, and the transaction rolls back.
 *
 * @param tx the send's transaction
 * @param envelopeId the envelope being sent
 * @param staged the PDFs staged by `stagePdfsForSend`
 */
const commitStagedPdfs = async (tx: Prisma.TransactionClient, envelopeId: string, staged: StagedPdf[]) => {
  if (staged.length === 0) {
    return;
  }

  const conflict = () =>
    new AppError(AppErrorCode.ENVELOPE_ITEM_REVISION_CONFLICT, {
      message: 'The document changed while it was being sent. Send it again.',
    });

  const { count: envelopes } = await tx.envelope.updateMany({
    where: { id: envelopeId, status: DocumentStatus.DRAFT },
    data: { status: DocumentStatus.DRAFT },
  });

  if (envelopes === 0) {
    throw conflict();
  }

  for (const pdf of [...staged].sort((a, b) => (a.envelopeItemId < b.envelopeItemId ? -1 : 1))) {
    const { count: items } = await tx.envelopeItem.updateMany({
      where: { id: pdf.envelopeItemId, documentDataId: pdf.documentDataId },
      data: { documentDataId: pdf.documentDataId },
    });

    const { count: rows } = await tx.documentData.updateMany({
      where: { id: pdf.documentDataId, data: pdf.previousData, initialData: pdf.previousInitialData },
      data: { data: pdf.data, initialData: pdf.initialData },
    });

    if (items === 0 || rows === 0) {
      throw conflict();
    }
  }
};

/**
 * Deletes every staged object that no row names, after a failed send.
 *
 * Best effort: a failed delete is logged and never replaces the error that
 * caused the cleanup. A commit whose acknowledgement was lost leaves a row
 * naming the object, which is then live and stays.
 *
 * @param staged the PDFs staged by `stagePdfsForSend`
 */
const deleteStagedPdfs = async (staged: StagedPdf[]) => {
  for (const { data } of staged) {
    try {
      const rowsNamingKey = await prisma.documentData.count({ where: { OR: [{ data }, { initialData: data }] } });

      if (rowsNamingKey === 0) {
        await deleteFile({ type: DocumentDataType.S3_PATH, data });
      }
    } catch (error) {
      logger.error({ msg: 'Failed to delete a PDF staged for send', key: data, error });
    }
  }
};

/**
 * Extracts the auto insertion values for a given field.
 *
 * If field is not auto insertable, returns `null`.
 */
export const extractFieldAutoInsertValues = (
  unknownField: Field,
  recipient: Pick<Recipient, 'email'>,
): { fieldId: number; customText: string } | null => {
  const parsedField = ZFieldAndMetaSchema.safeParse(unknownField);

  if (parsedField.error) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'One or more fields have invalid metadata. Error: ' + parsedField.error.message,
    });
  }

  const field = parsedField.data;
  const fieldId = unknownField.id;

  // Auto insert email fields if the recipient has a valid email.
  if (
    field.type === FieldType.EMAIL &&
    isRecipientEmailValidForSending(recipient) &&
    !isDirectTemplateRecipientEmail(recipient.email)
  ) {
    return {
      fieldId,
      customText: recipient.email,
    };
  }

  // Auto insert text fields with prefilled values.
  if (field.type === FieldType.TEXT) {
    const { text } = ZTextFieldMeta.parse(field.fieldMeta);

    if (text) {
      return {
        fieldId,
        customText: text,
      };
    }
  }

  // Auto insert number fields with prefilled values.
  if (field.type === FieldType.NUMBER) {
    const { value } = ZNumberFieldMeta.parse(field.fieldMeta);

    if (value) {
      return {
        fieldId,
        customText: value,
      };
    }
  }

  // Auto insert radio fields with the pre-checked value.
  if (field.type === FieldType.RADIO) {
    const { values = [] } = ZRadioFieldMeta.parse(field.fieldMeta);

    const checkedItemIndex = values.findIndex((value) => value.checked);

    if (checkedItemIndex !== -1) {
      return {
        fieldId,
        customText: toRadioCustomText(checkedItemIndex),
      };
    }
  }

  // Auto insert dropdown fields with the default value.
  if (field.type === FieldType.DROPDOWN) {
    const { defaultValue, values = [] } = ZDropdownFieldMeta.parse(field.fieldMeta);

    if (defaultValue && values.some((value) => value.value === defaultValue)) {
      return {
        fieldId,
        customText: defaultValue,
      };
    }
  }

  // Auto insert checkbox fields with the pre-checked values.
  if (field.type === FieldType.CHECKBOX) {
    const { values = [], validationRule, validationLength } = ZCheckboxFieldMeta.parse(field.fieldMeta);

    const checkedIndices: number[] = [];

    values.forEach((value, i) => {
      if (value.checked) {
        checkedIndices.push(i);
      }
    });

    let isValid = true;

    if (validationRule && validationLength) {
      const validation = checkboxValidationSigns.find((sign) => sign.label === validationRule);

      if (!validation) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Invalid checkbox validation rule',
        });
      }

      isValid = validateCheckboxLength(checkedIndices.length, validation.value, validationLength);
    }

    if (isValid && checkedIndices.length > 0) {
      return {
        fieldId,
        customText: toCheckboxCustomText(checkedIndices),
      };
    }
  }

  return null;
};
