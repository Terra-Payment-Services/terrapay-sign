// Ported from upstream 573c928a0 (#3319), recipient-groups.test.ts from `isRecipientTurnBySigningOrder` onwards,
// for the order gate (#145).
import { RecipientRole, SigningStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  getNextDictatableRecipient,
  getRecipientsInActiveSigningStep,
  isRecipientTurnBySigningOrder,
} from './recipient-groups';

describe('isRecipientTurnBySigningOrder', () => {
  const recipient = (
    id: number,
    signingOrder: number | null,
    signingStatus: SigningStatus,
    role: RecipientRole = RecipientRole.SIGNER,
  ) => ({ id, signingOrder, signingStatus, role });

  it('allows both members of the active group regardless of member order', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.SIGNED),
      recipient(2, 2, SigningStatus.NOT_SIGNED),
      recipient(3, 2, SigningStatus.NOT_SIGNED),
      recipient(4, 3, SigningStatus.NOT_SIGNED),
    ];

    expect(isRecipientTurnBySigningOrder(recipients, recipients[1])).toBe(true);
    expect(isRecipientTurnBySigningOrder(recipients, recipients[2])).toBe(true);
    expect(isRecipientTurnBySigningOrder(recipients, recipients[3])).toBe(false);
  });

  it('blocks later steps until every group member has signed', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.SIGNED),
      recipient(2, 2, SigningStatus.SIGNED),
      recipient(3, 2, SigningStatus.NOT_SIGNED),
      recipient(4, 3, SigningStatus.NOT_SIGNED),
    ];

    expect(isRecipientTurnBySigningOrder(recipients, recipients[3])).toBe(false);
  });

  it('treats a rejected recipient in an earlier step as blocking', () => {
    const recipients = [recipient(1, 1, SigningStatus.REJECTED), recipient(2, 2, SigningStatus.NOT_SIGNED)];

    expect(isRecipientTurnBySigningOrder(recipients, recipients[1])).toBe(false);
  });

  it('ignores CC recipients entirely', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.NOT_SIGNED, RecipientRole.CC),
      recipient(2, 2, SigningStatus.NOT_SIGNED),
    ];

    expect(isRecipientTurnBySigningOrder(recipients, recipients[1])).toBe(true);
  });

  it('sequences recipients without a signing order one at a time by id', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.SIGNED),
      recipient(3, null, SigningStatus.NOT_SIGNED),
      recipient(2, null, SigningStatus.NOT_SIGNED),
    ];

    expect(isRecipientTurnBySigningOrder(recipients, recipients[2])).toBe(true);
    expect(isRecipientTurnBySigningOrder(recipients, recipients[1])).toBe(false);
  });

  it('orders group members by id when strictly sequential', () => {
    const recipients = [recipient(2, 1, SigningStatus.NOT_SIGNED), recipient(1, 1, SigningStatus.NOT_SIGNED)];

    expect(isRecipientTurnBySigningOrder(recipients, recipients[0], { strictlySequential: true })).toBe(false);
    expect(isRecipientTurnBySigningOrder(recipients, recipients[1], { strictlySequential: true })).toBe(true);
    expect(isRecipientTurnBySigningOrder(recipients, recipients[0])).toBe(true);
  });
});

