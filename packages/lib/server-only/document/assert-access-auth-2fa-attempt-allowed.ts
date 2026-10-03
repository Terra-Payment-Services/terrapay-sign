import { AppError, AppErrorCode } from '../../errors/app-error';
import { accessAuth2FAAttemptRateLimit } from '../rate-limit/rate-limits';

/**
 * Count one attempt at the emailed access code for this recipient, and throw
 * once the recipient has used up their attempts for the current window.
 *
 * Call it before the code is checked, so that a locked recipient's guesses are
 * never evaluated. Every attempt counts, including the one that succeeds; a
 * correct code completes the document, so nothing follows it.
 */
export const assertAccessAuth2FAAttemptAllowed = async ({ recipientId }: { recipientId: number }) => {
  const result = await accessAuth2FAAttemptRateLimit.check({ ip: `recipient:${recipientId}` });

  if (result.isLimited) {
    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: 'Too many verification code attempts. Please wait before trying again.',
      headers: {
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(result.reset.getTime() / 1000)),
        'Retry-After': String(Math.max(1, Math.ceil((result.reset.getTime() - Date.now()) / 1000))),
      },
    });
  }
};
