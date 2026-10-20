import crypto from 'node:crypto';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import {
  hasRecipientAccess2FACookie,
  isRecipientAccess2FARequired,
} from '@documenso/lib/server-only/2fa/email/recipient-access-2fa-cookie';
import {
  assertCompanySealApplicable,
  getCompanySealImage,
} from '@documenso/lib/server-only/company-seal/company-seal-field';
import { assertRecipientAccessAuthorized } from '@documenso/lib/server-only/document/assert-recipient-access-authorized';
import { validateFieldAuth } from '@documenso/lib/server-only/document/validate-field-auth';
import { assertRecipientsTurn } from '@documenso/lib/server-only/recipient/assert-recipients-turn';
import { lockEnvelopeForRecipientAction } from '@documenso/lib/server-only/recipient/lock-envelope-for-recipient-action';
import {
  assertSignatureMethodAllowed,
  assertValidSignatureValue,
} from '@documenso/lib/server-only/signature/assert-valid-signature-value';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { DocumentAuth } from '@documenso/lib/types/document-auth';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import { assertRecipientNotExpired } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { match } from 'ts-pattern';

import { procedure } from '../trpc';
import { ZSignEnvelopeFieldRequestSchema, ZSignEnvelopeFieldResponseSchema } from './sign-envelope-field.types';

