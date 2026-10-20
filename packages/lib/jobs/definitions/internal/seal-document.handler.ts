import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { addRejectionStampToPdf } from '@documenso/lib/server-only/pdf/add-rejection-stamp-to-pdf';
import { inspectExistingSignatures } from '@documenso/lib/server-only/pdf/existing-signatures';
import { generateAuditLogPdf } from '@documenso/lib/server-only/pdf/generate-audit-log-pdf';
import { generateCertificatePdf } from '@documenso/lib/server-only/pdf/generate-certificate-pdf';
import { getLastPageDimensions } from '@documenso/lib/server-only/pdf/get-page-size';
import { prisma } from '@documenso/prisma';
import { signPdf } from '@documenso/signing';
import { PDF } from '@libpdf/core';
import type { DocumentData, Envelope, EnvelopeItem, Field, Recipient, Signature } from '@prisma/client';
import {
  DocumentDataType,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import { groupBy } from 'remeda';

import { NEXT_PRIVATE_USE_PLAYWRIGHT_PDF } from '../../../constants/app';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import { primaryClient } from '../../../server-only/database/primary-client';
import { getAuditLogsPdf } from '../../../server-only/htmltopdf/get-audit-logs-pdf';
import { getCertificatePdf } from '../../../server-only/htmltopdf/get-certificate-pdf';
import { insertFieldInPDFV1 } from '../../../server-only/pdf/insert-field-in-pdf-v1';
import { insertFieldInPDFV2 } from '../../../server-only/pdf/insert-field-in-pdf-v2';
import { legacy_insertFieldInPDF } from '../../../server-only/pdf/legacy-insert-field-in-pdf';
import { prepareStoredSignatureImage } from '../../../server-only/signature/prepare-stored-signature-image';
import { getTeamSettings } from '../../../server-only/team/get-team-settings';
import { triggerTeamWebhook } from '../../../server-only/webhooks/trigger/trigger-webhook';
import { DOCUMENT_AUDIT_LOG_TYPE, type TDocumentAuditLog } from '../../../types/document-audit-logs';
import { SignatureLevel } from '../../../types/signature-level';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../../types/webhook-payload';
import { prefixedId } from '../../../universal/id';
import { deleteFile } from '../../../universal/upload/delete-file';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { putPdfFileServerSide } from '../../../universal/upload/put-file.server';
import { fieldsContainUnsignedRequiredField } from '../../../utils/advanced-fields-helpers';
import { isDocumentCompleted } from '../../../utils/document';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { mapDocumentIdToSecondaryId } from '../../../utils/envelope';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSealDocumentJobDefinition } from './seal-document';

