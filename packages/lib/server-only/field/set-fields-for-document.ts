import { validateCheckboxField } from '@documenso/lib/advanced-fields-validation/validate-checkbox';
import { validateDropdownField } from '@documenso/lib/advanced-fields-validation/validate-dropdown';
import { validateNumberField } from '@documenso/lib/advanced-fields-validation/validate-number';
import { validateRadioField } from '@documenso/lib/advanced-fields-validation/validate-radio';
import { validateTextField } from '@documenso/lib/advanced-fields-validation/validate-text';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import {
  FIELD_META_DEFAULT_VALUES,
  type TFieldMetaSchema as FieldMeta,
  ZCheckboxFieldMeta,
  ZDropdownFieldMeta,
  ZFieldMetaSchema,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZTextFieldMeta,
} from '@documenso/lib/types/field-meta';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData, diffFieldChanges } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, type Field, FieldType, type Recipient, SigningStatus } from '@prisma/client';
import { isDeepEqual } from 'remeda';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapFieldToLegacyField } from '../../utils/fields';
import { canRecipientBeModified, canRecipientFieldsBeModified } from '../../utils/recipients';
import {
  assertLegacySetFieldsSparesSeals,
  lockFieldsSparingSeals,
  resolveCompanySealFieldMeta,
} from '../company-seal/company-seal-field';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { lockEnvelopeForOwnerEdit } from '../recipient/lock-envelope-for-owner-edit';

export interface SetFieldsForDocumentOptions {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;
  fields: FieldData[];
  requestMetadata: ApiRequestMetadata;
  /** Set by the V1 routes, which may only keep each stored company seal as it is. */
  protectCompanySeals?: boolean;
}

