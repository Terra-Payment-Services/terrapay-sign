import type { User } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { getBackupCodes } from './get-backup-code';
import { validateTwoFactorAuthentication } from './validate-2fa';
import { consumeBackupCode } from './verify-backup-code';

type ViewBackupCodesOptions = {
  user: Pick<User, 'id' | 'email' | 'twoFactorEnabled' | 'twoFactorSecret' | 'twoFactorBackupCodes'>;
  token: string;
};

/**
 * Returns the recovery codes of the authenticator the token proved. A TOTP code returns the list from the same
 * snapshot whose secret it matched; a recovery code returns the list its consuming write left (#135). Neither
 * re-reads the row, so a setup that replaced this one afterwards is never disclosed.
 */
export const viewBackupCodes = async ({ token, user }: ViewBackupCodesOptions) => {
  const isTotpValid = await validateTwoFactorAuthentication({ totpCode: token, user });

  const backupCodes = isTotpValid ? getBackupCodes({ user }) : await consumeBackupCode({ user, backupCode: token });

  if (!isTotpValid && !backupCodes) {
    throw new AppError(AppErrorCode.INCORRECT_TWO_FACTOR_CODE);
  }

  if (!backupCodes) {
    throw new AppError('MISSING_BACKUP_CODE');
  }

  return backupCodes;
};
