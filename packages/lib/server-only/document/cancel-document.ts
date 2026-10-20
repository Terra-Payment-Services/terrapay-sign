import { jobs } from '@documenso/lib/jobs/client';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, SigningStatus, WebhookTriggerEvents } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { isMemberManagerOrAbove } from '../../utils/teams';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { getMemberRoles } from '../team/get-member-roles';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export type CancelDocumentOptions = {
  id: EnvelopeIdOptions;
  userId: number;
  teamId: number;
  reason?: string;
  requestMetadata: ApiRequestMetadata;
};

export const cancelDocument = async ({ id, userId, teamId, reason, requestMetadata }: CancelDocumentOptions) => {
  // Resolve the envelope through the visibility-aware helper so the caller must
  // have read access (ownership OR team membership with sufficient visibility OR
  // team-email). This prevents cancelling a document the caller cannot see.
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    userId,
    teamId,
    type: EnvelopeType.DOCUMENT,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      documentMeta: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  const isUserOwner = envelope.userId === userId;

  const teamRole = await getMemberRoles({
    teamId: envelope.teamId,
    reference: {
      type: 'User',
      id: userId,
    },
  })
    .then((roles) => roles.teamRole)
    .catch(() => null);

  const isPrivilegedTeamMember = teamRole && isMemberManagerOrAbove(teamRole);

  // The document is visible to the caller, but cancelling requires elevated permissions.
  if (!isUserOwner && !isPrivilegedTeamMember) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Not allowed',
    });
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Only pending documents can be cancelled',
    });
  }

  const updatedEnvelope = await prisma.$transaction(async (tx) => {
    // Rejection takes this lock too, so a rejection that committed before the cancel is seen here. A committed
    // rejection fixes the outcome: the seal records it as REJECTED, and the cancel is refused (#122).
    const [locked] = await tx.$queryRaw<Array<{ status: DocumentStatus }>>`
      SELECT "status" FROM "Envelope" WHERE "id" = ${envelope.id} FOR NO KEY UPDATE
    `;

    if (locked?.status !== DocumentStatus.PENDING) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Only pending documents can be cancelled',
      });
    }

    const rejection = await tx.recipient.findFirst({
      where: { envelopeId: envelope.id, signingStatus: SigningStatus.REJECTED },
      select: { id: true },
    });

    if (rejection) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Document has been rejected by a recipient and cannot be cancelled',
      });
    }

    // Conditional, so a cancel that loses to the seal, another cancel or a rejection changes nothing and says so.
    const { count } = await tx.envelope.updateMany({
      where: {
        id: envelope.id,
        status: DocumentStatus.PENDING,
        recipients: { none: { signingStatus: SigningStatus.REJECTED } },
      },
      data: {
        status: DocumentStatus.CANCELLED,
        completedAt: new Date(),
      },
    });

    if (count === 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Only pending documents can be cancelled',
      });
    }

    const updated = await tx.envelope.findUniqueOrThrow({
      where: {
        id: envelope.id,
      },
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_CANCELLED,
        metadata: requestMetadata,
        data: {
          reason,
        },
      }),
    });

    return updated;
  });

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  // Send cancellation emails to recipients via the resilient background job.
  await jobs.triggerJob({
    name: 'send.document.cancelled.emails',
    payload: {
      documentId: legacyDocumentId,
      cancellationReason: reason,
      requestMetadata: requestMetadata.requestMetadata,
    },
  });

  // Trigger the webhook with the updated (cancelled) envelope payload.
  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_CANCELLED,
    data: ZWebhookDocumentSchema.parse(
      mapEnvelopeToWebhookDocumentPayload({
        ...envelope,
        status: updatedEnvelope.status,
        completedAt: updatedEnvelope.completedAt,
      }),
    ),
    userId,
    teamId,
  });

  return updatedEnvelope;
};
