import type { Envelope, Recipient } from '@prisma/client';

import { AppError, AppErrorCode } from '../errors/app-error';

import type {
  TDocumentAuthOptions,
  TRecipientAccessAuthTypes,
  TRecipientActionAuthTypes,
  TRecipientAuthOptions,
} from '../types/document-auth';
import { DocumentAuth, ZDocumentAuthOptionsSchema, ZRecipientAuthOptionsSchema } from '../types/document-auth';

type ExtractDocumentAuthMethodsOptions = {
  documentAuth: Envelope['authOptions'];
  recipientAuth?: Recipient['authOptions'];
};

/**
 * Parses and extracts the document and recipient authentication values.
 *
 * Will combine the recipient and document auth values to derive the final
 * auth values for a recipient if possible.
 */
export const extractDocumentAuthMethods = ({ documentAuth, recipientAuth }: ExtractDocumentAuthMethodsOptions) => {
  const documentAuthOption = ZDocumentAuthOptionsSchema.parse(documentAuth);
  const recipientAuthOption = ZRecipientAuthOptionsSchema.parse(recipientAuth);

  const derivedRecipientAccessAuth: TRecipientAccessAuthTypes[] =
    recipientAuthOption.accessAuth.length > 0 ? recipientAuthOption.accessAuth : documentAuthOption.globalAccessAuth;

  const derivedRecipientActionAuth: TRecipientActionAuthTypes[] =
    recipientAuthOption.actionAuth.length > 0 ? recipientAuthOption.actionAuth : documentAuthOption.globalActionAuth;

  const recipientAccessAuthRequired = derivedRecipientAccessAuth.length > 0;

  const recipientActionAuthRequired =
    derivedRecipientActionAuth.length > 0 && !derivedRecipientActionAuth.includes(DocumentAuth.EXPLICIT_NONE);

  return {
    derivedRecipientAccessAuth,
    derivedRecipientActionAuth,
    recipientAccessAuthRequired,
    recipientActionAuthRequired,
    documentAuthOption,
    recipientAuthOption,
  };
};

/**
 * Create document auth options in a type safe way.
 */
export const createDocumentAuthOptions = (options: TDocumentAuthOptions): TDocumentAuthOptions => {
  return {
    globalAccessAuth: options?.globalAccessAuth ?? [],
    globalActionAuth: options?.globalActionAuth ?? [],
  };
};

/**
 * Create recipient auth options in a type safe way.
 */
export const createRecipientAuthOptions = (options: TRecipientAuthOptions): TRecipientAuthOptions => {
  return {
    accessAuth: options?.accessAuth ?? [],
    actionAuth: options?.actionAuth ?? [],
  };
};

type AssertAccountAccessAuthNotAddedOptions = {
  requested?: TRecipientAccessAuthTypes[] | null;
  existing?: TRecipientAccessAuthTypes[] | null;
};

/**
 * Refuse a write that newly asks for "Require account" access auth, which TerraPay Sign no longer offers.
 *
 * A value that is already stored on the envelope or recipient is let through unchanged, so envelopes created
 * before the option was withdrawn keep working and can still have their other settings edited.
 */
export const assertAccountAccessAuthNotAdded = ({ requested, existing }: AssertAccountAccessAuthNotAddedOptions) => {
  const isAccountRequested = (requested ?? []).includes(DocumentAuth.ACCOUNT);
  const isAccountAlreadySet = (existing ?? []).includes(DocumentAuth.ACCOUNT);

  if (isAccountRequested && !isAccountAlreadySet) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'The "Require account" access option is no longer available.',
    });
  }
};
