import { prisma } from '@documenso/prisma';
import type { User } from '@prisma/client';
import { base32 } from '@scure/base';
import crypto from 'crypto';
import { createTOTPKeyURI } from 'oslo/otp';

import { DOCUMENSO_ENCRYPTION_KEY } from '../../constants/crypto';
import { AppError } from '../../errors/app-error';
import { symmetricEncrypt } from '../../universal/crypto';

type SetupTwoFactorAuthenticationOptions = {
  user: Pick<User, 'id' | 'email'>;
};

const ISSUER = 'TerraPay Sign';

export const setupTwoFactorAuthentication = async ({ user }: SetupTwoFactorAuthenticationOptions) => {
  const key = DOCUMENSO_ENCRYPTION_KEY;

  if (!key) {
    throw new Error('MISSING_ENCRYPTION_KEY');
  }

  const secret = crypto.randomBytes(10);

  const backupCodes = Array.from({ length: 10 })
    .fill(null)
    .map(() => crypto.randomBytes(5).toString('hex'))
    .map((code) => `${code.slice(0, 5)}-${code.slice(5)}`.toUpperCase());

  const accountName = user.email;
  const uri = createTOTPKeyURI(ISSUER, accountName, secret);
  const encodedSecret = base32.encode(new Uint8Array(secret));

  // Setting up again would replace a working authenticator with only a session; turning 2FA off,
  // which needs a code, comes first. The condition is part of the write, so a concurrent enable
  // cannot slip between a check and the update.
  const { count } = await prisma.user.updateMany({
    where: {
      id: user.id,
      twoFactorEnabled: false,
    },
    data: {
      twoFactorEnabled: false,
      twoFactorBackupCodes: symmetricEncrypt({
        data: JSON.stringify(backupCodes),
        key: key,
      }),
      twoFactorSecret: symmetricEncrypt({
        data: encodedSecret,
        key: key,
      }),
      // Steps used under the old secret say nothing about the new one.
      lastTotpCounter: null,
    },
  });

  if (count === 0) {
    throw new AppError('TWO_FACTOR_ALREADY_ENABLED', { statusCode: 409 });
  }

  return {
    secret: encodedSecret,
    uri,
  };
};
