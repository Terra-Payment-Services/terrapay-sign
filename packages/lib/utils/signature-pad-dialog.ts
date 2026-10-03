import { match } from 'ts-pattern';

export type SignaturePadDialogState = {
  /** Whether the signature dialog is on screen. */
  isOpen: boolean;
  /**
   * What the signer has drawn, typed or uploaded since the dialog opened.
   *
   * Nothing reads this except the confirm button, and it is discarded the
   * moment the dialog closes by any route other than that button.
   */
  pending: string;
};

export type SignaturePadDialogEvent =
  /** The signer opened the dialog. `committed` is the field's current value. */
  | { type: 'open'; committed: string }
  /** The pad produced a new image or typed name. */
  | { type: 'edit'; value: string }
  /** The dialog closed without the signer confirming: cancel, escape, a click on the overlay. */
  | { type: 'dismiss'; committed: string }
  /** The signer pressed the confirm button and `pending` has gone to the field. */
  | { type: 'commit' };

export const initialSignaturePadDialogState = (committed = ''): SignaturePadDialogState => ({
  isOpen: false,
  pending: committed,
});

/**
 * The pending signature belongs to one visit to the dialog.
 *
 * Holding it across a dismissal is what upstream #3203 describes. A signer who
 * draws, decides against it and presses Cancel gets the dialog closed and the
 * field left alone, which is the right outcome and the one they see. The
 * drawing stayed in memory though, and the pad that unmounts with the dialog
 * took its canvas with it. Reopening therefore showed an empty pad above a
 * confirm button that was already enabled, and pressing it wrote the abandoned
 * drawing onto the envelope. The signer had no way to tell: the pad they were
 * looking at was blank.
 *
 * So every entry to and exit from the dialog reseeds `pending` from the value
 * on the field. What is on screen and what would be committed are then the same
 * thing at all times.
 *
 * `commit` leaves `pending` alone because the caller has just handed it to the
 * field. The next `open` reseeds from whatever the field ended up with, which
 * covers a parent that rejects or rewrites the value.
 */
export const signaturePadDialogReducer = (
  state: SignaturePadDialogState,
  event: SignaturePadDialogEvent,
): SignaturePadDialogState =>
  match(event)
    .with({ type: 'open' }, ({ committed }) => ({ isOpen: true, pending: committed }))
    .with({ type: 'edit' }, ({ value }) => ({ ...state, pending: value }))
    .with({ type: 'dismiss' }, ({ committed }) => ({ isOpen: false, pending: committed }))
    .with({ type: 'commit' }, () => ({ ...state, isOpen: false }))
    .exhaustive();

/**
 * May the confirm button write `pending` to the field?
 *
 * Only when there is something to write. An enabled confirm button over a blank
 * pad is the tell for a signature the signer cannot see.
 */
export const canCommitSignature = (state: SignaturePadDialogState): boolean => state.pending !== '';
