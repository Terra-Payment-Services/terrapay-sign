import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TRecipientAccessAuth } from '@documenso/lib/types/document-auth';
import { trpc } from '@documenso/trpc/react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { Envelope, Recipient } from '@prisma/client';
import { useState } from 'react';

import { AccessAuth2FAForm } from './access-auth-2fa-form';
import { DocumentSigningAuthProvider } from './document-signing-auth-provider';

export type DocumentSigningAccess2FAGateProps = {
  documentAuthOptions: Envelope['authOptions'];
  recipient: Pick<Recipient, 'authOptions' | 'email' | 'role' | 'name' | 'token' | 'id'>;
};

/**
 * Shown in place of the document until the recipient enters the access code
 * emailed to them. A correct code sets a short-lived cookie and the page
 * reloads with the document.
 */
export const DocumentSigningAccess2FAGate = ({ documentAuthOptions, recipient }: DocumentSigningAccess2FAGateProps) => {
  const { _ } = useLingui();
  const { sessionData } = useOptionalSession();

  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: verify2FA } = trpc.document.accessAuth.verify2FA.useMutation();

  const onSubmit = async (authOptions: TRecipientAccessAuth) => {
    try {
      setError(null);

      await verify2FA({ token: recipient.token, authOptions });

      window.location.reload();
    } catch (err) {
      const appError = AppError.parseError(err);

      if (appError.code === AppErrorCode.TOO_MANY_REQUESTS) {
        setError(_(msg`Too many incorrect codes. Please wait up to an hour and request a new code.`));

        return;
      }

      setError(_(msg`Invalid verification code. Please try again.`));
    }
  };

  return (
    <DocumentSigningAuthProvider
      documentAuthOptions={documentAuthOptions}
      recipient={recipient}
      user={sessionData?.user}
    >
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4">
        <h1 className="font-semibold text-3xl">
          <Trans>Verification required</Trans>
        </h1>

        <p className="mt-2 text-muted-foreground text-sm">
          <Trans>Enter the code sent to {recipient.email} to view this document.</Trans>
        </p>

        <AccessAuth2FAForm token={recipient.token} onSubmit={onSubmit} error={error} />
      </div>
    </DocumentSigningAuthProvider>
  );
};
