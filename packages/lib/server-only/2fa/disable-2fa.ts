import type { User } from '@prisma/client';
import { UserSecurityAuditLogType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { primaryClient } from '../database/primary-client';
import { validateTwoFactorAuthentication } from './validate-2fa';

type DisableTwoFactorAuthenticationOptions = {
  user: Pick<User, 'id' | 'email' | 'twoFactorEnabled' | 'twoFactorSecret' | 'twoFactorBackupCodes'>;
  totpCode?: string;
  backupCode?: string;
  requestMetadata?: RequestMetadata;
};

export const disableTwoFactorAuthentication = async ({
  totpCode,
  backupCode,
  user: callerUser,
  requestMetadata,
}: DisableTwoFactorAuthenticationOptions) => {
  let isValid = false;

  if (!totpCode && !backupCode) {
    throw new AppError(AppErrorCode.INVALID_REQUEST);
  }

  // The caller's row may come from a lagging replica. Check the code against, and pin the write to, the
  // authenticator the primary holds, which is the one a recovery code is consumed from (#196).
  const user = await primaryClient().user.findUnique({
    where: {
      id: callerUser.id,
    },
    select: {
      id: true,
      email: true,
      twoFactorEnabled: true,
      twoFactorSecret: true,
      twoFactorBackupCodes: true,
    },
  });

  // Already off, or turned off by a request that finished first: nothing of this account's to disable.
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
    throw new AppError(AppErrorCode.INCORRECT_TWO_FACTOR_CODE, { statusCode: 400 });
  }

  if (totpCode) {
    isValid = await validateTwoFactorAuthentication({ totpCode, user });
  } else if (backupCode) {
    isValid = await validateTwoFactorAuthentication({ backupCode, user });
  }

  if (!isValid) {
    throw new AppError(AppErrorCode.INCORRECT_TWO_FACTOR_CODE, { statusCode: 400 });
  }

  await primaryClient().$transaction(async (tx) => {
    // Clear only the authenticator the code was checked against. A disable, setup and enable that land after the
    // check leave a different secret, which this write must not erase (#196).
    const { count } = await tx.user.updateMany({
      where: {
        id: user.id,
        twoFactorEnabled: true,
        twoFactorSecret: user.twoFactorSecret,
      },
      data: {
        twoFactorEnabled: false,
        twoFactorBackupCodes: null,
        twoFactorSecret: null,
      },
    });

    if (count === 0) {
      throw new AppError(AppErrorCode.INCORRECT_TWO_FACTOR_CODE, { statusCode: 400 });
    }

    await tx.userSecurityAuditLog.create({
      data: {
        userId: user.id,
        type: UserSecurityAuditLogType.AUTH_2FA_DISABLE,
        userAgent: requestMetadata?.userAgent,
        ipAddress: requestMetadata?.ipAddress,
      },
    });
  });

  return true;
};
