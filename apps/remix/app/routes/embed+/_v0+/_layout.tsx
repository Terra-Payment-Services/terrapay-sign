import { useAnalytics } from '@documenso/lib/client-only/hooks/use-analytics';
import { IS_MICROSOFT_SSO_ENABLED } from '@documenso/lib/constants/auth';
import { Trans } from '@lingui/react/macro';
import { useEffect } from 'react';
import { isRouteErrorResponse, Outlet, useRouteError } from 'react-router';

import { EmbedAuthenticationRequired } from '~/components/embed/embed-authentication-required';
import { EmbedDocumentCompleted } from '~/components/embed/embed-document-completed';
import { EmbedDocumentRejected } from '~/components/embed/embed-document-rejected';
import { EmbedDocumentWaitingForTurn } from '~/components/embed/embed-document-waiting-for-turn';
import { EmbedPaywall } from '~/components/embed/embed-paywall';
import { EmbedRecipientExpired } from '~/components/embed/embed-recipient-expired';
import { DocumentSigningAccess2FAGate } from '~/components/general/document-signing/document-signing-access-2fa-gate';

import type { Route } from './+types/_layout';

// Note: CSP (`frame-ancestors *`), `Referrer-Policy`, and
// `X-Content-Type-Options` are now emitted globally by
// `securityHeadersMiddleware` for any path under `/embed`. See
// `apps/remix/server/security-headers.ts`.
//
// The previous `Access-Control-Allow-*` headers here only ever applied to
// HTML page renders, where CORS preflight does not apply, so they were a
// no-op and have been dropped along with the rest of `headers()`.

export function loader() {
  // SSR env variables.
  const isMicrosoftSSOEnabled = IS_MICROSOFT_SSO_ENABLED;

  return {
    isMicrosoftSSOEnabled,
  };
}

export default function Layout() {
  return <Outlet />;
}

export function ErrorBoundary({ loaderData }: Route.ErrorBoundaryProps) {
  const { isMicrosoftSSOEnabled } = loaderData || {};

  const analytics = useAnalytics();
  const error = useRouteError();

  console.log({ routeError: error });

  useEffect(() => {
    const isExpectedEmbedResponse =
      isRouteErrorResponse(error) &&
      [
        'embed-authentication-required',
        'embed-access-code-required',
        'embed-paywall',
        'embed-waiting-for-turn',
        'embed-recipient-expired',
        'embed-document-rejected',
        'embed-document-completed',
      ].includes(error.data?.type);

    if (isExpectedEmbedResponse) {
      return;
    }

    analytics.captureException(error, { source: 'embed', location: 'embed_layout_boundary' });
  }, [error]);

  if (isRouteErrorResponse(error)) {
    if (error.status === 401 && error.data.type === 'embed-authentication-required') {
      return (
        <EmbedAuthenticationRequired
          isMicrosoftSSOEnabled={isMicrosoftSSOEnabled}
          email={error.data.email}
          returnTo={error.data.returnTo}
        />
      );
    }

    if (error.status === 401 && error.data.type === 'embed-access-code-required') {
      return (
        <DocumentSigningAccess2FAGate
          documentAuthOptions={error.data.documentAuthOptions}
          recipient={error.data.recipient}
        />
      );
    }

    if (error.status === 403 && error.data.type === 'embed-paywall') {
      return <EmbedPaywall />;
    }

    if (error.status === 403 && error.data.type === 'embed-waiting-for-turn') {
      return <EmbedDocumentWaitingForTurn />;
    }

    if (error.status === 403 && error.data.type === 'embed-recipient-expired') {
      return <EmbedRecipientExpired />;
    }

    // !: Not used at the moment, may be removed in the future.
    if (error.status === 403 && error.data.type === 'embed-document-rejected') {
      return <EmbedDocumentRejected />;
    }

    // !: Not used at the moment, may be removed in the future.
    if (error.status === 403 && error.data.type === 'embed-document-completed') {
      return <EmbedDocumentCompleted name={error.data.name} signature={error.data.signature} />;
    }
  }

  return (
    <div>
      <Trans>Not Found</Trans>
    </div>
  );
}
