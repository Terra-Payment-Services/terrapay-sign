import { IS_MICROSOFT_SSO_ENABLED, isSignupEnabledForProvider } from '@documenso/lib/constants/auth';
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { msg } from '@lingui/core/macro';
import { redirect } from 'react-router';

import { SignUpForm } from '~/components/forms/signup';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/signup';

export function meta() {
  return appMetaTags(msg`Sign Up`);
}

export function loader({ request }: Route.LoaderArgs) {
  const isEmailPasswordSignupEnabled = isSignupEnabledForProvider('email');
  const isMicrosoftSignupEnabled = IS_MICROSOFT_SSO_ENABLED && isSignupEnabledForProvider('microsoft');

  const isAnySignupEnabled = isEmailPasswordSignupEnabled || isMicrosoftSignupEnabled;

  if (!isAnySignupEnabled) {
    throw redirect('/signin');
  }

  let returnTo = new URL(request.url).searchParams.get('returnTo') ?? undefined;

  returnTo = isValidReturnTo(returnTo) ? normalizeReturnTo(returnTo) : undefined;

  return {
    isEmailPasswordSignupEnabled,
    isMicrosoftSignupEnabled,
    returnTo,
  };
}

export default function SignUp({ loaderData }: Route.ComponentProps) {
  const { isEmailPasswordSignupEnabled, isMicrosoftSignupEnabled, returnTo } = loaderData;

  return (
    <SignUpForm
      className="w-screen max-w-screen-2xl px-4 md:px-16 lg:-my-16"
      isEmailPasswordSignupEnabled={isEmailPasswordSignupEnabled}
      isMicrosoftSignupEnabled={isMicrosoftSignupEnabled}
      returnTo={returnTo}
    />
  );
}
