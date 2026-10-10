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
import type { DocumentData, Envelope, EnvelopeItem, Field } from '@prisma/client';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus, WebhookTriggerEvents } from '@prisma/client';
import { nanoid } from 'nanoid';
import { groupBy } from 'remeda';

import { NEXT_PRIVATE_USE_PLAYWRIGHT_PDF } from '../../../constants/app';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import { getAuditLogsPdf } from '../../../server-only/htmltopdf/get-audit-logs-pdf';
import { getCertificatePdf } from '../../../server-only/htmltopdf/get-certificate-pdf';
import { insertFieldInPDFV1 } from '../../../server-only/pdf/insert-field-in-pdf-v1';
import { insertFieldInPDFV2 } from '../../../server-only/pdf/insert-field-in-pdf-v2';
import { legacy_insertFieldInPDF } from '../../../server-only/pdf/legacy-insert-field-in-pdf';
import { getTeamSettings } from '../../../server-only/team/get-team-settings';
import { triggerTeamWebhook } from '../../../server-only/webhooks/trigger/trigger-webhook';
import { DOCUMENT_AUDIT_LOG_TYPE, type TDocumentAuditLog } from '../../../types/document-audit-logs';
import { SignatureLevel } from '../../../types/signature-level';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../../types/webhook-payload';
import { prefixedId } from '../../../universal/id';
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

  const { envelopeId, envelopeStatus, isRejected } = await io.runTask('seal-document', async () => {
    const envelope = await prisma.envelope.findFirstOrThrow({
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

    if (envelope.envelopeItems.length === 0) {
      throw new Error('At least one envelope item required');
    }

    // A worker killed after the commit below but before this task is recorded
    // runs the seal again on retry. The envelope's document data then already
    // points at the sealed PDF, so a second pass would stamp the fields over
    // themselves, sign again and write a second completion audit row. Only a
    // reseal is meant to run on a finished envelope, and it starts from the
    // initial data. Anything else returns here and lets the steps below, which
    // keep their own completion records, carry on.
    if (!isResealing && isDocumentCompleted(envelope.status)) {
      return {
        envelopeId: envelope.id,
        envelopeStatus: envelope.status,
        isRejected: envelope.status === DocumentStatus.REJECTED,
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

    // Ensure all CC recipients are marked as signed
    await prisma.recipient.updateMany({
      where: {
        envelopeId: envelope.id,
        role: RecipientRole.CC,
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

    const recipientsWithoutCCers = envelope.recipients.filter((recipient) => recipient.role !== RecipientRole.CC);

    // Determine if the document has been rejected by checking if any recipient has rejected it
    const rejectedRecipient = recipientsWithoutCCers.find(
      (recipient) => recipient.signingStatus === SigningStatus.REJECTED,
    );

    const isRejected = Boolean(rejectedRecipient);

    // Get the rejection reason from the rejected recipient
    const rejectionReason = rejectedRecipient?.rejectionReason ?? '';

    // Skip the field check if the document is rejected
    if (!isRejected && fieldsContainUnsignedRequiredField(fields)) {
      throw new Error(`Document ${envelope.id} has unsigned required fields`);
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

    const newDocumentData: Array<{ oldDocumentDataId: string; newDocumentDataId: string }> = [];

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

        const makeAuditLogPdf = async () =>
          usePlaywrightPdf
            ? getAuditLogsPdf({
                documentId,
                language: envelope.documentMeta.language,
              }).then(async (buffer) => PDF.load(buffer))
            : generateAuditLogPdf(certificatePayload);

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

    await prisma.$transaction(async (tx) => {
      for (const { oldDocumentDataId, newDocumentDataId } of newDocumentData) {
        await tx.envelopeItem.update({
          where: {
            envelopeId: envelope.id,
            documentDataId: oldDocumentDataId,
          },
          data: {
            documentDataId: newDocumentDataId,
          },
        });
      }

      await tx.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          status: finalEnvelopeStatus,
          completedAt: new Date(),
        },
      });

      await tx.documentAuditLog.create({
        data: envelopeCompletedAuditLog,
      });
    });

    return {
      envelopeId: envelope.id,
      envelopeStatus: envelope.status,
      isRejected,
    };
  });

  const updatedEnvelope = await prisma.envelope.findFirstOrThrow({
    where: {
      id: envelopeId,
    },
    include: {
      documentMeta: true,
      recipients: true,
    },
  });

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

  let shouldSendCompletedEmail = sendEmail && !isResealing && !isRejected;

  if (isResealing && !isDocumentCompleted(envelopeStatus)) {
    shouldSendCompletedEmail = sendEmail;
  }

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
  };
};
