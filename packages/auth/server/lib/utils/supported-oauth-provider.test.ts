import { AppErrorCode } from '@documenso/lib/errors/app-error';
import { describe, expect, it } from 'vitest';

import { MicrosoftAuthOptions } from '../../config';
import { assertSupportedOAuthProvider } from './supported-oauth-provider';

describe('assertSupportedOAuthProvider', () => {
  it('admits Microsoft', () => {
    expect(() => assertSupportedOAuthProvider(MicrosoftAuthOptions)).not.toThrow();
  });

  it.each(['google', 'oidc'])('refuses %s even when it is fully configured', (id) => {
    const configured = {
      ...MicrosoftAuthOptions,
      id,
      clientId: 'id',
      clientSecret: 'secret',
      wellKnownUrl: 'https://idp.example',
    };

    expect(() => assertSupportedOAuthProvider(configured)).toThrow(
      expect.objectContaining({ code: AppErrorCode.NOT_SETUP }),
    );
  });
});
