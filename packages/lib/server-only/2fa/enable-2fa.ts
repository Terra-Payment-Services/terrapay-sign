import { prisma } from '@documenso/prisma';
import { type User, UserSecurityAuditLogType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { getBackupCodes } from './get-backup-code';
import { verifyTwoFactorAuthenticationToken } from './verify-2fa-token';

type EnableTwoFactorAuthenticationOptions = {
  user: Pick<User, 'id' | 'email' | 'twoFactorEnabled' | 'twoFactorSecret'>;
  code: string;
  requestMetadata?: RequestMetadata;
};

export const enableTwoFactorAuthentication = async ({
  user,
  code,
  requestMetadata,
}: EnableTwoFactorAuthenticationOptions) => {
  if (user.twoFactorEnabled) {
    throw new AppError('TWO_FACTOR_ALREADY_ENABLED');
  }

  if (!user.twoFactorSecret) {
    throw new AppError(AppErrorCode.TWO_FACTOR_SETUP_REQUIRED);
  }

  const isValidToken = await verifyTwoFactorAuthenticationToken({ user, totpCode: code });

  if (!isValidToken) {
    throw new AppError(AppErrorCode.INCORRECT_TWO_FACTOR_CODE);
  }

  let recoveryCodes: string[] = [];

  await prisma.$transaction(async (tx) => {
    // A setup that lands after the code was checked replaces the secret; enable only the one checked.
    const { count } = await tx.user.updateMany({
      where: {
        id: user.id,
        twoFactorEnabled: false,
        twoFactorSecret: user.twoFactorSecret,
      },
      data: {
        twoFactorEnabled: true,
      },
    });

    if (count === 0) {
      throw new AppError(AppErrorCode.INCORRECT_TWO_FACTOR_CODE);
    }

    const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });

    recoveryCodes = getBackupCodes({ user: updatedUser }) ?? [];

    if (recoveryCodes.length === 0) {
      throw new AppError('MISSING_BACKUP_CODE');
    }

    await tx.userSecurityAuditLog.create({
      data: {
        userId: user.id,
        type: UserSecurityAuditLogType.AUTH_2FA_ENABLE,
        userAgent: requestMetadata?.userAgent,
        ipAddress: requestMetadata?.ipAddress,
      },
    });
  });

  return { recoveryCodes };
};