export const run = async ({ payload, io }: { payload: TSealDocumentJobDefinition; io: JobRunIO }) => {
  const { documentId, sendEmail = true, isResealing = false, requestMetadata } = payload;

  const { envelopeId, envelopeStatus, isRejected, isAborted } = await io.runTask('seal-document', async () => {
    const findEnvelope = async (client: typeof prisma) =>
      await client.envelope.findFirst({
        where: {
          type: EnvelopeType.DOCUMENT,
          secondaryId: mapDocumentIdToSecondaryId(documentId),
        },
        include: {
          user: {
            select: {
              name: true,
              email: true,
            },
          },
          documentMeta: true,
          recipients: true,
          fields: {
            include: {
              signature: true,
            },
          },
          envelopeItems: {
            include: {
              documentData: true,
              field: {
                include: {
                  signature: true,
                },
              },
            },
          },
        },
      });

    // A miss on a lagging read replica is not proof the envelope is gone; only the primary can say so.
    const envelope = (await findEnvelope(prisma)) ?? (await findEnvelope(primaryClient()));

    // Absent on the primary too: a purged envelope has nothing left to seal or announce, so the job ends quietly
    // rather than failing and retrying.
    if (!envelope) {
      return {
        envelopeId: '',
        envelopeStatus: DocumentStatus.DRAFT,
        isRejected: false,
        isAborted: true,
      };
    }

    if (envelope.envelopeItems.length === 0) {
      throw new Error('At least one envelope item required');
    }

    // A cancelled envelope is never sealed, resealed or announced as finished,
    // whoever queued the job (#122).
    if (envelope.status === DocumentStatus.CANCELLED) {
      return {
        envelopeId: envelope.id,
        envelopeStatus: envelope.status,
        isRejected: false,
        isAborted: true,
      };
    }

    // A worker killed after the commit below but before this task is recorded
    // runs the seal again on retry. The envelope's document data then already
    // points at the sealed PDF, so a second pass would stamp the fields over
    // themselves, sign again and write a second completion audit row. Only a
    // reseal is meant to run on a finished envelope, and it starts from the
    // initial data. A COMPLETED or REJECTED envelope returns here and lets the
    // steps below, which keep their own completion records, carry on.
    if (!isResealing && isDocumentCompleted(envelope.status)) {
      return {
        envelopeId: envelope.id,
        envelopeStatus: envelope.status,
        isRejected: envelope.status === DocumentStatus.REJECTED,
        isAborted: false,
      };
    }

    // Only the simple level is sealed here. Remote signing through a trust
    // service provider has been removed, and sealing an AES or QES envelope
    // with the instance certificate would quietly downgrade it.
    if (envelope.signatureLevel !== SignatureLevel.SES) {
      io.logger.error(
        `Refusing to seal envelope ${envelope.id} at signature level ${envelope.signatureLevel}: only SES is supported`,
      );

      throw new AppError(AppErrorCode.CSC_INSTANCE_MODE_MISMATCH, {
        message: `Envelope ${envelope.id} has signature level ${envelope.signatureLevel}, which this instance cannot seal.`,
      });
    }

    // Resolve the settings by team alone. Passing `userId` turns this into an
    // access check against whatever membership the author holds at the moment
    // the job fires, and the recipients decide when that is, possibly months
    // after the author last touched anything. Once the author loses team
    // access, `getTeamSettings` throws Team not found, the retries run out, and
    // a document every recipient has signed sits at PENDING for good. Upstream
    // re-parents envelopes when a member is removed from a team, which covers
    // nothing when the access came through a group, and we drive membership
    // from Entra groups and reconcile it on a schedule. Authorisation for this
    // envelope was settled when it was sent. What the job needs now is the
    // envelope's own teamId, which no caller can steer.
    const settings = await getTeamSettings({
      teamId: envelope.teamId,
    });

    // Ensure all CC recipients are marked as signed. A rejection is kept, whatever the role (#121).
    await prisma.recipient.updateMany({
      where: {
        envelopeId: envelope.id,
        role: RecipientRole.CC,
        signingStatus: { not: SigningStatus.REJECTED },
      },
      data: {
        signingStatus: SigningStatus.SIGNED,
      },
    });

    const isComplete =
      envelope.recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED) ||
      envelope.recipients.every(
        (recipient) => recipient.signingStatus === SigningStatus.SIGNED || recipient.role === RecipientRole.CC,
      );

    if (!isComplete) {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'Document is not complete',
      });
    }

    let { envelopeItems } = envelope;

    const fields = envelope.fields;

    if (envelopeItems.length < 1) {
      throw new Error(`Document ${envelope.id} has no envelope items`);
    }

    // Determine if the document has been rejected by checking if any recipient has rejected it, a CC included
    // (one whose role was changed after rejecting) (#121).
    const rejectedRecipient = envelope.recipients.find(
      (recipient) => recipient.signingStatus === SigningStatus.REJECTED,
    );

    const isRejected = Boolean(rejectedRecipient);

    // Get the rejection reason from the rejected recipient
    const rejectionReason = rejectedRecipient?.rejectionReason ?? '';

    // Skip the field check if the document is rejected
    if (!isRejected && fieldsContainUnsignedRequiredField(fields)) {
      throw new Error(`Document ${envelope.id} has unsigned required fields`);
    }

    // Every stored signature image is read before anything of the seal is written. One no decoder can read
    // stops the seal here: the envelope stays as it is, the owner gets one audit entry per such field, and the
    // job ends without a retry, since retrying cannot make the image readable (G4 decision D2).
    const unrenderableFields = await prepareSignatureImagesForSeal(envelope);

    if (unrenderableFields.length > 0) {
      await recordUnrenderableSignatures(envelope, unrenderableFields, requestMetadata);

      io.logger.warn(
        `Not sealing envelope ${envelope.id}: the stored signature image of field(s) ` +
          `${unrenderableFields.map((field) => field.id).join(', ')} could not be rendered`,
      );

      return {
        envelopeId: envelope.id,
        envelopeStatus: envelope.status,
        isRejected: false,
        isAborted: true,
      };
    }

    if (isResealing) {
      // If we're resealing we want to use the initial data for the document
      // so we aren't placing fields on top of eachother.
      envelopeItems = envelopeItems.map((envelopeItem) => ({
        ...envelopeItem,
        documentData: {
          ...envelopeItem.documentData,
          data: envelopeItem.documentData.initialData,
        },
      }));
    }

    if (!envelope.qrToken) {
      await prisma.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          qrToken: prefixedId('qr'),
        },
      });
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const envelopeCompletedAuditLog = createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_COMPLETED,
      envelopeId: envelope.id,
      requestMetadata,
      user: null,
      data: {
        transactionId: nanoid(),
        ...(isRejected ? { isRejected: true, rejectionReason: rejectionReason } : {}),
      },
    });

    const finalEnvelopeStatus = isRejected ? DocumentStatus.REJECTED : DocumentStatus.COMPLETED;

    // Pre-fetch all PDF data so we can read dimensions and pass it
    // to decorateAndSignPdf without fetching again.
    const prefetchedItems = await Promise.all(
      envelopeItems.map(async (envelopeItem) => {
        const pdfData = await getFileServerSide(envelopeItem.documentData);

        return { envelopeItem, pdfData };
      }),
    );

    const usePlaywrightPdf = NEXT_PRIVATE_USE_PLAYWRIGHT_PDF();

    const needsCertificate = settings.includeSigningCertificate;
    const needsAuditLog = settings.includeAuditLog;

    const newDocumentData: SealedCopy[] = [];

    // Every sealed copy made here is discarded if the seal does not commit, whichever step fails (#122).
    try {
      for (const { envelopeItem, pdfData } of prefetchedItems) {
        const envelopeItemFields = envelope.envelopeItems.find((item) => item.id === envelopeItem.id)?.field;

        if (!envelopeItemFields) {
          throw new Error(`Envelope item fields not found for envelope item ${envelopeItem.id}`);
        }

        let certificateDoc: PDF | null = null;
        let auditLogDoc: PDF | null = null;

        if (needsCertificate || needsAuditLog) {
          const pdfDoc = await PDF.load(pdfData);

          const { width: pageWidth, height: pageHeight } = getLastPageDimensions(pdfDoc);

          const additionalAuditLogs = [
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            {
              ...envelopeCompletedAuditLog,
              id: '',
              createdAt: new Date(),
            } as TDocumentAuditLog,
          ];

          const certificatePayload = {
            envelope: {
              ...envelope,
              status: finalEnvelopeStatus,
            },
            recipients: envelope.recipients,
            fields,
            language: envelope.documentMeta.language,
            envelopeOwner: {
              email: envelope.user.email,
              name: envelope.user.name || '',
            },
            envelopeItems: envelopeItems.map((item) => item.title),
            pageWidth,
            pageHeight,
            additionalAuditLogs,
          };

          const makeCertificatePdf = async () =>
            usePlaywrightPdf
              ? getCertificatePdf({
                  documentId,
                  language: envelope.documentMeta.language,
                }).then(async (buffer) => PDF.load(buffer))
              : generateCertificatePdf(certificatePayload);

          // The audit pages go to every recipient: with "Send on Behalf of Team" off they show the team in
          // place of its members.
          const getSenderStandIn = async () => {
            if (settings.includeSenderDetails) {
              return undefined;
            }

            const team = await prisma.team.findUniqueOrThrow({
              where: { id: envelope.teamId },
              select: { name: true, teamEmail: { select: { email: true } } },
            });

            return { name: team.name, email: team.teamEmail?.email ?? '' };
          };

          const makeAuditLogPdf = async () =>
            usePlaywrightPdf
              ? getAuditLogsPdf({
                  documentId,
                  language: envelope.documentMeta.language,
                }).then(async (buffer) => PDF.load(buffer))
              : generateAuditLogPdf({ ...certificatePayload, senderStandIn: await getSenderStandIn() });

          [certificateDoc, auditLogDoc] = await Promise.all([
            needsCertificate ? makeCertificatePdf() : null,
            needsAuditLog ? makeAuditLogPdf() : null,
          ]);
        }

        const result = await decorateAndSignPdf({
          envelope,
          envelopeItem,
          envelopeItemFields,
          isRejected,
          rejectionReason,
          pdfData,
          certificateDoc,
          auditLogDoc,
        });

        newDocumentData.push(result);
      }
    } catch (error) {
      await discardSealedCopies(newDocumentData);

      throw error;
    }

    // The status write is conditional on the status read at the start, and comes
    // first so its row lock orders this commit against a cancel. If the status
    // moved while the PDFs were built (a cancel, or another seal), the swap and
    // the audit row roll back and the sealed copies are discarded (#122).
    const sealCommitted = await prisma
      .$transaction(async (tx) => {
        const { count } = await tx.envelope.updateMany({
          where: {
            id: envelope.id,
            status: envelope.status,
          },
          data: {
            status: finalEnvelopeStatus,
            completedAt: new Date(),
          },
        });

        if (count === 0) {
          throw new SealSupersededError();
        }

        for (const { oldDocumentDataId, newDocumentDataId } of newDocumentData) {
          // Conditional too: a concurrent reseal that matched the same status and committed first has already
          // moved the item, and this one must lose cleanly rather than fail with its copies left behind.
          const { count: movedItems } = await tx.envelopeItem.updateMany({
            where: {
              envelopeId: envelope.id,
              documentDataId: oldDocumentDataId,
            },
            data: {
              documentDataId: newDocumentDataId,
            },
          });

          if (movedItems === 0) {
            throw new SealSupersededError();
          }

          // The unsealed version. Its initialData lives on in the sealed row.
          await tx.documentData.deleteMany({
            where: {
              id: oldDocumentDataId,
              envelopeItem: null,
            },
          });
        }

        await tx.documentAuditLog.create({
          data: envelopeCompletedAuditLog,
        });

        return true;
      })
      .catch(async (error) => {
        await discardSealedCopies(newDocumentData);

        if (!(error instanceof SealSupersededError)) {
          throw error;
        }

        return false;
      });

    if (!sealCommitted) {
      io.logger.info(`Envelope ${envelope.id} changed status while sealing, discarding the sealed copies`);
    }

    return {
      envelopeId: envelope.id,
      envelopeStatus: envelope.status,
      isRejected,
      isAborted: !sealCommitted,
    };
  });

  if (isAborted) {
    return;
  }

  const findUpdatedEnvelope = async (client: typeof prisma) =>
    await client.envelope.findFirst({
      where: {
        id: envelopeId,
      },
      include: {
        documentMeta: true,
        recipients: true,
      },
    });

  const updatedEnvelope = (await findUpdatedEnvelope(prisma)) ?? (await findUpdatedEnvelope(primaryClient()));

  // Absent on the primary too: purged after the seal committed, so nobody is left to tell.
  if (!updatedEnvelope) {
    return;
  }

  // A cancel cannot commit after the seal's conditional write, so this only
  // catches a cancelled envelope the task saw before the guard above existed,
  // on a retry of an older run.
  if (updatedEnvelope.status === DocumentStatus.CANCELLED) {
    return;
  }

  // Everything below fans one completion out to the world, and the job system
  // retries this handler from the top after any failure in it. The seal itself
  // is protected by its own task above; without a task of their own, a webhook
  // that was delivered and emails that were sent go out a second time because
  // the step after them threw, or because the worker died between the two.
  // Each step therefore records its own completion, keyed on the job run, so a
  // retry resumes at the step that failed.
  await io.runTask('seal-document:trigger-webhook', async () => {
    // Scope by the envelope's team, for the same reason the settings lookup
    // above does. The author's membership decides nothing here: the team owns
    // the envelope and is owed the completion, and an author who has since lost
    // access used to resolve zero subscriptions and return quietly, so the team
    // sealed a contract and never heard about it.
    await triggerTeamWebhook({
      event: isRejected ? WebhookTriggerEvents.DOCUMENT_REJECTED : WebhookTriggerEvents.DOCUMENT_COMPLETED,
      data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(updatedEnvelope)),
      teamId: updatedEnvelope.teamId,
    });
  });

  // The rejection and cancellation emails wait for the rejection seal, so a seal that stops sends none (G4 D2).
  // They go out on the seal that first takes the envelope out of PENDING, which may be the sweep's recovery
  // reseal, and never on a reseal of an envelope already sealed (G4 C108).
  const isFirstSeal = !isResealing || !isDocumentCompleted(envelopeStatus);

  const rejectedRecipient = updatedEnvelope.recipients.find(
    (recipient) => recipient.signingStatus === SigningStatus.REJECTED,
  );

  if (isRejected && isFirstSeal && rejectedRecipient) {
    await io.runTask('seal-document:rejection-emails', async () => {
      await jobs.triggerJob({
        name: 'send.signing.rejected.emails',
        payload: {
          recipientId: rejectedRecipient.id,
          documentId,
        },
      });
    });

    await io.runTask('seal-document:cancelled-emails', async () => {
      await jobs.triggerJob({
        name: 'send.document.cancelled.emails',
        payload: {
          documentId,
          cancellationReason: rejectedRecipient.rejectionReason ?? undefined,
          requestMetadata,
        },
      });
    });
  }

  const shouldSendCompletedEmail = sendEmail && isFirstSeal && !isRejected;

  if (shouldSendCompletedEmail) {
    await io.runTask('seal-document:completed-emails', async () => {
      await jobs.triggerJob({
        name: 'send.document.completed.emails',
        payload: {
          envelopeId,
          requestMetadata,
        },
      });
    });
  }

  if (!isRejected) {
    // File an archival copy into the SharePoint contract library. This is a
    // copy, not a move: the sealed PDF above stays the system of record.
    //
    // Every failure here is swallowed on purpose. The envelope is already
    // sealed and committed by this point, and letting an unreachable queue turn
    // a successful seal into a failed job would retry the seal, which is a far
    // worse outcome than a late filing. `internal.archive-envelope-sweep` files
    // anything this trigger fails to enqueue, so nothing is lost by giving up
    // quietly here.
    try {
      await io.runTask('seal-document:archive-envelope', async () => {
        await jobs.triggerJob({
          name: 'internal.archive-envelope',
          payload: {
            envelopeId,
          },
        });
      });
    } catch (error) {
      io.logger.warn(
        `[sharepoint-archive] Could not queue envelope ${envelopeId} for filing, leaving it to the sweep: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

type SealEnvelopeFields = {
  fields: Array<Field & { signature: Signature | null }>;
  envelopeItems: Array<{ field: Array<Field & { signature: Signature | null }> }>;
};

/**
 * Replaces each stored signature image, in memory only, with what the seal draws for it
 * (prepareStoredSignatureImage), so every consumer in the seal reads the same image.
 *
 * @returns The fields whose image no decoder can read.
 */
const prepareSignatureImagesForSeal = async (envelope: SealEnvelopeFields) => {
  const prepared = new Map<string, Promise<string | null>>();
  const unrenderable = new Map<number, Field>();
  const fields = [...envelope.fields, ...envelope.envelopeItems.flatMap((item) => item.field)];

  for (const field of fields) {
    const stored = field.signature?.signatureImageAsBase64;

    if (!field.signature || !stored) {
      continue;
    }

    if (!prepared.has(stored)) {
      prepared.set(stored, prepareStoredSignatureImage(stored));
    }

    const image = await prepared.get(stored);

    if (image) {
      field.signature.signatureImageAsBase64 = image;
    } else {
      unrenderable.set(field.id, field);
    }
  }

  return [...unrenderable.values()];
};

/**
 * Writes one DOCUMENT_SIGNATURE_IMAGE_UNRENDERABLE entry per field, unless the field already has one. The
 * envelope row is locked first, so two seal runs at once cannot both write the entry.
 */
const recordUnrenderableSignatures = async (
  envelope: { id: string; recipients: Recipient[] },
  fields: Field[],
  requestMetadata: TSealDocumentJobDefinition['requestMetadata'],
) => {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelope.id} FOR UPDATE`;

    for (const field of fields) {
      const existing = await tx.documentAuditLog.findFirst({
        where: {
          envelopeId: envelope.id,
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SIGNATURE_IMAGE_UNRENDERABLE,
          data: { path: ['fieldId'], equals: field.secondaryId },
        },
      });

      const recipient = envelope.recipients.find((candidate) => candidate.id === field.recipientId);

      if (existing || !recipient) {
        continue;
      }

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SIGNATURE_IMAGE_UNRENDERABLE,
          envelopeId: envelope.id,
          requestMetadata,
          user: null,
          data: {
            fieldId: field.secondaryId,
            recipientId: recipient.id,
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            recipientRole: recipient.role,
          },
        }),
      });
    }
  });
};

