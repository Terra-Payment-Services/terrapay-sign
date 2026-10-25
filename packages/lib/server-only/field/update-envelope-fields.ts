import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData, diffFieldChanges } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapFieldToLegacyField } from '../../utils/fields';
import { canRecipientFieldsBeModified } from '../../utils/recipients';
import {
  lockFieldsSparingSeals,
  refuseCompanySeal,
  resolveCompanySealFieldMeta,
} from '../company-seal/company-seal-field';
import { assertEnvelopeMutable } from '../envelope/assert-envelope-mutable';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertRecipientFieldsModifiableUnderLock } from '../recipient/lock-envelope-for-owner-edit';
import { assertFieldTypesSupported } from './assert-field-types-supported';

export interface UpdateEnvelopeFieldsOptions {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;
  type?: EnvelopeType | null; // Only used to enforce the type.
  fields: {
    id: number;
    type?: FieldType;
    pageNumber?: number;
    envelopeItemId?: string;
    pageX?: number;
    pageY?: number;
    width?: number;
    height?: number;
    fieldMeta?: TFieldMetaSchema;
  }[];
  requestMetadata: ApiRequestMetadata;
  /** Set by the V1 routes, which must not change or create a company seal field. */
  protectCompanySeals?: boolean;
}

export const updateEnvelopeFields = async ({
  userId,
  teamId,
  id,
  type = null,
  fields,
  requestMetadata,
  protectCompanySeals = false,
}: UpdateEnvelopeFieldsOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      fields: true,
      envelopeItems: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope not found',
    });
  }

  await assertEnvelopeMutable(envelope);

  if (envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Envelope already complete',
    });
  }

  assertFieldTypesSupported(
    envelope.internalVersion,
    fields.flatMap((field) => (field.type ? [field.type] : [])),
  );

  const fieldsToUpdate = fields.map((field) => {
    const originalField = envelope.fields.find((existingField) => existingField.id === field.id);

    if (!originalField) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Field with id ${field.id} not found`,
      });
    }

    if (
      protectCompanySeals &&
      (originalField.type === FieldType.COMPANY_SEAL || field.type === FieldType.COMPANY_SEAL)
    ) {
      throw refuseCompanySeal();
    }

    const recipient = envelope.recipients.find((recipient) => recipient.id === originalField.recipientId);

    // Each field MUST have a recipient associated with it.
    if (!recipient) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient attached to field ${field.id} not found`,
      });
    }

    // Check whether the recipient associated with the field can be modified.
    if (!canRecipientFieldsBeModified(recipient, envelope.fields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot modify a field where the recipient has already interacted with the document',
      });
    }

    const fieldType = field.type || originalField.type;
    const fieldMetaType = field.fieldMeta?.type || originalField.fieldMeta?.type;

    // Not going to mess with V1 envelopes.
    if (envelope.internalVersion === 2 && fieldMetaType && fieldMetaType.toLowerCase() !== fieldType.toLowerCase()) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Field meta type does not match the field type',
      });
    }

    if (field.envelopeItemId && !envelope.envelopeItems.some((item) => item.id === field.envelopeItemId)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Envelope item not found',
      });
    }

    return {
      originalField,
      updateData: field,
      recipientEmail: recipient.email,
    };
  });

  for (const field of fieldsToUpdate) {
    const fieldType = field.updateData.type || field.originalField.type;
    const recipient = envelope.recipients.find((r) => r.id === field.originalField.recipientId);

    if (fieldType === FieldType.COMPANY_SEAL && recipient) {
      field.updateData = {
        ...field.updateData,
        fieldMeta: await resolveCompanySealFieldMeta({
          envelope,
          recipient,
          fieldMeta: field.updateData.fieldMeta ?? field.originalField.fieldMeta,
        }),
      };
    }
  }

  const updatedFields = await prisma.$transaction(async (tx) => {
    await assertEnvelopeMutable(envelope, tx);

    await assertRecipientFieldsModifiableUnderLock(
      tx,
      envelope.id,
      fieldsToUpdate.map(({ originalField }) => originalField.recipientId),
    );

    if (protectCompanySeals) {
      await lockFieldsSparingSeals(
        tx,
        fieldsToUpdate.map(({ originalField }) => originalField),
      );
    }

    return await Promise.all(
      fieldsToUpdate.map(async ({ originalField, updateData, recipientEmail }) => {
        const updatedField = await tx.field.update({
          where: {
            id: updateData.id,
          },
          data: {
            type: updateData.type,
            page: updateData.pageNumber,
            positionX: updateData.pageX,
            positionY: updateData.pageY,
            width: updateData.width,
            height: updateData.height,
            fieldMeta: updateData.fieldMeta,
            envelopeItemId: updateData.envelopeItemId,
          },
        });

        // Handle field updated audit log.
        if (envelope.type === EnvelopeType.DOCUMENT) {
          const changes = diffFieldChanges(originalField, updatedField);

          if (changes.length > 0) {
            await tx.documentAuditLog.create({
              data: createDocumentAuditLogData({
                type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED,
                envelopeId: envelope.id,
                metadata: requestMetadata,
                data: {
                  fieldId: updatedField.secondaryId,
                  fieldRecipientEmail: recipientEmail,
                  fieldRecipientId: updatedField.recipientId,
                  fieldType: updatedField.type,
                  changes,
                },
              }),
            });
          }
        }

        return updatedField;
      }),
    );
  });

  return {
    fields: updatedFields.map((field) => mapFieldToLegacyField(field, envelope)),
  };
};
