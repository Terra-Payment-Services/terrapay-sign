import { DocumentStatus, type Envelope, type Prisma, SigningStatus } from '@prisma/client';
import { isDeepEqual } from 'remeda';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { lockEnvelopeForOwnerEdit } from '../recipient/lock-envelope-for-owner-edit';

export type AssertEnvelopeSettingsEditableOptions = {
  envelopeId: string;
  /** Requested meta values; an undefined value is not a change. */
  meta: Record<string, unknown>;
  /** Whether the request changes anything outside DocumentMeta that a finished envelope must keep, judged on the locked row. */
  hasOtherSettingsChange?: boolean | ((locked: LockedEnvelopeSettings) => boolean);
};

export type LockedEnvelopeSettings = {
  useLegacyFieldInsertion: boolean;
  authOptions: Envelope['authOptions'];
};

/**
 * Refuses a settings change on a finished envelope: COMPLETED, REJECTED, CANCELLED, or PENDING after a recipient
 * rejected (the seal job has not run yet). The regenerated audit-log PDF reads these settings, so a later edit would
 * change it with no recorded cause (#182).
 *
 * Judged under the envelope row lock that completion, rejection and cancellation also take, so a finish that
 * commits while the caller waits is seen here. A request whose values all equal the stored ones passes.
 *
 * Returns the locked envelope's own settings so the caller writes from them rather than from an earlier read.
 */
export const assertEnvelopeSettingsEditable = async (
  tx: Prisma.TransactionClient,
  { envelopeId, meta, hasOtherSettingsChange = false }: AssertEnvelopeSettingsEditableOptions,
) => {
  const { recipients } = await lockEnvelopeForOwnerEdit(tx, envelopeId);

  const envelope = await tx.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    select: { status: true, documentMeta: true, useLegacyFieldInsertion: true, authOptions: true },
  });

  const locked: LockedEnvelopeSettings = {
    useLegacyFieldInsertion: envelope.useLegacyFieldInsertion,
    authOptions: envelope.authOptions,
  };

  const errorCode = getFinishedErrorCode(
    envelope.status,
    recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED),
  );

  if (!errorCode) {
    return locked;
  }

  const storedMeta: Record<string, unknown> = envelope.documentMeta ?? {};

  const hasMetaChange = Object.entries(meta).some(
    ([key, value]) => value !== undefined && !isDeepEqual(value, storedMeta[key]),
  );

  const hasOtherChange =
    typeof hasOtherSettingsChange === 'function' ? hasOtherSettingsChange(locked) : hasOtherSettingsChange;

  if (!hasMetaChange && !hasOtherChange) {
    return locked;
  }

  throw new AppError(errorCode, {
    message: 'Document settings cannot be changed once the document is completed, rejected or cancelled.',
  });
};

const getFinishedErrorCode = (status: DocumentStatus, hasRejectedRecipient: boolean) => {
  if (status === DocumentStatus.COMPLETED) {
    return AppErrorCode.ENVELOPE_COMPLETED;
  }

  if (status === DocumentStatus.CANCELLED) {
    return AppErrorCode.ENVELOPE_CANCELLED;
  }

  if (status === DocumentStatus.REJECTED || hasRejectedRecipient) {
    return AppErrorCode.ENVELOPE_REJECTED;
  }

  return null;
};