/** Thrown inside the seal commit when the envelope's status moved, to roll the commit back. */
class SealSupersededError extends Error {}

type SealedCopy = {
  oldDocumentDataId: string;
  newDocumentDataId: string;
  newDocumentDataType: DocumentData['type'];
  newDocumentDataKey: string;
};

/**
 * Deletes sealed copies that no envelope item took, with the stored object of any held outside the database
 * that no other row names. Failures are logged, not thrown: the caller is already on a losing path (#122).
 */
const discardSealedCopies = async (copies: SealedCopy[]) => {
  for (const copy of copies) {
    try {
      const { count } = await prisma.documentData.deleteMany({
        where: { id: copy.newDocumentDataId, envelopeItem: null },
      });

      if (count === 0 || copy.newDocumentDataType !== DocumentDataType.S3_PATH) {
        continue;
      }

      const rowsNamingKey = await prisma.documentData.count({
        where: { OR: [{ data: copy.newDocumentDataKey }, { initialData: copy.newDocumentDataKey }] },
      });

      if (rowsNamingKey === 0) {
        await deleteFile({ type: copy.newDocumentDataType, data: copy.newDocumentDataKey });
      }
    } catch (error) {
      console.error(`Could not discard sealed copy ${copy.newDocumentDataId}`, error);
    }
  }
};

