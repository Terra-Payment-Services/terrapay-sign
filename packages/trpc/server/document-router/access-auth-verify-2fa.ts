import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { verifyRecipientAccess2FA } from '@documenso/lib/server-only/document/verify-recipient-access-2fa';

import { procedure } from '../trpc';
import { ZAccessAuthVerify2FARequestSchema, ZAccessAuthVerify2FAResponseSchema } from './access-auth-verify-2fa.types';

/**
 * Check the access code a recipient entered on the signing page and set the
 * cookie that lets the page, and the document files, through.
 */
export const accessAuthVerify2FARoute = procedure
  .input(ZAccessAuthVerify2FARequestSchema)
  .output(ZAccessAuthVerify2FAResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { token, authOptions } = input;

    if (!ctx.resHeaders) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Access codes can only be verified from the signing page',
      });
    }

    const { cookie } = await verifyRecipientAccess2FA({
      token,
      authOptions,
      userId: ctx.user?.id,
      requestMetadata: ctx.metadata.requestMetadata,
    });

    ctx.resHeaders.append('Set-Cookie', cookie);

    return { success: true };
  });
