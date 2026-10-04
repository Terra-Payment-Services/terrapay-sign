import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';

import type { OAuthClientOptions } from '../../config';

/**
 * TerraPay Sign admits staff through Entra and nothing else.
 *
 * Upstream's Google and generic OIDC clients have been deleted, but a callback
 * links an identity to the existing account with the same email, so a provider
 * route added back later would quietly trust another authority's word about who
 * someone is. Refusing here keeps "Entra only" a property of the code rather
 * than of whichever routes happen to be mounted.
 *
 * @throws {AppError} NOT_SETUP for any provider other than Microsoft.
 */
export const assertSupportedOAuthProvider = (clientOptions: Pick<OAuthClientOptions, 'id'>): void => {
  if (clientOptions.id !== 'microsoft') {
    throw new AppError(AppErrorCode.NOT_SETUP, {
      message: `Sign-in through ${clientOptions.id} is not supported; TerraPay Sign uses Microsoft Entra only`,
    });
  }
};
