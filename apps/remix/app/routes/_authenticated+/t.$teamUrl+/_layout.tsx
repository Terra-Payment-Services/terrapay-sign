import { useChildRouteFlags } from '@documenso/lib/client-only/hooks/use-child-route-flags';
import { TrpcProvider } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Link, Outlet } from 'react-router';

import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import { useOptionalCurrentTeam } from '~/providers/team';

export default function Layout() {
  const team = useOptionalCurrentTeam();

  const { layoutMode } = useChildRouteFlags();

  if (!team) {
    return (
      <GenericErrorLayout
        errorCode={404}
        errorCodeMap={{
          404: {
            heading: msg`Team not found`,
            subHeading: msg`404 Team not found`,
            message: msg`The team you are looking for may have been removed, renamed or may have never existed.`,
          },
        }}
        primaryButton={
          <Button asChild>
            <Link to="/settings/teams">
              <Trans>View teams</Trans>
            </Link>
          </Button>
        }
      ></GenericErrorLayout>
    );
  }

  const trpcHeaders = {
    'x-team-Id': team.id.toString(),
  };

  // Note: We use a key to force a re-render if the team context changes.
  // This is required otherwise you would see the wrong page content.
  return (
    <div key={team.url} className={cn({ 'md:flex md:min-h-0 md:flex-1 md:flex-col': layoutMode === 'settings' })}>
      <TrpcProvider headers={trpcHeaders}>
        <Outlet />
      </TrpcProvider>
    </div>
  );
}
