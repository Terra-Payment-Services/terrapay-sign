import { SUPPORT_EMAIL } from '@documenso/lib/constants/app';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { HelpCircleIcon, MailIcon } from 'lucide-react';

import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Support`);
}

export default function SupportPage() {
  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 md:px-8">
      <div className="mb-8">
        <h1 className="flex flex-row items-center gap-2 font-bold text-3xl">
          <HelpCircleIcon className="h-8 w-8 text-muted-foreground" />
          <Trans>Support</Trans>
        </h1>

        <div className="mt-6 rounded-lg border p-4">
          <h2 className="flex items-center gap-2 font-bold text-lg">
            <MailIcon className="h-5 w-5 text-muted-foreground" />
            <Trans>Contact IT support</Trans>
          </h2>
          <p className="mt-1 text-muted-foreground">
            <Trans>
              For help with TerraPay Sign, email{' '}
              <a className="text-primary underline" href={`mailto:${SUPPORT_EMAIL}`}>
                {SUPPORT_EMAIL}
              </a>
              .
            </Trans>
          </p>
        </div>
      </div>
    </div>
  );
}
