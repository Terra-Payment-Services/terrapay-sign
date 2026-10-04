import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { IS_MICROSOFT_SSO_ENABLED, isPasskeyEnabled, isSigninEnabledForProvider } from '@documenso/lib/constants/auth';
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
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
  const isMicrosoftSSOEnabled = IS_MICROSOFT_SSO_ENABLED && isSigninEnabledForProvider('microsoft');
  const isPasskeySigninEnabled = isPasskeyEnabled();

  let returnTo = new URL(request.url).searchParams.get('returnTo') ?? undefined;

  returnTo = isValidReturnTo(returnTo) ? normalizeReturnTo(returnTo) : undefined;

  if (isAuthenticated) {
    throw redirect(returnTo || '/');
  }

  return {
    isEmailPasswordSigninEnabled,
    isMicrosoftSSOEnabled,
    isPasskeySigninEnabled,
    returnTo,
  };
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const { isEmailPasswordSigninEnabled, isMicrosoftSSOEnabled, isPasskeySigninEnabled, returnTo } = loaderData;

  const { _ } = useLingui();

  const [searchParams] = useSearchParams();

  const errorParam = searchParams.get('error');
  const signupError = errorParam ? SIGNUP_ERROR_MESSAGES[errorParam] : undefined;

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
          isMicrosoftSSOEnabled={isMicrosoftSSOEnabled}
          isPasskeySigninEnabled={isPasskeySigninEnabled}
          returnTo={returnTo}
        />
      </div>
    </div>
  );
}
