import { describe, expect, it } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { resolveSignatureLevel } from './resolve-signature-level';

describe('resolveSignatureLevel', () => {
  it('creates an envelope at SES when no level is asked for', () => {
    expect(resolveSignatureLevel()).toBe('SES');
    expect(resolveSignatureLevel({ strict: true })).toBe('SES');
  });

  it('accepts SES in either mode', () => {
    expect(resolveSignatureLevel({ requested: 'SES' })).toBe('SES');
    expect(resolveSignatureLevel({ requested: 'SES', strict: true })).toBe('SES');
  });

  it('coerces AES and QES to SES when not strict', () => {
    expect(resolveSignatureLevel({ requested: 'AES' })).toBe('SES');
    expect(resolveSignatureLevel({ requested: 'QES' })).toBe('SES');
  });

  it('refuses AES and QES when strict', () => {
    for (const requested of ['AES', 'QES'] as const) {
      expect(() => resolveSignatureLevel({ requested, strict: true })).toThrow(
        expect.objectContaining({ code: AppErrorCode.CSC_INSTANCE_MODE_MISMATCH }),
      );
    }
  });

  it('ignores the instance signing transport', () => {
    const previous = process.env.NEXT_PRIVATE_SIGNING_TRANSPORT;
    process.env.NEXT_PRIVATE_SIGNING_TRANSPORT = 'csc';

    try {
      expect(resolveSignatureLevel()).toBe('SES');
      expect(resolveSignatureLevel({ requested: 'QES' })).toBe('SES');
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PRIVATE_SIGNING_TRANSPORT;
      } else {
        process.env.NEXT_PRIVATE_SIGNING_TRANSPORT = previous;
      }
    }
  });
});
