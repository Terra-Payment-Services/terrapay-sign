import type { User } from '@prisma/client';

import { DOCUMENSO_ENCRYPTION_KEY } from '../../constants/crypto';
import { symmetricEncrypt } from '../../universal/crypto';
import { primaryClient } from '../database/primary-client';
import { getBackupCodes } from './get-backup-code';

type VerifyBackupCodeParams = {
  user: Pick<User, 'id'>;
  backupCode: string;
};

// Each retry follows a concurrent write that consumed another code, so ten codes bound it.
const MAX_ATTEMPTS = 11;

/**
 * Consumes a recovery code, so each code passes once (#135). Returns the list left after removing it, or null
 * when the code is refused.
 *
 * The list is read from the primary and the code is removed by a write conditioned on 2FA still being on and on
 * the exact ciphertext that was read. If another request changed the row first, the write matches nothing and the
 * check repeats on the fresh row, where a code that request spent, or a list that was cleared or replaced, no
 * longer admits this code.
 */
export const consumeBackupCode = async ({ user, backupCode }: VerifyBackupCodeParams) => {
  const key = DOCUMENSO_ENCRYPTION_KEY;

  if (!key) {
    throw new Error('Missing DOCUMENSO_ENCRYPTION_KEY');
  }

  const db = primaryClient();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await db.user.findUnique({
      where: { id: user.id },
      select: { id: true, twoFactorEnabled: true, twoFactorBackupCodes: true },
    });

    if (!current || !current.twoFactorEnabled || !current.twoFactorBackupCodes) {
      return null;
    }

    const userBackupCodes = getBackupCodes({ user: current });

    if (!userBackupCodes || !userBackupCodes.includes(backupCode)) {
      return null;
    }

    const remaining = userBackupCodes.filter((code) => code !== backupCode);

    const { count } = await db.user.updateMany({
      where: { id: user.id, twoFactorEnabled: true, twoFactorBackupCodes: current.twoFactorBackupCodes },
      data: { twoFactorBackupCodes: symmetricEncrypt({ key, data: JSON.stringify(remaining) }) },
    });

    if (count === 1) {
      return remaining;
    }
  }

  return null;
};

export const verifyBackupCode = async (options: VerifyBackupCodeParams) => {
  return (await consumeBackupCode(options)) !== null;
};