describe('getRecipientsInActiveSigningStep', () => {
  const candidate = (
    id: number,
    signingOrder: number | null,
    signingStatus: SigningStatus = SigningStatus.NOT_SIGNED,
    role: RecipientRole = RecipientRole.SIGNER,
  ) => ({ id, signingOrder, signingStatus, role });

  it('returns every pending recipient sharing the lowest order', () => {
    const recipients = [candidate(3, 2), candidate(4, 2), candidate(5, 3)];

    expect(getRecipientsInActiveSigningStep(recipients).map((r) => r.id)).toEqual([3, 4]);
  });

  it('returns an empty array for no pending recipients', () => {
    expect(getRecipientsInActiveSigningStep([])).toEqual([]);
  });

  it('excludes recipients that have already signed', () => {
    const recipients = [candidate(1, 1, SigningStatus.SIGNED), candidate(2, 2)];

    expect(getRecipientsInActiveSigningStep(recipients).map((r) => r.id)).toEqual([2]);
  });

  // A rejected recipient is not pending: advancing to them would re-activate
  // and re-email somebody who declined to sign.
  it('excludes rejected recipients', () => {
    const recipients = [candidate(1, 1, SigningStatus.REJECTED), candidate(2, 2)];

    expect(getRecipientsInActiveSigningStep(recipients).map((r) => r.id)).toEqual([2]);
  });

  it('excludes CC recipients', () => {
    const recipients = [
      candidate(1, 1, SigningStatus.NOT_SIGNED, RecipientRole.CC),
      candidate(2, 2, SigningStatus.NOT_SIGNED),
    ];

    expect(getRecipientsInActiveSigningStep(recipients).map((r) => r.id)).toEqual([2]);
  });

  it('returns an empty array when every recipient is signed or rejected', () => {
    const recipients = [candidate(1, 1, SigningStatus.SIGNED), candidate(2, 2, SigningStatus.REJECTED)];

    expect(getRecipientsInActiveSigningStep(recipients)).toEqual([]);
  });

  it('activates a single unordered recipient at a time, lowest id first', () => {
    const recipients = [candidate(7, null), candidate(5, null), candidate(9, null)];

    expect(getRecipientsInActiveSigningStep(recipients).map((r) => r.id)).toEqual([5]);
  });

  it('activates only the lowest id of a group when strictly sequential', () => {
    const recipients = [candidate(4, 1), candidate(3, 1), candidate(5, 2)];

    expect(getRecipientsInActiveSigningStep(recipients, { strictlySequential: true }).map((r) => r.id)).toEqual([3]);
  });
});

describe('getNextDictatableRecipient', () => {
  const recipient = (
    id: number,
    signingOrder: number | null,
    signingStatus: SigningStatus,
    role: RecipientRole = RecipientRole.SIGNER,
  ) => ({ id, signingOrder, signingStatus, role });

  it('returns the next recipient when current is last of their step and next step is a single recipient', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.SIGNED),
      recipient(2, 2, SigningStatus.NOT_SIGNED),
      recipient(3, 3, SigningStatus.NOT_SIGNED),
    ];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 2 })?.id).toBe(3);
  });

  it('returns null while a group peer is still unsigned', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.NOT_SIGNED),
      recipient(2, 1, SigningStatus.NOT_SIGNED),
      recipient(3, 2, SigningStatus.NOT_SIGNED),
    ];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 1 })).toBeNull();
  });

  it('returns the next single recipient once all group peers signed', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.SIGNED),
      recipient(2, 1, SigningStatus.NOT_SIGNED),
      recipient(3, 2, SigningStatus.NOT_SIGNED),
    ];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 2 })?.id).toBe(3);
  });

  it('returns null when the next step is a group', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.NOT_SIGNED),
      recipient(2, 2, SigningStatus.NOT_SIGNED),
      recipient(3, 2, SigningStatus.NOT_SIGNED),
    ];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 1 })).toBeNull();
  });

  it('returns null when there is no later step, for CC targets, or unknown recipients', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.NOT_SIGNED),
      recipient(2, null, SigningStatus.NOT_SIGNED, RecipientRole.CC),
    ];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 1 })).toBeNull();
    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 999 })).toBeNull();
  });

  // The server picks the next recipient from a pending-only query, so an
  // already-signed recipient in a later step must be skipped here too —
  // otherwise the dictated name/email is applied to someone else.
  it('skips an already-signed recipient sitting in a later step', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.NOT_SIGNED),
      recipient(2, 2, SigningStatus.SIGNED),
      recipient(3, 3, SigningStatus.NOT_SIGNED),
    ];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 1 })?.id).toBe(3);
  });

  it('ignores signed members when deciding whether the next step is a group', () => {
    const recipients = [
      recipient(1, 1, SigningStatus.NOT_SIGNED),
      recipient(2, 2, SigningStatus.SIGNED),
      recipient(3, 2, SigningStatus.NOT_SIGNED),
    ];

    // Only one member of step 2 is still pending, which is what the server would rename.
    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 1 })?.id).toBe(3);
  });

  it('returns null when every later recipient has signed', () => {
    const recipients = [recipient(1, 1, SigningStatus.NOT_SIGNED), recipient(2, 2, SigningStatus.SIGNED)];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 1 })).toBeNull();
  });

  it('treats the next unordered recipient by id as a single-recipient step', () => {
    const recipients = [
      recipient(1, null, SigningStatus.NOT_SIGNED),
      recipient(2, null, SigningStatus.NOT_SIGNED),
      recipient(3, null, SigningStatus.NOT_SIGNED),
    ];

    expect(getNextDictatableRecipient({ recipients, currentRecipientId: 1 })?.id).toBe(2);
  });
});
