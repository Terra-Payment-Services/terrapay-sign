import { prisma } from '@documenso/prisma';
import type { User } from '@prisma/client';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

import { DOCUMENSO_ENCRYPTION_KEY } from '../../constants/crypto';
import { symmetricDecrypt } from '../../universal/crypto';

type VerifyTwoFactorAuthenticationTokenOptions = {
  user: Pick<User, 'id' | 'twoFactorSecret'>;
  totpCode: string;
  // The number of windows to look back
  window?: number;
  // The duration that the token is valid for in seconds
  period?: number;
  // Record the code's step so it cannot be used again; false only for recipient 2FA (#226)
  consume?: boolean;
};

export const verifyTwoFactorAuthenticationToken = async ({
  user,
  totpCode,
  window = 1,
  period = 30_000,
  consume = true,
}: VerifyTwoFactorAuthenticationTokenOptions) => {
  const key = DOCUMENSO_ENCRYPTION_KEY;

  if (!key) {
    throw new Error('Missing DOCUMENSO_ENCRYPTION_KEY');
  }

  if (!user.twoFactorSecret) {
    throw new Error('user missing 2fa secret');
  }

  const secret = Buffer.from(symmetricDecrypt({ key, data: user.twoFactorSecret })).toString('utf-8');

  const decodedSecret = base32.decode(secret);

  let now = Date.now();

  for (let i = 0; i < window; i++) {
    const counter = Math.floor(now / period);

    const hotp = await generateHOTP(decodedSecret, counter);

    if (totpCode === hotp) {
      return consume ? await consumeTotpCounter(user.id, user.twoFactorSecret, counter) : true;
    }

    now -= period;
  }

  return false;
};

// One conditional write, so two concurrent uses of a code, or a code older than the last accepted one, fail (#197).
// Bound to the secret the code was checked against, so a request that read a replaced secret cannot spend a step of
// the new one.
const consumeTotpCounter = async (userId: number, twoFactorSecret: string, counter: number) => {
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      twoFactorSecret,
      OR: [{ lastTotpCounter: null }, { lastTotpCounter: { lt: counter } }],
    },
    data: { lastTotpCounter: counter },
  });

  return count === 1;
};
