import type { Recipient } from '@prisma/client';
import { SigningStatus } from '@prisma/client';

import type { PositionedRecipient } from './recipients';
import { isCcRecipient, isRecipientBefore, isSameSigningStep, sortRecipientsBySigningPosition } from './recipients';

/**
 * A recipient "step" is the set of non-CC recipients sharing an explicit
 * signing order. A step with 2 or more members is a "signing group": members
 * may act in any order among themselves, and the next step only unlocks once
 * every member of the group has completed their action.
 *
 * A recipient without a signing order is always a single-member step (see
 * `PositionedRecipient`).
 *
 * The turn functions below are ported from upstream 573c928a0 (#3319) for the order gate (#145).
 */
type SignableRecipient = Pick<Recipient, 'role' | 'signingStatus'> & PositionedRecipient;

type SequencingOptions = {
  /**
   * See `isRecipientBefore`. Required for AES/QES envelopes.
   */
  strictlySequential?: boolean;
};

/**
 * Whether it is the recipient's turn to act under SEQUENTIAL signing.
 *
 * - A recipient may act once every non-CC recipient positioned before them has signed.
 * - Recipients sharing an explicit signing order never block each other, unless
 *   `strictlySequential` is set.
 * - Callers must check the document is in SEQUENTIAL mode.
 */
export const isRecipientTurnBySigningOrder = <T extends SignableRecipient>(
  recipients: T[],
  currentRecipient: PositionedRecipient,
  options: SequencingOptions = {},
): boolean =>
  !recipients.some(
    (recipient) =>
      !isCcRecipient(recipient) &&
      recipient.signingStatus !== SigningStatus.SIGNED &&
      isRecipientBefore(recipient, currentRecipient, options),
  );

/**
 * Every pending recipient in the earliest pending step — the "active step".
 *
 * - Two or more members form a signing group and act in parallel, unless
 *   `strictlySequential` is set, in which case only the first member by id is
 *   active.
 * - Pending means non-CC and NOT_SIGNED; rejected recipients are excluded so
 *   the flow never re-activates somebody who declined.
 * - Pass the full recipient list: filtering happens here so every caller
 *   agrees on what "pending" means.
 */
export const getRecipientsInActiveSigningStep = <T extends SignableRecipient>(
  recipients: T[],
  options: SequencingOptions = {},
): T[] => {
  const pendingRecipients = sortRecipientsBySigningPosition(
    recipients.filter((recipient) => !isCcRecipient(recipient) && recipient.signingStatus === SigningStatus.NOT_SIGNED),
  );

  const [first] = pendingRecipients;

  if (!first) {
    return [];
  }

  const activeStep = pendingRecipients.filter(
    (recipient) => recipient === first || isSameSigningStep(recipient, first),
  );

  if (!options.strictlySequential) {
    return activeStep;
  }

  return [
    activeStep.reduce((earliest, recipient) =>
      isRecipientBefore(recipient, earliest, options) ? recipient : earliest,
    ),
  ];
};

/**
 * The single recipient that the current recipient may dictate (rename) on
 * completion, or null when dictation does not apply:
 *
 * - the current recipient must be the last unsigned member of their step, and
 * - the next step must contain exactly one pending recipient.
 */
export const getNextDictatableRecipient = <T extends SignableRecipient & Pick<Recipient, 'id'>>({
  recipients,
  currentRecipientId,
}: {
  recipients: T[];
  currentRecipientId: number;
}): T | null => {
  const currentRecipient = recipients.find((recipient) => recipient.id === currentRecipientId);

  if (!currentRecipient || isCcRecipient(currentRecipient)) {
    return null;
  }

  const hasUnsignedPeers = recipients.some(
    (recipient) =>
      recipient.id !== currentRecipientId &&
      !isCcRecipient(recipient) &&
      isSameSigningStep(recipient, currentRecipient) &&
      recipient.signingStatus !== SigningStatus.SIGNED,
  );

  if (hasUnsignedPeers) {
    return null;
  }

  // Only the step matters here; `getRecipientsInActiveSigningStep` drops
  // CCs and anyone who has already signed or rejected.
  const laterRecipients = recipients.filter((recipient) => isRecipientBefore(currentRecipient, recipient));

  const nextStep = getRecipientsInActiveSigningStep(laterRecipients);

  if (nextStep.length !== 1) {
    return null;
  }

  return nextStep[0];
};
