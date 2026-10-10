import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TFieldAndMeta } from '@documenso/lib/types/field-meta';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { deleteFile } from '@documenso/lib/universal/upload/delete-file';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { putFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import { DocumentDataType, EnvelopeType, Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapFieldToLegacyField } from '../../utils/fields';
import { canRecipientFieldsBeModified } from '../../utils/recipients';
import { createDocumentData } from '../document-data/create-document-data';
import { assertEnvelopeMutable } from '../envelope/assert-envelope-mutable';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { type BoundingBox, savePdfWithWhiteouts, whiteoutRegions } from '../pdf/auto-place-fields';
import { assertSignaturesValidOnArrival } from '../pdf/normalize-pdf';

type CoordinatePosition = {
  page: number;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
};

type PlaceholderPosition = {
  placeholder: string;
  width?: number;
  height?: number;
  /**
   * When true, creates a field at every occurrence of the placeholder in the PDF.
   * When false or omitted, only the first occurrence is used.
   */
  matchAll?: boolean;
};

type FieldPosition = CoordinatePosition | PlaceholderPosition;

export type CreateEnvelopeFieldInput = TFieldAndMeta & {
  /**
   * The ID of the item to insert the fields into.
   *
   * If blank, the first item will be used.
   */
  envelopeItemId?: string;

  recipientId: number;
} & FieldPosition;

export interface CreateEnvelopeFieldsOptions {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;

  fields: CreateEnvelopeFieldInput[];
  requestMetadata: ApiRequestMetadata;
}

const isPlaceholderPosition = (position: FieldPosition): position is PlaceholderPosition => {
  return 'placeholder' in position;
};

/** Attempts a placeholder request makes before it is refused with ENVELOPE_ITEM_REVISION_CONFLICT. */
const MAX_REVISION_ATTEMPTS = 5;

/** A whited-out PDF already in storage, waiting to become the item's revision. */
type StagedRevision = {
  envelopeItemId: string;
  /** The revision the whiteout was drawn on. The item moves only if it still points here. */
  previousDocumentDataId: string;
  type: DocumentDataType;
  data: string;
};

/**
 * Whether a failed attempt lost a race with another request on the same item,
 * and should be tried again on the revision that request left.
 *
 * Covers the compare-and-set finding the item moved, and a Postgres deadlock,
 * which Prisma reports as an unknown request error carrying code 40P01.
 */
const isRevisionConflict = (error: unknown) => {
  if (error instanceof AppError) {
    return error.code === AppErrorCode.ENVELOPE_ITEM_REVISION_CONFLICT;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2034';
  }

  return error instanceof Prisma.PrismaClientUnknownRequestError && error.message.includes('code: "40P01"');
};

/**
 * Delete stored objects that no DocumentData row will reference.
 *
 * Best effort: a failed delete is logged and never replaces the error that
 * caused the cleanup. A process that dies between storing and this cleanup
 * leaves an unreferenced object, as every upload path that stores before it
 * inserts its row already can; only a sweep comparing bucket keys with
 * DocumentData.data would find it, and none exists yet.
 */
const deleteStagedRevisions = async (staged: StagedRevision[]) => {
  for (const revision of staged) {
    try {
      // A commit whose acknowledgement was lost would leave a row pointing here.
      // Such an object is live, so it stays.
      if (
        revision.type === DocumentDataType.S3_PATH &&
        (await prisma.documentData.count({ where: { data: revision.data } })) > 0
      ) {
        continue;
      }

      await deleteFile({ type: revision.type, data: revision.data });
    } catch (error) {
      console.error(`Could not delete a staged placeholder revision for item ${revision.envelopeItemId}`, error);
    }
  }
};

/**
 * Creates fields on an envelope, positioned by coordinates or by text
 * placeholders in its PDFs.
 *
 * A placeholder field whites out its placeholder and stores the result as a new
 * revision of the item's PDF. Concurrent requests on one item apply their
 * whiteouts in turn: one that loses the race starts again on the winner's
 * revision, and is refused with ENVELOPE_ITEM_REVISION_CONFLICT (409) after
 * MAX_REVISION_ATTEMPTS. A request that fails stores nothing and leaves every
 * item on its previous revision. A PDF whose existing signature is already
 * broken is refused with SIGNATURE_ALREADY_INVALID before anything is changed.
 */
export const createEnvelopeFields = async ({
  userId,
  teamId,
  id,
  fields,
  requestMetadata,
}: CreateEnvelopeFieldsOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: null, // Null to allow any type of envelope.
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      fields: true,
      envelopeItems: {
        // Ordered so that "the first item", the default for a field naming none, is the lowest `order`.
        orderBy: {
          order: 'asc',
        },
        include: {
          documentData: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope not found',
    });
  }

  await assertEnvelopeMutable(envelope);

  if (envelope.type === EnvelopeType.DOCUMENT && envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Envelope already complete',
    });
  }

  const firstEnvelopeItem = envelope.envelopeItems[0];

  if (!firstEnvelopeItem) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope item not found',
    });
  }

  /*
    Items a placeholder field may white out, in id order. Only items of this
    envelope are taken, so a foreign id in the request reads nothing; it is
    refused by the validation below.
  */
  const placeholderItemIds = [
    ...new Set(
      fields
        .filter((field) => isPlaceholderPosition(field))
        .map((field) => field.envelopeItemId || firstEnvelopeItem.id)
        .filter((envelopeItemId) => envelope.envelopeItems.some((item) => item.id === envelopeItemId)),
    ),
  ].sort();

  /*
    One attempt: read each item's current revision, white it out and store the
    result with no transaction open, then commit in one short transaction that
    moves each item only if it still points at the revision that was read
   . The DocumentData rows are created in that transaction, so a failed
    attempt leaves none behind. Objects already stored are recorded in
    `staged` for the caller to delete.
  */
  const attempt = async (staged: StagedRevision[]) => {
    /*
      Cache of loaded PDF documents keyed by envelope item ID. Only loaded for
      items a placeholder field targets.
      We keep the full PDF objects so we can both read text and draw white boxes
      over resolved placeholders before saving back.
    */
    const pdfCache = new Map<string, PDF>();
    const originalBytes = new Map<string, Uint8Array>();
    const readDocumentDataIds = new Map<string, string>();

    const currentItems = await prisma.envelopeItem.findMany({
      where: { id: { in: placeholderItemIds } },
      include: { documentData: true },
    });

    for (const item of currentItems) {
      const bytes = new Uint8Array(await getFileServerSide(item.documentData));
      const pdfDoc = await PDF.load(bytes);

      pdfCache.set(item.id, pdfDoc);
      originalBytes.set(item.id, bytes);
      readDocumentDataIds.set(item.id, item.documentDataId);
    }

    /*
      Collect placeholder bounding boxes that need to be whited out, grouped by
      envelope item ID. Populated during field resolution below.
    */
    const placeholderWhiteouts = new Map<string, Array<{ pageIndex: number; bbox: BoundingBox }>>();

    // Field validation and placeholder resolution.
    const validatedFields = fields.flatMap((field) => {
      const recipient = envelope.recipients.find((recipient) => recipient.id === field.recipientId);

      // The item to attach the fields to MUST belong to the document.
      if (
        field.envelopeItemId &&
        !envelope.envelopeItems.find((envelopeItem) => envelopeItem.id === field.envelopeItemId)
      ) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Item to attach fields to must belong to the document',
        });
      }

      // Each field MUST have a recipient associated with it.
      if (!recipient) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: `Recipient ${field.recipientId} not found`,
        });
      }

      // Check whether the recipient associated with the field can have new fields created.
      if (!canRecipientFieldsBeModified(recipient, envelope.fields)) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Recipient type cannot have fields, or they have already interacted with the document.',
        });
      }

      const envelopeItemId = field.envelopeItemId || firstEnvelopeItem.id;

      /*
        Resolve field position(s). Placeholder fields are resolved by searching the
        PDF text for the placeholder string and using its bounding box.
        When matchAll is true, all occurrences produce fields.
      */
      if (isPlaceholderPosition(field)) {
        const pdfDoc = pdfCache.get(envelopeItemId);

        if (!pdfDoc) {
          throw new AppError(AppErrorCode.NOT_FOUND, {
            message: `Could not load PDF for envelope item ${envelopeItemId}`,
          });
        }

        const matches = pdfDoc.findText(field.placeholder);

        if (matches.length === 0) {
          throw new AppError(AppErrorCode.INVALID_BODY, {
            message: `Placeholder "${field.placeholder}" not found in PDF`,
          });
        }

        const matchesToProcess = field.matchAll ? matches : [matches[0]];
        const pages = pdfDoc.getPages();

        return matchesToProcess.map((match) => {
          const page = pages[match.pageIndex];

          /*
            Record this placeholder's bounding box for whiteout. The bbox is in
            the original PDF coordinate system (points, bottom-left origin).
          */
          if (!placeholderWhiteouts.has(envelopeItemId)) {
            placeholderWhiteouts.set(envelopeItemId, []);
          }

          placeholderWhiteouts.get(envelopeItemId)!.push({
            pageIndex: match.pageIndex,
            bbox: match.bbox,
          });

          /*
            Convert point-based coordinates (bottom-left origin) to percentage-based
            coordinates (top-left origin) matching the system's field coordinate format.
          */
          const topLeftY = page.height - match.bbox.y - match.bbox.height;

          const widthPercent = field.width ?? (match.bbox.width / page.width) * 100;
          const heightPercent = field.height ?? (match.bbox.height / page.height) * 100;

          return {
            type: field.type,
            fieldMeta: field.fieldMeta,
            recipientId: field.recipientId,
            envelopeItemId,
            recipientEmail: recipient.email,
            page: match.pageIndex + 1,
            positionX: (match.bbox.x / page.width) * 100,
            positionY: (topLeftY / page.height) * 100,
            width: widthPercent,
            height: heightPercent,
          };
        });
      }

      return {
        type: field.type,
        fieldMeta: field.fieldMeta,
        recipientId: field.recipientId,
        envelopeItemId,
        recipientEmail: recipient.email,
        page: field.page,
        positionX: field.positionX,
        positionY: field.positionY,
        width: field.width,
        height: field.height,
      };
    });

    /*
      Draw white rectangles over each resolved placeholder in the PDF to hide the
      placeholder text, and store the modified PDFs. This happens before any field
      is saved, so a request whose PDF cannot be stored saves no field.
    */
    for (const [envelopeItemId, whiteouts] of placeholderWhiteouts) {
      const pdfDoc = pdfCache.get(envelopeItemId);
      const original = originalBytes.get(envelopeItemId);
      const previousDocumentDataId = readDocumentDataIds.get(envelopeItemId);

      if (!pdfDoc || !original || !previousDocumentDataId) {
        continue;
      }

      // A signature broken before the file reached us is refused as such, as
      // the upload path does, rather than reported by the storage check as
      // damage done here.
      await assertSignaturesValidOnArrival(original);

      whiteoutRegions(pdfDoc, whiteouts);

      const modifiedPdfBytes = await savePdfWithWhiteouts(pdfDoc, original);

      const { type, data } = await putFileServerSide({
        name: 'document.pdf',
        type: 'application/pdf',
        arrayBuffer: async () => Promise.resolve(Buffer.from(modifiedPdfBytes)),
      });

      staged.push({ envelopeItemId, previousDocumentDataId, type, data });
    }

    return await prisma.$transaction(async (tx) => {
      await assertEnvelopeMutable(envelope, tx);

      /*
        Move each item first, in id order, before any field insert. The update
        takes the item row FOR UPDATE (documentDataId is unique), so a second
        request on the item waits here until the first commits, then finds the
        item on another revision, matches nothing and rolls back to retry.
        Inserting fields first would have each request hold the KEY SHARE lock
        a field's foreign key takes and then deadlock on the update.
      */
      for (const revision of [...staged].sort((a, b) => (a.envelopeItemId < b.envelopeItemId ? -1 : 1))) {
        const documentData = await createDocumentData({
          type: revision.type,
          data: revision.data,
          owner: { userId, teamId },
          tx,
        });

        const { count } = await tx.envelopeItem.updateMany({
          where: { id: revision.envelopeItemId, documentDataId: revision.previousDocumentDataId },
          data: { documentDataId: documentData.id },
        });

        if (count === 0) {
          throw new AppError(AppErrorCode.ENVELOPE_ITEM_REVISION_CONFLICT, {
            message: 'The document changed while the fields were being placed. Send the request again.',
          });
        }
      }

      const newlyCreatedFields = await tx.field.createManyAndReturn({
        data: validatedFields.map((field) => ({
          type: field.type,
          page: field.page,
          positionX: field.positionX,
          positionY: field.positionY,
          width: field.width,
          height: field.height,
          customText: '',
          inserted: false,
          fieldMeta: field.fieldMeta,
          envelopeId: envelope.id,
          envelopeItemId: field.envelopeItemId,
          recipientId: field.recipientId,
        })),
      });

      // Handle field created audit log.
      if (envelope.type === EnvelopeType.DOCUMENT) {
        await tx.documentAuditLog.createMany({
          data: newlyCreatedFields.map((createdField) => {
            const recipient = validatedFields.find((field) => field.recipientId === createdField.recipientId);

            return createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_CREATED,
              envelopeId: envelope.id,
              metadata: requestMetadata,
              data: {
                fieldId: createdField.secondaryId,
                fieldRecipientEmail: recipient?.recipientEmail || '',
                fieldRecipientId: createdField.recipientId,
                fieldType: createdField.type,
              },
            });
          }),
        });
      }

      return newlyCreatedFields;
    });
  };

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    const staged: StagedRevision[] = [];
    let createdFields: Awaited<ReturnType<typeof attempt>>;

    try {
      createdFields = await attempt(staged);
    } catch (error) {
      await deleteStagedRevisions(staged);

      if (!isRevisionConflict(error)) {
        throw error;
      }

      if (attemptNumber >= MAX_REVISION_ATTEMPTS) {
        throw new AppError(AppErrorCode.ENVELOPE_ITEM_REVISION_CONFLICT, {
          message: 'The document is being changed by other requests. Send the request again.',
        });
      }

      continue;
    }

    return {
      fields: createdFields.map((field) => mapFieldToLegacyField(field, envelope)),
    };
  }
};