export const setFieldsForDocument = async ({
  userId,
  teamId,
  id,
  fields,
  requestMetadata,
  protectCompanySeals = false,
}: SetFieldsForDocumentOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      envelopeItems: {
        select: {
          id: true,
        },
      },
      fields: {
        include: {
          recipient: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  if (envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Document already complete',
    });
  }

  const existingFields = envelope.fields;

  if (protectCompanySeals) {
    assertLegacySetFieldsSparesSeals(existingFields, fields);
  }

  const removedFields = existingFields.filter(
    (existingField) => !fields.find((field) => field.id === existingField.id),
  );

  // Same shape as the recipient removal path. An inserted field holds what the
  // recipient put on the document, and `Signature.fieldId` cascades,
  // so deleting one throws the signature away. Modifying an inserted field
  // already throws below.
  const insertedRemovals = removedFields.filter((removedField) => removedField.inserted);

  if (insertedRemovals.length > 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Cannot remove a field that the recipient has already filled in',
    });
  }

  // A rejecter's fields stay as they were until the seal records the rejection (#121).
  const isRejecterField = (field: { recipientId: number | null }, recipients: Recipient[]) =>
    recipients.some(
      (recipient) => recipient.id === field.recipientId && recipient.signingStatus === SigningStatus.REJECTED,
    );

  if (removedFields.some((removedField) => isRejecterField(removedField, envelope.recipients))) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Cannot remove a field of a recipient who has rejected the document',
    });
  }

  const linkedFields = fields.map((field) => {
    const existing = existingFields.find((existingField) => existingField.id === field.id);

    const recipient = envelope.recipients.find((recipient) => recipient.id === field.recipientId);

    // Check whether the field is being attached to an allowed envelope item.
    const foundEnvelopeItem = envelope.envelopeItems.find((envelopeItem) => envelopeItem.id === field.envelopeItemId);

    if (!foundEnvelopeItem) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Envelope item ${field.envelopeItemId} not found`,
      });
    }

    // Each field MUST have a recipient associated with it.
    if (!recipient) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient not found for field ${field.id}`,
      });
    }

    // The upsert below never moves a field to another recipient, so the check must be made against the recipient
    // the field actually belongs to; a field id submitted under someone else refuses (#121).
    if (existing && existing.recipientId !== field.recipientId) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Field ${field.id} belongs to another recipient`,
      });
    }

    // Check whether the existing field can be modified.
    if (existing && hasFieldBeenChanged(existing, field) && !canRecipientFieldsBeModified(recipient, existingFields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot modify a field where the recipient has already interacted with the document',
      });
    }

    // Prevent creating new fields when recipient has interacted with the document.
    if (!existing && !canRecipientFieldsBeModified(recipient, existingFields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot modify a field where the recipient has already interacted with the document',
      });
    }

    return {
      ...field,
      _persisted: existing,
      _recipient: recipient,
    };
  });

  for (const field of linkedFields) {
    if (field.type === FieldType.COMPANY_SEAL) {
      field.fieldMeta = await resolveCompanySealFieldMeta({
        envelope,
        recipient: field._recipient,
        fieldMeta: field.fieldMeta,
      });
    }
  }

  const persistedFields = await prisma.$transaction(async (tx) => {
    // The checks above, made again on rows read under the envelope lock that rejection and signing take (#121).
    const locked = await lockEnvelopeForOwnerEdit(tx, envelope.id);

    const lockedRemovals = locked.fields.filter((lockedField) =>
      removedFields.some((removedField) => removedField.id === lockedField.id),
    );

    // A removal is refused when the field is inserted or its recipient is frozen (rejected, holding any inserted
    // field whatever its role, or a signer who signed), judged on the rows under the lock. Omitting a field from the
    // list deletes it (#121).
    const isFrozenRemoval = (lockedField: (typeof locked.fields)[number]) => {
      const recipient = locked.recipients.find((candidate) => candidate.id === lockedField.recipientId);

      return lockedField.inserted || !recipient || !canRecipientBeModified(recipient, locked.fields);
    };

    if (lockedRemovals.some(isFrozenRemoval)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot remove a field of a recipient who has already interacted with the document',
      });
    }

    // The full rows as they stand under the lock; an owner edit may have committed since the first read.
    const lockedRows = await tx.field.findMany({ where: { envelopeId: envelope.id } });

    // A field of a recipient who can no longer be modified is never written. One the caller left as it read it is
    // skipped and returned as it now stands, so a stale list cannot write its old values over a newer edit.
    const frozenRows = new Map<number, Field>();

    for (const field of linkedFields) {
      const lockedField = field._persisted
        ? lockedRows.find((candidate) => candidate.id === field._persisted?.id)
        : undefined;

      if (field._persisted && (!lockedField || lockedField.recipientId !== field.recipientId)) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: `Field ${field._persisted.id} belongs to another recipient`,
        });
      }

      const lockedRecipient = locked.recipients.find((recipient) => recipient.id === field.recipientId);

      if (lockedRecipient && canRecipientFieldsBeModified(lockedRecipient, locked.fields)) {
        continue;
      }

      // A real change differs from the row under the lock and from what the caller read.
      const isChange =
        !field._persisted ||
        !lockedField ||
        (hasFieldBeenChanged(lockedField, field) && hasFieldBeenChanged(field._persisted, field));

      if (isChange) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Cannot modify a field where the recipient has already interacted with the document',
        });
      }

      frozenRows.set(lockedField.id, lockedField);
    }

    if (protectCompanySeals) {
      await lockFieldsSparingSeals(tx, [
        ...linkedFields.flatMap((field) => (field._persisted ? [field._persisted] : [])),
        ...removedFields,
      ]);
    }

    const upsertedFields = await Promise.all(
      linkedFields.map(async (field) => {
        const frozenRow = field._persisted ? frozenRows.get(field._persisted.id) : undefined;

        if (frozenRow) {
          return {
            ...frozenRow,
            formId: field.formId,
          };
        }

        const fieldSignerEmail = field._recipient.email.toLowerCase();

        const parsedFieldMeta = field.fieldMeta
          ? ZFieldMetaSchema.parse(field.fieldMeta)
          : FIELD_META_DEFAULT_VALUES[field.type];

        if (field.type === FieldType.TEXT && field.fieldMeta) {
          const textFieldParsedMeta = ZTextFieldMeta.parse(field.fieldMeta);
          const errors = validateTextField(textFieldParsedMeta.text || '', textFieldParsedMeta);

          if (errors.length > 0) {
            throw new Error(errors.join(', '));
          }
        }

        if (field.type === FieldType.NUMBER && field.fieldMeta) {
          const numberFieldParsedMeta = ZNumberFieldMeta.parse(field.fieldMeta);

          const errors = validateNumberField(String(numberFieldParsedMeta.value || ''), numberFieldParsedMeta, false);

          if (errors.length > 0) {
            throw new Error(errors.join(', '));
          }
        }

        if (field.type === FieldType.CHECKBOX) {
          if (field.fieldMeta) {
            const checkboxFieldParsedMeta = ZCheckboxFieldMeta.parse(field.fieldMeta);
            const errors = validateCheckboxField(
              checkboxFieldParsedMeta?.values?.map((item) => item.value) ?? [],
              checkboxFieldParsedMeta,
            );

            if (errors.length > 0) {
              throw new Error(errors.join(', '));
            }
          } else {
            throw new Error('To proceed further, please set at least one value for the Checkbox field');
          }
        }

        if (field.type === FieldType.RADIO) {
          if (field.fieldMeta) {
            const radioFieldParsedMeta = ZRadioFieldMeta.parse(field.fieldMeta);
            const checkedRadioFieldValue = radioFieldParsedMeta.values?.find((option) => option.checked)?.value;

            const errors = validateRadioField(checkedRadioFieldValue, radioFieldParsedMeta);

            if (errors.length > 0) {
              throw new Error(errors.join('. '));
            }
          } else {
            throw new Error('To proceed further, please set at least one value for the Radio field');
          }
        }

        if (field.type === FieldType.DROPDOWN) {
          if (field.fieldMeta) {
            const dropdownFieldParsedMeta = ZDropdownFieldMeta.parse(field.fieldMeta);
            const errors = validateDropdownField(undefined, dropdownFieldParsedMeta);

            if (errors.length > 0) {
              throw new Error(errors.join('. '));
            }
          } else {
            throw new Error('To proceed further, please set at least one value for the Dropdown field');
          }
        }

        const upsertedField = await tx.field.upsert({
          where: {
            id: field._persisted?.id ?? -1,
            envelopeId: envelope.id,
            envelopeItemId: field.envelopeItemId,
          },
          update: {
            page: field.pageNumber,
            positionX: field.pageX,
            positionY: field.pageY,
            width: field.pageWidth,
            height: field.pageHeight,
            fieldMeta: parsedFieldMeta,
          },
          create: {
            type: field.type,
            page: field.pageNumber,
            positionX: field.pageX,
            positionY: field.pageY,
            width: field.pageWidth,
            height: field.pageHeight,
            customText: '',
            inserted: false,
            fieldMeta: parsedFieldMeta,
            envelope: {
              connect: {
                id: envelope.id,
              },
            },
            envelopeItem: {
              connect: {
                id: field.envelopeItemId,
                envelopeId: envelope.id,
              },
            },
            recipient: {
              connect: {
                id: field._recipient.id,
                envelopeId: envelope.id,
              },
            },
          },
        });

        if (upsertedField.recipientId === null) {
          throw new Error('Not possible');
        }

        const baseAuditLog = {
          fieldId: upsertedField.secondaryId,
          fieldRecipientEmail: fieldSignerEmail,
          fieldRecipientId: upsertedField.recipientId,
          fieldType: upsertedField.type,
        };

        const changes = field._persisted ? diffFieldChanges(field._persisted, upsertedField) : [];

        // Handle field updated audit log.
        if (field._persisted && changes.length > 0) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED,
              envelopeId: envelope.id,
              metadata: requestMetadata,
              data: {
                changes,
                ...baseAuditLog,
              },
            }),
          });
        }

        // Handle field created audit log.
        if (!field._persisted) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_CREATED,
              envelopeId: envelope.id,
              metadata: requestMetadata,
              data: {
                ...baseAuditLog,
              },
            }),
          });
        }

        return {
          ...upsertedField,
          formId: field.formId,
        };
      }),
    );

    if (removedFields.length > 0) {
      await tx.field.deleteMany({
        where: {
          id: {
            in: removedFields.map((field) => field.id),
          },
        },
      });

      await tx.documentAuditLog.createMany({
        data: removedFields.map((field) =>
          createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_DELETED,
            envelopeId: envelope.id,
            metadata: requestMetadata,
            data: {
              fieldId: field.secondaryId,
              fieldRecipientEmail: field.recipient?.email ?? '',
              fieldRecipientId: field.recipientId ?? -1,
              fieldType: field.type,
            },
          }),
        ),
      });
    }

    return upsertedFields;
  });

  // Filter out fields that have been removed or have been updated.
  const mappedFilteredFields = existingFields
    .filter((field) => {
      const isRemoved = removedFields.find((removedField) => removedField.id === field.id);
      const isUpdated = persistedFields.find((persistedField) => persistedField.id === field.id);

      return !isRemoved && !isUpdated;
    })
    .map((field) => ({
      ...mapFieldToLegacyField(field, envelope),
      formId: undefined,
    }));

  const mappedPersistentFields = persistedFields.map((field) => ({
    ...mapFieldToLegacyField(field, envelope),
    formId: field?.formId,
  }));

  return {
    fields: [...mappedFilteredFields, ...mappedPersistentFields],
  };
};

/**
 * If you change this you MUST update the `hasFieldBeenChanged` function.
 */
type FieldData = {
  id?: number | null;
  formId?: string;
  envelopeItemId: string;
  type: FieldType;
  recipientId: number;
  pageNumber: number;
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
  fieldMeta?: FieldMeta;
};

const hasFieldBeenChanged = (field: Field, newFieldData: FieldData) => {
  const currentFieldMeta = field.fieldMeta || null;
  const newFieldMeta = newFieldData.fieldMeta || null;

  return (
    field.envelopeItemId !== newFieldData.envelopeItemId ||
    field.type !== newFieldData.type ||
    field.page !== newFieldData.pageNumber ||
    field.positionX.toNumber() !== newFieldData.pageX ||
    field.positionY.toNumber() !== newFieldData.pageY ||
    field.width.toNumber() !== newFieldData.pageWidth ||
    field.height.toNumber() !== newFieldData.pageHeight ||
    !isDeepEqual(currentFieldMeta, newFieldMeta)
  );
};
