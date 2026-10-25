import type { Field, Prisma, Recipient } from '@prisma/client';
import { DocumentSigningOrder, DocumentStatus, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { getRecipientsInActiveSigningStep } from '../../utils/recipient-groups';
import type { PositionedRecipient } from '../../utils/recipients';
import { isCcRecipient, isRecipientBefore } from '../../utils/recipients';
import { lockEnvelopeForOwnerEdit } from './lock-envelope-for-owner-edit';

type LockedRecipient = Pick<Recipient, 'id' | 'role' | 'signingStatus' | 'signingOrder'>;

type LockedField = Pick<Field, 'recipientId' | 'inserted'>;

/**
 * Whether any non-CC recipient has signed, rejected or inserted a field (#157).
 */
const hasAnyRecipientActed = (recipients: LockedRecipient[], fields: LockedField[]) =>
  recipients.some(
    (recipient) =>
      !isCcRecipient(recipient) &&
      (recipient.signingStatus !== SigningStatus.NOT_SIGNED ||
        fields.some((field) => field.recipientId === recipient.id && field.inserted)),
  );

/**
 * Refuses a change between PARALLEL and SEQUENTIAL on a pending document once a recipient has acted, judged on rows
 * read under the owner-edit lock (#157).
 */
export const assertSigningOrderTypeChangeAllowed = ({
  status,
  currentSigningOrder,
  nextSigningOrder,
  recipients,
  fields,
}: {
  status: DocumentStatus;
  currentSigningOrder: DocumentSigningOrder | null | undefined;
  nextSigningOrder: DocumentSigningOrder | undefined;
  recipients: LockedRecipient[];
  fields: LockedField[];
}) => {
  const current = currentSigningOrder ?? DocumentSigningOrder.PARALLEL;

  if (nextSigningOrder === undefined || nextSigningOrder === current || status !== DocumentStatus.PENDING) {
    return;
  }

  if (hasAnyRecipientActed(recipients, fields)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'The signing order cannot be changed after a recipient has signed or filled a field.',
    });
  }
};

/**
 * Refuses a recipient write on a pending SEQUENTIAL document that moves anyone whose turn has come or passed, or puts
 * anyone else at or ahead of the signer whose turn it is (#157).
 *
 * `next` is the full recipient list as it would be after the write: persisted recipients keep their id, new ones
 * have none. Recipients absent from `next` are being deleted, which this check leaves to the delete rules.
 */
export const assertSigningPositionsAllowed = ({
  status,
  signingOrder,
  recipients,
  next,
}: {
  status: DocumentStatus;
  signingOrder: DocumentSigningOrder | null | undefined;
  recipients: LockedRecipient[];
  next: Array<Pick<Recipient, 'role'> & PositionedRecipient>;
}) => {
  if (status !== DocumentStatus.PENDING || signingOrder !== DocumentSigningOrder.SEQUENTIAL) {
    return;
  }

  const [first] = getRecipientsInActiveSigningStep(recipients);

  if (!first) {
    return;
  }

  // At or before the active step: everyone whose turn has come or passed.
  const settledIds = new Set(
    recipients
      .filter((recipient) => !isCcRecipient(recipient) && !isRecipientBefore(first, recipient))
      .map((recipient) => recipient.id),
  );

  const isRefused = next.some((candidate) => {
    const persisted =
      typeof candidate.id === 'number' ? recipients.find((recipient) => recipient.id === candidate.id) : undefined;

    // Judged before the CC exemption, so a recipient whose turn has come or passed cannot step out as a CC and back
    // in at another position (#157 C2b).
    if (persisted && settledIds.has(persisted.id)) {
      return isCcRecipient(candidate) || (persisted.signingOrder ?? null) !== (candidate.signingOrder ?? null);
    }

    // Only a recipient that is and stays CC, or a new CC, is exempt. A stored CC becoming a signer enters the order,
    // and a signer becoming CC is placed like one (#157 C2b, C2d).
    if (isCcRecipient(candidate) && (!persisted || isCcRecipient(persisted))) {
      return false;
    }

    return !isRecipientBefore(first, candidate);
  });

  if (isRefused) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'A recipient cannot be placed at or ahead of the signer whose turn it is.',
    });
  }
};

/**
 * Refuses a request that names the same persisted recipient more than once, so every recipient is checked and written
 * from one entry (#157 C2c).
 */
export const assertRecipientsNamedOnce = (ids: Array<number | null | undefined>) => {
  const persistedIds = ids.filter((id): id is number => typeof id === 'number');

  if (new Set(persistedIds).size !== persistedIds.length) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'A recipient can appear only once in a request.',
    });
  }
};

/**
 * Takes the owner-edit lock and reads what the signing-order rules need under it: the envelope's status and signing
 * order, its recipients and their fields (#157).
 */
export const lockEnvelopeForSigningOrderEdit = async (tx: Prisma.TransactionClient, envelopeId: string) => {
  const { recipients, fields } = await lockEnvelopeForOwnerEdit(tx, envelopeId);

  const { status, documentMeta } = await tx.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    select: { status: true, documentMeta: { select: { signingOrder: true } } },
  });

  return { status, signingOrder: documentMeta?.signingOrder, recipients, fields };
};
