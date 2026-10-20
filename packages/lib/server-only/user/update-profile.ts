import { prisma } from '@documenso/prisma';
import { UserSecurityAuditLogType } from '@prisma/client';

import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { assertValidSignatureValue } from '../signature/assert-valid-signature-value';

export type UpdateProfileOptions = {
  userId: number;
  name: string;
  signature: string;
  requestMetadata?: RequestMetadata;
};

export const updateProfile = async ({ userId, name, signature, requestMetadata }: UpdateProfileOptions) => {
  // Existence check
  await prisma.user.findFirstOrThrow({
    where: {
      id: userId,
    },
  });

  // An empty string clears the saved signature; anything else must be a valid signature, stored normalised.
  const storedSignature =
    signature === ''
      ? ''
      : await assertValidSignatureValue({ value: signature }).then(
          (valid) => valid.signatureImageAsBase64 ?? valid.typedSignature ?? '',
        );

  await prisma.$transaction(async (tx) => {
    await tx.userSecurityAuditLog.create({
      data: {
        userId,
        type: UserSecurityAuditLogType.ACCOUNT_PROFILE_UPDATE,
        userAgent: requestMetadata?.userAgent,
        ipAddress: requestMetadata?.ipAddress,
      },
    });

    await tx.user.update({
      where: {
        id: userId,
      },
      data: {
        name,
        signature: storedSignature,
      },
    });
  });
};
