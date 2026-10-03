import { describe, expect, it } from 'vitest';

import type { SignaturePadDialogEvent, SignaturePadDialogState } from './signature-pad-dialog';
import { canCommitSignature, initialSignaturePadDialogState, signaturePadDialogReducer } from './signature-pad-dialog';

const DRAWN = 'data:image/png;base64,aaaaaaaaaaaaaaaa';
const OTHER_DRAWN = 'data:image/png;base64,bbbbbbbbbbbbbbbb';

/** Replay a sequence of events the way the dialog would. */
const replay = (committed: string, events: SignaturePadDialogEvent[]): SignaturePadDialogState =>
  events.reduce(signaturePadDialogReducer, initialSignaturePadDialogState(committed));

describe('signaturePadDialogReducer', () => {
  // Upstream #3203. The signer drew, changed their mind and pressed Cancel.
  // Nothing went to the field, which is what they asked for and what they saw.
  it('drops a drawing the signer cancelled', () => {
    const state = replay('', [
      { type: 'open', committed: '' },
      { type: 'edit', value: DRAWN },
      { type: 'dismiss', committed: '' },
    ]);

    expect(state.pending).toBe('');
    expect(state.isOpen).toBe(false);
  });

  // The defect proper. Reopening showed an empty pad, because the pad unmounts
  // with the dialog, over a confirm button that would have written the drawing
  // from the previous visit.
  it('offers nothing to commit when the dialog is reopened after a cancel', () => {
    const state = replay('', [
      { type: 'open', committed: '' },
      { type: 'edit', value: DRAWN },
      { type: 'dismiss', committed: '' },
      { type: 'open', committed: '' },
    ]);

    expect(state.pending).toBe('');
    expect(canCommitSignature(state)).toBe(false);
  });

  // Escape and a click on the overlay reach the same close handler as Cancel,
  // so one dismiss event covers all three and the reducer has no opinion about
  // which it was.
  it('treats every route out of the dialog as a dismissal', () => {
    const state = replay('', [
      { type: 'open', committed: '' },
      { type: 'edit', value: DRAWN },
      { type: 'dismiss', committed: '' },
      { type: 'open', committed: '' },
      { type: 'edit', value: OTHER_DRAWN },
      { type: 'dismiss', committed: '' },
    ]);

    expect(state.pending).toBe('');
  });

  // A field that already holds a signature keeps it. Cancelling an edit means
  // the earlier signature stands, not that the field is emptied.
  it('restores the signature already on the field when an edit is cancelled', () => {
    const state = replay(DRAWN, [
      { type: 'open', committed: DRAWN },
      { type: 'edit', value: OTHER_DRAWN },
      { type: 'dismiss', committed: DRAWN },
    ]);

    expect(state.pending).toBe(DRAWN);
    expect(canCommitSignature(state)).toBe(true);
  });

  it('carries a confirmed signature out to the caller', () => {
    const state = replay('', [
      { type: 'open', committed: '' },
      { type: 'edit', value: DRAWN },
    ]);

    expect(canCommitSignature(state)).toBe(true);
    expect(state.pending).toBe(DRAWN);
    expect(signaturePadDialogReducer(state, { type: 'commit' }).isOpen).toBe(false);
  });

  // Clearing the pad reports an empty string, which must disable confirm rather
  // than leave the last stroke standing.
  it('disables confirm once the pad is cleared', () => {
    const state = replay('', [
      { type: 'open', committed: '' },
      { type: 'edit', value: DRAWN },
      { type: 'edit', value: '' },
    ]);

    expect(canCommitSignature(state)).toBe(false);
  });

  // Reopening after a confirm seeds from whatever the field ended up holding,
  // so a parent that rewrote or refused the value is not contradicted.
  it('seeds a reopen from the field rather than from the last commit', () => {
    const afterCommit = replay('', [
      { type: 'open', committed: '' },
      { type: 'edit', value: DRAWN },
      { type: 'commit' },
    ]);

    expect(signaturePadDialogReducer(afterCommit, { type: 'open', committed: '' }).pending).toBe('');
    expect(signaturePadDialogReducer(afterCommit, { type: 'open', committed: OTHER_DRAWN }).pending).toBe(OTHER_DRAWN);
  });

  it('starts closed with whatever the field holds', () => {
    expect(initialSignaturePadDialogState(DRAWN)).toEqual({ isOpen: false, pending: DRAWN });
    expect(initialSignaturePadDialogState()).toEqual({ isOpen: false, pending: '' });
  });
});

describe('canCommitSignature', () => {
  it('refuses an empty pending signature', () => {
    expect(canCommitSignature({ isOpen: true, pending: '' })).toBe(false);
  });

  it('allows a typed name as readily as a drawing', () => {
    expect(canCommitSignature({ isOpen: true, pending: 'Jane Signer' })).toBe(true);
  });
});
