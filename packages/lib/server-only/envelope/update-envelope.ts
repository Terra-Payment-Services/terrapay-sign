import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import type { CreateDocumentAuditLogDataResponse } from '@documenso/lib/utils/document-audit-logs';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import type { DocumentMeta, DocumentVisibility, Envelope, Prisma, TemplateType } from '@prisma/client';
import { DocumentStatus, EnvelopeType, FolderType, WebhookTriggerEvents } from '@prisma/client';
import { isDeepEqual } from 'remeda';

import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { TDocumentAccessAuthTypes, TDocumentActionAuthTypes } from '../../types/document-auth';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import {
  assertAccountAccessAuthNotAdded,
  createDocumentAuthOptions,
  extractDocumentAuthMethods,
} from '../../utils/document-auth';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { buildTeamWhereQuery, canAccessTeamDocument } from '../../utils/teams';
import { assertMergedDocumentMetaMethodsEnabled } from '../document-meta/assert-signature-methods-enabled';
import { warnIgnoredEmailId } from '../email/warn-ignored-email-id';
import {
  assertSigningOrderTypeChangeAllowed,
  lockEnvelopeForSigningOrderEdit,
} from '../recipient/assert-signing-order-edit-allowed';
import { recomputeNextReminderForEnvelope } from '../recipient/update-recipient-next-reminder';
import { assertCompatibleDictateNextSigner } from '../signature-level/assert-compatible-dictate-next-signer';
import { assertCompatibleSigningOrder } from '../signature-level/assert-compatible-signing-order';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import { assertEnvelopeMutable } from './assert-envelope-mutable';
import { assertEnvelopeSettingsEditable } from './assert-envelope-settings-editable';
import { getEnvelopeWhereInput } from './get-envelope-by-id';

export type UpdateEnvelopeOptions = {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;
  data?: {
    title?: string;
    folderId?: string | null;
    externalId?: string | null;
    visibility?: DocumentVisibility;
    globalAccessAuth?: TDocumentAccessAuthTypes[];
    globalActionAuth?: TDocumentActionAuthTypes[];
    publicTitle?: string;
    publicDescription?: string;
    templateType?: TemplateType;
    useLegacyFieldInsertion?: boolean;
  };
  meta?: Partial<Omit<DocumentMeta, 'id'>>;
  requestMetadata: ApiRequestMetadata;
};

