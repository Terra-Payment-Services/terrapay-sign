import { prisma } from '@documenso/prisma';
import { type RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

export type UpdateRecipientOptions = {
  id: number;
  name: string | undefined;
  email: string | undefined;
  role: RecipientRole | undefined;
};

export const updateRecipient = async ({ id, name, email, role }: UpdateRecipientOptions) => {
  await prisma.recipient.findFirstOrThrow({
    where: {
      id,
    },
  });

  // Conditional, so a recipient who signs or rejects concurrently is not edited. A rejecter renamed or turned into
  // a CC here would lose the rejection before the seal reads it (#121).
  const { count } = await prisma.recipient.updateMany({
    where: {
      id,
      signingStatus: {
        notIn: [SigningStatus.SIGNED, SigningStatus.REJECTED],
      },
    },
    data: {
      name,
      email,
      role,
    },
  });

  if (count === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Cannot update a recipient that has already signed or rejected.',
    });
  }

  return await prisma.recipient.findUniqueOrThrow({
    where: {
      id,
    },
  });
};
