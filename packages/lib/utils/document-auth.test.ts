import { describe, expect, it } from 'vitest';

import { AppError, AppErrorCode } from '../errors/app-error';
import { assertAccountAccessAuthNotAdded, extractDocumentAuthMethods } from './document-auth';

const captureError = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    return err;
  }

  return null;
};

describe('assertAccountAccessAuthNotAdded', () => {
  it('refuses a request that newly asks for account access', () => {
    const error = captureError(() => assertAccountAccessAuthNotAdded({ requested: ['ACCOUNT'] }));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: AppErrorCode.INVALID_BODY });
  });

  it('refuses account access added alongside another method', () => {
    expect(() =>
      assertAccountAccessAuthNotAdded({ requested: ['TWO_FACTOR_AUTH', 'ACCOUNT'], existing: ['TWO_FACTOR_AUTH'] }),
    ).toThrow(AppError);
  });

  it('lets through account access that is already stored', () => {
    expect(() => assertAccountAccessAuthNotAdded({ requested: ['ACCOUNT'], existing: ['ACCOUNT'] })).not.toThrow();
  });

  it('lets through other access methods, an empty list and an omitted value', () => {
    expect(() => assertAccountAccessAuthNotAdded({ requested: ['TWO_FACTOR_AUTH'] })).not.toThrow();
    expect(() => assertAccountAccessAuthNotAdded({ requested: [] })).not.toThrow();
    expect(() => assertAccountAccessAuthNotAdded({ requested: undefined, existing: null })).not.toThrow();
  });

  it('lets a request remove account access that was stored', () => {
    expect(() => assertAccountAccessAuthNotAdded({ requested: [], existing: ['ACCOUNT'] })).not.toThrow();
  });
});

describe('extractDocumentAuthMethods on envelopes that already require an account', () => {
  it('still derives account access for the recipient from the envelope', () => {
    const { derivedRecipientAccessAuth, recipientAccessAuthRequired } = extractDocumentAuthMethods({
      documentAuth: { globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] },
      recipientAuth: { accessAuth: [], actionAuth: [] },
    });

    expect(derivedRecipientAccessAuth).toEqual(['ACCOUNT']);
    expect(recipientAccessAuthRequired).toBe(true);
  });

  it('still derives account access stored on the recipient', () => {
    const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
      documentAuth: { globalAccessAuth: [], globalActionAuth: [] },
      recipientAuth: { accessAuth: ['ACCOUNT'], actionAuth: [] },
    });

    expect(derivedRecipientAccessAuth).toEqual(['ACCOUNT']);
  });
});