export const updateEnvelope = async ({
  userId,
  teamId,
  id,
  data = {},
  meta = {},
  requestMetadata,
}: UpdateEnvelopeOptions) => {
  const { envelopeWhereInput, team } = await getEnvelopeWhereInput({
    id,
    type: null, // Allow updating both documents and templates.
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      documentMeta: true,
      team: {
        select: {
          organisationId: true,
          organisation: {
            select: {
              organisationClaim: true,
            },
          },
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

  if (meta.signingOrder !== undefined) {
    assertCompatibleSigningOrder({
      signatureLevel: envelope.signatureLevel,
      signingOrder: meta.signingOrder,
    });
  }

  if (meta.allowDictateNextSigner !== undefined) {
    assertCompatibleDictateNextSigner({
      signatureLevel: envelope.signatureLevel,
      allowDictateNextSigner: meta.allowDictateNextSigner,
    });
  }

  if (envelope.type !== EnvelopeType.TEMPLATE && (data.publicTitle || data.publicDescription || data.templateType)) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'You cannot update the template fields for document type envelopes',
    });
  }

  // If no data just return the document since this function is normally chained after a meta update.
  if (Object.values(data).length === 0 && Object.keys(meta).length === 0) {
    return envelope;
  }

  const isEnvelopeOwner = envelope.userId === userId;

  // Validate whether the new visibility setting is allowed for the current user.
  if (!isEnvelopeOwner && data?.visibility && !canAccessTeamDocument(team.currentTeamRole, data.visibility)) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'You do not have permission to update the envelope visibility',
    });
  }

  const { documentAuthOption } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
  });

  const documentGlobalAccessAuth = documentAuthOption?.globalAccessAuth ?? null;
  const documentGlobalActionAuth = documentAuthOption?.globalActionAuth ?? null;

  // If the new global auth values aren't passed in, fallback to the current document values.
  const newGlobalAccessAuth = data?.globalAccessAuth === undefined ? documentGlobalAccessAuth : data.globalAccessAuth;
  const newGlobalActionAuth = data?.globalActionAuth === undefined ? documentGlobalActionAuth : data.globalActionAuth;

  assertAccountAccessAuthNotAdded({ requested: newGlobalAccessAuth, existing: documentGlobalAccessAuth });

  // Check if user has permission to set the global action auth.
  if (newGlobalActionAuth.length > 0 && !envelope.team.organisation.organisationClaim.flags.cfr21) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'You do not have permission to set the action auth',
    });
  }

  // Organisation sender addresses were removed: emailId is accepted, logged and never stored.
  const { emailId, ...metaWithoutEmailId } = meta;

  warnIgnoredEmailId({ emailId, teamId, organisationId: envelope.team.organisationId });

  let folderUpdateQuery: Prisma.FolderUpdateOneWithoutEnvelopesNestedInput | undefined;

  // Validate folder ID.
  if (data.folderId) {
    const folder = await prisma.folder.findFirst({
      where: {
        id: data.folderId,
        team: buildTeamWhereQuery({
          teamId,
          userId,
        }),
        type: envelope.type === EnvelopeType.TEMPLATE ? FolderType.TEMPLATE : FolderType.DOCUMENT,
        visibility: {
          in: TEAM_DOCUMENT_VISIBILITY_MAP[team.currentTeamRole],
        },
      },
    });

    if (!folder) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Folder not found',
      });
    }

    folderUpdateQuery = {
      connect: {
        id: data.folderId,
      },
    };
  }

  // Move to root folder if folderId is null.
  if (data.folderId === null) {
    folderUpdateQuery = {
      disconnect: true,
    };
  }

  const isTitleSame = data.title === undefined || data.title === envelope.title;
  const isExternalIdSame = data.externalId === undefined || data.externalId === envelope.externalId;
  const isDocumentVisibilitySame = data.visibility === undefined || data.visibility === envelope.visibility;
  const isFolderSame = data.folderId === undefined || data.folderId === envelope.folderId;
  const isTemplateTypeSame = data.templateType === undefined || data.templateType === envelope.templateType;
  const isPublicDescriptionSame =
    data.publicDescription === undefined || data.publicDescription === envelope.publicDescription;
  const isPublicTitleSame = data.publicTitle === undefined || data.publicTitle === envelope.publicTitle;

  const auditLogs: CreateDocumentAuditLogDataResponse[] = [];

  if (!isTitleSame && envelope.status !== DocumentStatus.DRAFT && envelope.status !== DocumentStatus.PENDING) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Envelope title can only be updated while in draft or pending status',
    });
  }

  if (!isTitleSame) {
    auditLogs.push(
      createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_TITLE_UPDATED,
        envelopeId: envelope.id,
        metadata: requestMetadata,
        data: {
          from: envelope.title,
          to: data.title || '',
        },
      }),
    );
  }

  if (!isExternalIdSame) {
    auditLogs.push(
      createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_EXTERNAL_ID_UPDATED,
        envelopeId: envelope.id,
        metadata: requestMetadata,
        data: {
          from: envelope.externalId,
          to: data.externalId || '',
        },
      }),
    );
  }

  if (!isDocumentVisibilitySame) {
    auditLogs.push(
      createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_VISIBILITY_UPDATED,
        envelopeId: envelope.id,
        metadata: requestMetadata,
        data: {
          from: envelope.visibility,
          to: data.visibility || '',
        },
      }),
    );
  }

  // Todo: Decide if we want to log moving the document around.
  // if (!isFolderSame) {
  //   auditLogs.push(
  //     createDocumentAuditLogData({
  //       type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FOLDER_UPDATED,
  //       envelopeId: envelope.id,
  //       metadata: requestMetadata,
  //       data: {
  //         from: envelope.folderId,
  //         to: data.folderId || '',
  //       },
  //     }),
  //   );
  // }

  // Todo: Determine if changes are made
  // Commented out since we didn't detect the changes to sequence.
  // const isMetaSame = isDeepEqual(envelope.documentMeta, meta);
  // Early return if nothing is required.
  // if (
  //   auditLogs.length === 0 &&
  //   data.useLegacyFieldInsertion === undefined &&
  //   isFolderSame &&
  //   isTemplateTypeSame &&
  //   isPublicDescriptionSame &&
  //   isPublicTitleSame
  // ) {
  //   return envelope;
  // }

  const updatedEnvelope = await prisma.$transaction(async (tx) => {
    await assertEnvelopeMutable(envelope, tx);

    // A finished envelope keeps its settings; folder, visibility and externalId may still change (#182).
    // Auth and legacy field insertion are compared with the locked row, not the read above.
    const locked = await assertEnvelopeSettingsEditable(tx, {
      envelopeId: envelope.id,
      meta: metaWithoutEmailId,
      hasOtherSettingsChange: (lockedSettings) => {
        const lockedAuth = resolveGlobalAuth(lockedSettings.authOptions, data);

        return (
          !lockedAuth.isAccessSame ||
          !lockedAuth.isActionSame ||
          (data.useLegacyFieldInsertion !== undefined &&
            data.useLegacyFieldInsertion !== lockedSettings.useLegacyFieldInsertion)
        );
      },
    });

    const globalAuth = resolveGlobalAuth(locked.authOptions, data);

    if (!globalAuth.isAccessSame) {
      auditLogs.push(
        createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_GLOBAL_AUTH_ACCESS_UPDATED,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            from: globalAuth.fromAccess,
            to: globalAuth.toAccess,
          },
        }),
      );
    }

    if (!globalAuth.isActionSame) {
      auditLogs.push(
        createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_GLOBAL_AUTH_ACTION_UPDATED,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            from: globalAuth.fromAction,
            to: globalAuth.toAction,
          },
        }),
      );
    }

    const isGlobalAuthRequested = data.globalAccessAuth !== undefined || data.globalActionAuth !== undefined;

    if (envelope.type === EnvelopeType.DOCUMENT) {
      const lockedOrder = await lockEnvelopeForSigningOrderEdit(tx, envelope.id);

      assertSigningOrderTypeChangeAllowed({
        ...lockedOrder,
        currentSigningOrder: lockedOrder.signingOrder,
        nextSigningOrder: meta.signingOrder,
      });
    }

    // Checked on the locked row, so two updates cannot together turn all three methods off (C94).
    await assertMergedDocumentMetaMethodsEnabled(tx, envelope.documentMetaId, meta);

    const result = await tx.envelope.update({
      where: {
        id: envelope.id,
      },
      data: {
        title: data.title,
        externalId: data.externalId,
        visibility: data.visibility,
        templateType: data.templateType,
        publicDescription: data.publicDescription,
        publicTitle: data.publicTitle,
        useLegacyFieldInsertion: data.useLegacyFieldInsertion,
        // Written only when requested, so an unrelated edit does not rewrite a stored null; omitted parts keep the
        // locked row's values (#182).
        authOptions: isGlobalAuthRequested
          ? createDocumentAuthOptions({ globalAccessAuth: globalAuth.toAccess, globalActionAuth: globalAuth.toAction })
          : undefined,
        folder: folderUpdateQuery,
        documentMeta: {
          update: {
            ...metaWithoutEmailId,
            emailSettings: meta?.emailSettings || undefined,
          },
        },
      },
      include: {
        documentMeta: true,
        recipients: true,
      },
    });

    if (envelope.type === EnvelopeType.DOCUMENT) {
      await tx.documentAuditLog.createMany({
        data: auditLogs,
      });
    }

    return result;
  });

  // Recompute reminders for active recipients when reminder settings change.
  if (meta && 'reminderSettings' in meta) {
    await recomputeNextReminderForEnvelope(envelope.id);
  }

  if (envelope.type === EnvelopeType.TEMPLATE) {
    await triggerWebhook({
      event: WebhookTriggerEvents.TEMPLATE_UPDATED,
      data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(updatedEnvelope)),
      userId,
      teamId,
    });
  }

  // deconstruct to remove the recipients and documentMeta from the returned object since they aren't needed and can be large.
  const { recipients: _recipients, documentMeta: _documentMeta, ...finalEnvelope } = updatedEnvelope;

  return finalEnvelope;
};

// The requested global auth against a stored value; an omitted part keeps the stored one (#182).
const resolveGlobalAuth = (storedAuthOptions: Envelope['authOptions'], data: UpdateEnvelopeOptions['data']) => {
  const { documentAuthOption } = extractDocumentAuthMethods({
    documentAuth: storedAuthOptions,
  });

  const fromAccess = documentAuthOption?.globalAccessAuth ?? null;
  const fromAction = documentAuthOption?.globalActionAuth ?? null;
  const toAccess = data?.globalAccessAuth === undefined ? fromAccess : data.globalAccessAuth;
  const toAction = data?.globalActionAuth === undefined ? fromAction : data.globalActionAuth;

  return {
    fromAccess,
    fromAction,
    toAccess,
    toAction,
    isAccessSame: isDeepEqual(fromAccess, toAccess),
    isActionSame: isDeepEqual(fromAction, toAction),
  };
};