// Note that this is an unauthenticated public procedure route.
export const signEnvelopeFieldRoute = procedure
  .input(ZSignEnvelopeFieldRequestSchema)
  .output(ZSignEnvelopeFieldResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, metadata } = ctx;
    const { token, fieldId, fieldValue, authOptions } = input;

    ctx.logger.info({
      input: {
        fieldId,
      },
    });

    const recipient = await prisma.recipient.findFirst({
      where: {
        token,
      },
    });

    if (!recipient) {
      throw new AppError(AppErrorCode.NOT_FOUND);
    }

    const field = await prisma.field.findFirst({
      where: {
        id: fieldId,
        recipient:
          recipient.role === RecipientRole.ASSISTANT
            ? {
                signingStatus: {
                  not: SigningStatus.SIGNED,
                },
                signingOrder: {
                  gte: recipient.signingOrder ?? 0,
                },
                envelopeId: recipient.envelopeId,
              }
            : {
                id: recipient.id,
              },
      },
      include: {
        envelope: {
          include: {
            recipients: true,
            documentMeta: true,
          },
        },
        recipient: true,
      },
    });

    if (!field) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Field ${fieldId} not found`,
      });
    }

    const { envelope } = field;
    const { documentMeta } = envelope;

    if (envelope.internalVersion !== 2) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Envelope ${envelope.id} is not a version 2 envelope`,
      });
    }

    if (
      (field.type === FieldType.SIGNATURE || field.type === FieldType.COMPANY_SEAL) &&
      recipient.id !== field.recipientId &&
      recipient.role === RecipientRole.ASSISTANT
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Assistant recipients cannot sign signature or company seal fields`,
      });
    }

    if (fieldValue.type !== field.type) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Selected values do not match the field values',
      });
    }

    if (envelope.deletedAt) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Document ${envelope.id} has been deleted`,
      });
    }

    if (envelope.status !== DocumentStatus.PENDING) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Document ${envelope.id} must be pending for signing`,
      });
    }

    // Both are checked because an assistant may insert values into a field belonging to
    // another recipient, and neither signing window may have closed. For every other
    // role these reference the same recipient.
    assertRecipientNotExpired(recipient);
    assertRecipientNotExpired(field.recipient);

    if (recipient.signingStatus === SigningStatus.SIGNED || field.recipient.signingStatus === SigningStatus.SIGNED) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} has already signed`,
      });
    }

    // Re-checked under the envelope lock inside each write, so a rejection that commits after the checks
    // above still stops this sign.
    const assertRecipientCanStillSign = async (tx: Prisma.TransactionClient) => {
      const actor = await lockEnvelopeForRecipientAction(tx, {
        envelopeId: envelope.id,
        recipientId: recipient.id,
        fieldRecipientId: field.recipientId,
      });

      // Under the lock, so a completion or reorder that commits first is seen; an assistant's own turn (#145).
      await assertRecipientsTurn(tx, { envelopeId: envelope.id, recipientId: recipient.id });

      if (actor.signingStatus === SigningStatus.SIGNED) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: `Recipient ${recipient.id} has already signed`,
        });
      }
    };

    if (field.fieldMeta?.readOnly) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Field ${fieldId} is read only`,
      });
    }

    // Unreachable code based on the above query but we need to satisfy TypeScript
    if (field.recipientId === null) {
      throw new Error(`Field ${fieldId} has no recipientId`);
    }

    await assertRecipientAccessAuthorized({
      documentAuthOptions: envelope.authOptions,
      recipient,
      userId: user?.id,
    });

    if (
      isRecipientAccess2FARequired({ documentAuthOptions: envelope.authOptions, recipient }) &&
      !(await hasRecipientAccess2FACookie({ headers: ctx.req.headers, recipientId: recipient.id }))
    ) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'The access code must be entered before signing',
        statusCode: 401,
      });
    }

    // Applying and removing a seal need the same session and membership as each other.
    const companySeal =
      field.type === FieldType.COMPANY_SEAL
        ? await assertCompanySealApplicable({ envelope, field, recipient, user })
        : null;

    const insertionValues = extractFieldInsertionValues({ fieldValue, field, documentMeta });

    // Early return for uninserting fields.
    if (!insertionValues.inserted) {
      return await prisma.$transaction(async (tx) => {
        await assertRecipientCanStillSign(tx);

        const updatedField = await tx.field.update({
          where: {
            id: field.id,
          },
          data: {
            customText: '',
            inserted: false,
          },
        });

        await tx.signature.deleteMany({
          where: {
            fieldId: field.id,
          },
        });

        if (recipient.role !== RecipientRole.ASSISTANT) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
              envelopeId: envelope.id,
              user: {
                name: recipient.name,
                email: recipient.email,
              },
              requestMetadata: metadata.requestMetadata,
              data: {
                field: field.type,
                fieldId: field.secondaryId,
              },
            }),
          });
        }

        return {
          signedField: updatedField,
        };
      });
    }

    const derivedRecipientActionAuth = await validateFieldAuth({
      documentAuthOptions: envelope.authOptions,
      recipient,
      field,
      userId: user?.id,
      authOptions,
    });

    const assistant = recipient.role === RecipientRole.ASSISTANT ? recipient : undefined;

    let signatureImageAsBase64 = null;
    let typedSignature = null;

    if (field.type === FieldType.SIGNATURE) {
      if (fieldValue.type !== FieldType.SIGNATURE) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: `Field ${fieldId} is not a signature field`,
        });
      }

      if (fieldValue.value) {
        ({ signatureImageAsBase64, typedSignature } = await assertValidSignatureValue({
          value: fieldValue.value,
          methods: documentMeta,
        }));
      }
    }

    // The seal image is snapshotted onto the document now, so a reseal never reads the seal row again.
    let companySealAuditData = null;

    if (companySeal) {
      const { bytes, dataUrl } = await getCompanySealImage(companySeal);

      signatureImageAsBase64 = dataUrl;
      companySealAuditData = {
        sealId: companySeal.id,
        sealName: companySeal.name,
        legalEntityName: companySeal.legalEntityName,
        imageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    }

    return await prisma.$transaction(async (tx) => {
      await assertRecipientCanStillSign(tx);

      // Read again under the lock, so a method change that committed after the check above still applies (C42).
      if (field.type === FieldType.SIGNATURE) {
        assertSignatureMethodAllowed(
          { signatureImageAsBase64, typedSignature },
          await tx.documentMeta.findUnique({
            where: { id: envelope.documentMetaId },
            select: { typedSignatureEnabled: true, drawSignatureEnabled: true, uploadSignatureEnabled: true },
          }),
        );
      }

      // Read under the lock, as V1 does, so a second insert of the same field sees the first (#131). Checkbox and
      // radio fields are edited in place by the signing page, which sends a new value for an inserted field, so
      // for them the later write wins.
      if (field.type !== FieldType.CHECKBOX && field.type !== FieldType.RADIO) {
        const lockedField = await tx.field.findUniqueOrThrow({ where: { id: field.id }, select: { inserted: true } });

        if (lockedField.inserted) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: `Field ${fieldId} has already been inserted`,
          });
        }
      }

      const updatedField = await tx.field.update({
        where: {
          id: field.id,
        },
        data: {
          customText: companySeal ? companySeal.legalEntityName : insertionValues.customText,
          inserted: insertionValues.inserted,
        },
        include: {
          signature: true,
        },
      });

      if (field.type === FieldType.SIGNATURE || field.type === FieldType.COMPANY_SEAL) {
        const signature = await tx.signature.upsert({
          where: {
            fieldId: field.id,
          },
          create: {
            fieldId: field.id,
            recipientId: field.recipientId,
            signatureImageAsBase64: signatureImageAsBase64,
            typedSignature: typedSignature,
          },
          update: {
            signatureImageAsBase64: signatureImageAsBase64,
            typedSignature: typedSignature,
          },
        });

        // Dirty but I don't want to deal with type information
        Object.assign(updatedField, {
          signature,
        });
      }

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type:
            assistant && field.recipientId !== assistant.id
              ? DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_PREFILLED
              : DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
          envelopeId: envelope.id,
          user: {
            email: assistant?.email ?? recipient.email,
            name: assistant?.name ?? recipient.name,
          },
          requestMetadata: metadata.requestMetadata,
          data: {
            recipientEmail: recipient.email,
            recipientId: recipient.id,
            recipientName: recipient.name,
            recipientRole: recipient.role,
            fieldId: updatedField.secondaryId,
            field: match(updatedField.type)
              .with(FieldType.SIGNATURE, FieldType.FREE_SIGNATURE, (type) => ({
                type,
                data: signatureImageAsBase64 || typedSignature || '',
              }))
              .with(FieldType.DATE, FieldType.EMAIL, FieldType.NAME, FieldType.TEXT, FieldType.INITIALS, (type) => ({
                type,
                data: updatedField.customText,
              }))
              .with(FieldType.NUMBER, FieldType.RADIO, FieldType.CHECKBOX, FieldType.DROPDOWN, (type) => ({
                type,
                data: updatedField.customText,
              }))
              .with(FieldType.COMPANY_SEAL, (type) => {
                if (!companySealAuditData) {
                  throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'The company seal was not loaded' });
                }

                return { type, data: companySealAuditData };
              })
              .exhaustive(),
            fieldSecurity: companySeal
              ? { type: DocumentAuth.ACCOUNT }
              : derivedRecipientActionAuth
                ? {
                    type: derivedRecipientActionAuth,
                  }
                : undefined,
          },
        }),
      });

      return {
        signedField: updatedField,
      };
    });
  });