type DecorateAndSignPdfOptions = {
  envelope: Pick<Envelope, 'id' | 'title' | 'useLegacyFieldInsertion' | 'internalVersion' | 'teamId'>;
  envelopeItem: EnvelopeItem & { documentData: DocumentData };
  envelopeItemFields: Field[];
  isRejected: boolean;
  rejectionReason: string;
  pdfData: Uint8Array;
  certificateDoc: PDF | null;
  auditLogDoc: PDF | null;
};

/**
 * Normalize, flatten and insert fields into a PDF document.
 */
const decorateAndSignPdf = async ({
  envelope,
  envelopeItem,
  envelopeItemFields,
  isRejected,
  rejectionReason,
  pdfData,
  certificateDoc,
  auditLogDoc,
}: DecorateAndSignPdfOptions) => {
  let pdfDoc = await PDF.load(pdfData);

  // A document can reach us already signed by a counterparty in DocuSign or
  // Adobe. Those signatures survive only if everything we do from here is an
  // incremental update, so decide once, before any of it.
  const existingSignatures = inspectExistingSignatures(pdfDoc);
  const preserveSignatures = existingSignatures.signedFieldCount > 0 && existingSignatures.canPreserve;

  if (existingSignatures.signedFieldCount > 0 && !existingSignatures.canPreserve) {
    throw new Error(
      `Envelope ${envelope.id} carries ${existingSignatures.signedFieldCount} existing signature(s) ` +
        `that cannot be preserved (${existingSignatures.blocker}). Refusing to seal rather than ` +
        'silently invalidate them.',
    );
  }

  // Normalize and flatten layers that could cause issues with the signature.
  // `skipSignatures` leaves an existing signature listed in the AcroForm; without
  // it the field is removed and a reader shows the document as unsigned even
  // though the signed bytes are intact.
  pdfDoc.flattenAll({ form: { skipSignatures: preserveSignatures } });
  // Upgrade to PDF 1.7 for better compatibility with signing
  pdfDoc.upgradeVersion('1.7');

  // Add rejection stamp if the document is rejected
  if (isRejected) {
    await addRejectionStampToPdf(pdfDoc, rejectionReason);
  }

  if (certificateDoc) {
    await pdfDoc.copyPagesFrom(
      certificateDoc,
      Array.from({ length: certificateDoc.getPageCount() }, (_, index) => index),
    );
  }

  if (auditLogDoc) {
    await pdfDoc.copyPagesFrom(
      auditLogDoc,
      Array.from({ length: auditLogDoc.getPageCount() }, (_, index) => index),
    );
  }

  // Handle V1 and legacy insertions.
  if (envelope.internalVersion === 1) {
    if (preserveSignatures) {
      // The V1 path round-trips the document through pdf-lib, which has no
      // incremental save mode and re-serialises the whole file. There is no
      // way to carry an existing signature through it.
      throw new Error(
        `Envelope ${envelope.id} carries an existing signature, which the V1 field insertion ` +
          'path cannot preserve. Recreate it as a V2 envelope.',
      );
    }

    if (pdfDoc.isEncrypted) {
      // pdf-lib drops /Encrypt when it decrypts, so an owner-protected file
      // would come out of this path with its protection silently removed.
      // Creation refuses these for V1; this catches anything that predates it.
      throw new Error(
        `Envelope ${envelope.id} carries owner restrictions, which the V1 field insertion ` +
          'path cannot keep. Recreate it as a V2 envelope.',
      );
    }

    if (envelopeItemFields.some((field) => field.type === FieldType.COMPANY_SEAL)) {
      // The V1 inserter would print the seal's legal entity as text. Field
      // writers refuse seals on V1; this catches anything that slipped past.
      throw new Error(`Envelope ${envelope.id} carries a company seal field, which needs a V2 envelope.`);
    }

    const legacy_pdfLibDoc = await PDFDocument.load(await pdfDoc.save({ useXRefStream: true }));

    for (const field of envelopeItemFields) {
      if (field.inserted) {
        if (envelope.useLegacyFieldInsertion) {
          await legacy_insertFieldInPDF(legacy_pdfLibDoc, field);
        } else {
          await insertFieldInPDFV1(legacy_pdfLibDoc, field);
        }
      }
    }

    // Should never run into issues with this flatten since all
    // arcoFields are created by pdf-lib itself.
    legacy_pdfLibDoc.getForm().flatten();

    await pdfDoc.reload(await legacy_pdfLibDoc.save());
  }

  // Handle V2 envelope insertions.
  if (envelope.internalVersion === 2) {
    // Draw only what somebody put there. A field that was never filled in has
    // no content, and the export renderer falls back to the field type as its
    // label, so an untouched signature field comes out of here with the word
    // SIGNATURE printed where a signature should be. That normally cannot
    // happen, because sealing refuses to run while a required field is
    // unsigned. On rejection that check is skipped on purpose, which is how a
    // rejected contract reaches the archive stamped SIGNATURE. The V1 path
    // above has always filtered on `inserted`; this matches it.
    const insertedFields = envelopeItemFields.filter((field) => field.inserted);

    const fieldsGroupedByPage = groupBy(insertedFields, (field) => field.page);

    for (const [pageNumber, fields] of Object.entries(fieldsGroupedByPage)) {
      const page = pdfDoc.getPage(Number(pageNumber) - 1);

      if (!page) {
        throw new Error(`Page ${pageNumber} does not exist`);
      }

      const pageWidth = page.width;
      const pageHeight = page.height;

      const overlayBytes = await insertFieldInPDFV2({
        pageWidth,
        pageHeight,
        fields,
      });

      const overlayPdf = await PDF.load(overlayBytes);

      const embeddedPage = await pdfDoc.embedPage(overlayPdf, 0);

      // Rotate the page to the orientation that the react-pdf renders on the frontend.
      let translateX = 0;
      let translateY = 0;

      switch (page.rotation) {
        case 90:
          translateX = pageHeight;
          translateY = 0;
          break;
        case 180:
          translateX = pageWidth;
          translateY = pageHeight;
          break;
        case 270:
          translateX = 0;
          translateY = pageWidth;
          break;
      }

      // Draw the overlay on the page
      page.drawPage(embeddedPage, {
        x: translateX,
        y: translateY,
        rotate: {
          angle: page.rotation,
        },
      });
    }
  }

  // Re-flatten the form to handle our checkbox and radio fields that
  // create native arcoFields
  pdfDoc.flattenAll({ form: { skipSignatures: preserveSignatures } });

  if (!preserveSignatures) {
    // Round-tripping consolidates pending edits before signing. It also moves
    // every byte offset, so it is skipped when an existing signature has to
    // survive; `sign()` appends incrementally and handles pending edits itself.
    pdfDoc = await PDF.load(await pdfDoc.save({ useXRefStream: true }));
  }

  if (preserveSignatures) {
    // `sign()` has no incremental guard of its own. When an incremental save
    // turns out to be impossible it records an internal warning and performs a
    // full rewrite anyway, which would invalidate the signatures we are here to
    // protect. Re-check immediately before signing, because the operations above
    // can change the answer.
    const blocker = pdfDoc.canSaveIncrementally();

    if (blocker !== null) {
      throw new Error(
        `Envelope ${envelope.id} carries an existing signature but can no longer take an ` +
          `incremental update (${blocker}). Refusing to seal rather than invalidate it.`,
      );
    }
  }

  const pdfBytes = await signPdf({ pdf: pdfDoc });

  if (preserveSignatures) {
    // Verify the outcome rather than trusting the request: an append leaves the
    // input as a byte-for-byte prefix, and anything else means the existing
    // signatures have just been broken.
    const appended =
      pdfBytes.length >= pdfData.length && Buffer.from(pdfBytes.subarray(0, pdfData.length)).equals(pdfData);

    if (!appended) {
      throw new Error(
        `Envelope ${envelope.id} was rewritten rather than appended to while sealing, which ` +
          'invalidates the existing signature. Refusing to store the result.',
      );
    }
  }

  const { name } = path.parse(envelopeItem.title);

  // Add suffix based on document status
  const suffix = isRejected ? '_rejected.pdf' : '_signed.pdf';

  const { documentData: newDocumentData } = await putPdfFileServerSide(
    {
      name: `${name}${suffix}`,
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(pdfBytes),
    },
    {
      // Sealing runs as a job, so nobody is signed in. The team that owns the
      // envelope is the whole of the identity here.
      owner: { userId: null, teamId: envelope.teamId },
      initialData: envelopeItem.documentData.initialData,
    },
  );

  return {
    oldDocumentDataId: envelopeItem.documentData.id,
    newDocumentDataId: newDocumentData.id,
    newDocumentDataType: newDocumentData.type,
    newDocumentDataKey: newDocumentData.data,
  };
};
