import { authClient } from '@documenso/auth/client';
import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import {
  IS_GOOGLE_SSO_ENABLED,
  IS_MICROSOFT_SSO_ENABLED,
  IS_OIDC_AUTO_REDIRECT_DISABLED,
  IS_OIDC_SSO_ENABLED,
  isPasskeyEnabled,
  isSigninEnabledForProvider,
  OIDC_PROVIDER_LABEL,
} from '@documenso/lib/constants/auth';
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Loader2Icon } from 'lucide-react';
import { useEffect } from 'react';
import { redirect, useSearchParams } from 'react-router';

import { SignInForm } from '~/components/forms/signin';
import { SIGNUP_ERROR_MESSAGES } from '~/components/forms/signup';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/signin';

export function meta() {
  return appMetaTags(msg`Sign In`);
}

export async function loader({ request }: Route.LoaderArgs) {
  const { isAuthenticated } = await getOptionalSession(request);

  // SSR env variables.
  const isEmailPasswordSigninEnabled = isSigninEnabledForProvider('email');
  const isGoogleSSOEnabled = IS_GOOGLE_SSO_ENABLED && isSigninEnabledForProvider('google');
  const isMicrosoftSSOEnabled = IS_MICROSOFT_SSO_ENABLED && isSigninEnabledForProvider('microsoft');
  const isOIDCSSOEnabled = IS_OIDC_SSO_ENABLED && isSigninEnabledForProvider('oidc');
  const isPasskeySigninEnabled = isPasskeyEnabled();

  // Automatically redirect to OIDC when it is the only enabled signin transport,
  // unless the redirect has been explicitly disabled via env.
  const isOIDCOnlyTransport =
    isOIDCSSOEnabled && !isEmailPasswordSigninEnabled && !isGoogleSSOEnabled && !isMicrosoftSSOEnabled;

  const shouldAutoRedirectToOIDC = isOIDCOnlyTransport && !IS_OIDC_AUTO_REDIRECT_DISABLED;

  const oidcProviderLabel = OIDC_PROVIDER_LABEL;

  let returnTo = new URL(request.url).searchParams.get('returnTo') ?? undefined;

  returnTo = isValidReturnTo(returnTo) ? normalizeReturnTo(returnTo) : undefined;

  if (isAuthenticated) {
    throw redirect(returnTo || '/');
  }

  return {
    isEmailPasswordSigninEnabled,
    isGoogleSSOEnabled,
    isMicrosoftSSOEnabled,
    isOIDCSSOEnabled,
    isPasskeySigninEnabled,
    oidcProviderLabel,
    returnTo,
    shouldAutoRedirectToOIDC,
  };
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const {
    isEmailPasswordSigninEnabled,
    isGoogleSSOEnabled,
    isMicrosoftSSOEnabled,
    isOIDCSSOEnabled,
    isPasskeySigninEnabled,
    oidcProviderLabel,
    returnTo,
    shouldAutoRedirectToOIDC,
  } = loaderData;

  const { _ } = useLingui();

  const [searchParams] = useSearchParams();

  const errorParam = searchParams.get('error');
  const signupError = errorParam ? SIGNUP_ERROR_MESSAGES[errorParam] : undefined;

  useEffect(() => {
    if (!shouldAutoRedirectToOIDC) {
      return;
    }

    void authClient.oidc.signIn({ redirectPath: returnTo ?? '/' });
  }, [shouldAutoRedirectToOIDC, returnTo]);

  if (shouldAutoRedirectToOIDC) {
    return (
      <div className="w-screen max-w-lg px-4">
        <div className="flex flex-col items-center justify-center gap-y-4 py-12">
          <Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground text-sm">
            <Trans>Redirecting to {oidcProviderLabel || 'OIDC'}...</Trans>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen max-w-lg px-4">
      <div className="z-10 rounded-lg bg-card p-6 shadow-elevation-card dark:border dark:border-border">
        {signupError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{_(signupError)}</AlertDescription>
          </Alert>
        )}

        <h1 className="font-semibold text-2xl">
          <Trans>Sign in to your account</Trans>
        </h1>

        <p className="mt-2 text-muted-foreground text-sm">
          <Trans>Sign in with your TerraPay account.</Trans>
        </p>
        <hr className="-mx-6 my-4" />

        <SignInForm
          isEmailPasswordSigninEnabled={isEmailPasswordSigninEnabled}
          isGoogleSSOEnabled={isGoogleSSOEnabled}
          isMicrosoftSSOEnabled={isMicrosoftSSOEnabled}
          isOIDCSSOEnabled={isOIDCSSOEnabled}
          isPasskeySigninEnabled={isPasskeySigninEnabled}
          oidcProviderLabel={oidcProviderLabel}
          returnTo={returnTo}
        />
      </div>
    </div>
  );
}
