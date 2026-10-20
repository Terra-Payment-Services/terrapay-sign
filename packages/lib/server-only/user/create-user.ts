import { prisma } from '@documenso/prisma';
import { hash } from '@node-rs/bcrypt';
import type { User } from '@prisma/client';

import { SALT_ROUNDS } from '../../constants/auth';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { createPersonalOrganisation } from '../organisation/create-organisation';
import { isOrganisationCreationAllowed } from '../organisation/organisation-creation-allowed';
import { assertValidSignatureValue } from '../signature/assert-valid-signature-value';

export interface CreateUserOptions {
  name: string;
  email: string;
  password: string;
  signature?: string | null;
}

/**
 * Creates a user with a personal organisation. A signature, when given, passes the check `updateProfile` applies
 * and is stored normalised; an empty or absent one stores none (G4 C34).
 *
 * @throws AppError INVALID_REQUEST for a signature the profile update would refuse; ALREADY_EXISTS for a taken email.
 */
export const createUser = async ({ name, email, password, signature }: CreateUserOptions) => {
  const storedSignature = signature
    ? await assertValidSignatureValue({ value: signature }).then(
        (valid) => valid.signatureImageAsBase64 ?? valid.typedSignature ?? '',
      )
    : signature;

  const hashedPassword = await hash(password, SALT_ROUNDS);

  const userExists = await prisma.user.findFirst({
    where: {
      email: email.toLowerCase(),
    },
  });

  if (userExists) {
    throw new AppError(AppErrorCode.ALREADY_EXISTS);
  }

  const user = await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase(),
      password: hashedPassword, // Todo: (RR7) Drop password.
      signature: storedSignature,
    },
  });

  await onCreateUserHook(user).catch((err) => {
    // Todo: (RR7) Add logging.
    console.error(err);
  });

  return user;
};

export type OnCreateUserHookOptions = {
  /**
   * When true, do not create a "Personal Organisation" for the new user.
   * Used by the Organisation SSO signup path, where the user is intended
   * to operate inside the SSO organisation rather than a personal space.
   *
   * Defaults to false — preserves the historical behaviour of creating a
   * personal organisation for every new user.
   */
  skipPersonalOrganisation?: boolean;
};

/**
 * Should be run after a user is created, example during email password signup or google sign in.
 *
 * @returns User
 */
export const onCreateUserHook = async (user: User, options: OnCreateUserHookOptions = {}) => {
  // The instance holds one organisation, so a personal one is made only on a
  // fresh install that has none.
  if (!options.skipPersonalOrganisation && (await isOrganisationCreationAllowed())) {
    await createPersonalOrganisation({ userId: user.id });
  }

  return user;
};
