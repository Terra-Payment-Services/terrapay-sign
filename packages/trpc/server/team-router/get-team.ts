import { getTeam } from '@documenso/lib/server-only/team/get-team';
import { canExecuteTeamAction } from '@documenso/lib/utils/teams';

import { authenticatedProcedure } from '../trpc';
import { ZGetTeamRequestSchema, ZGetTeamResponseSchema } from './get-team.types';

export const getTeamRoute = authenticatedProcedure
  //   .meta(getTeamMeta)
  .input(ZGetTeamRequestSchema)
  .output(ZGetTeamResponseSchema)
  .query(async ({ input, ctx }) => {
    const { teamReference } = input;

    ctx.logger.info({
      input: {
        teamReference,
      },
    });

    const team = await getTeam({
      teamReference,
      userId: ctx.user.id,
    });

    // Only those who can manage the team see its settings and the organisation's settings derived into them (#164).
    if (!canExecuteTeamAction('MANAGE_TEAM', team.currentTeamRole)) {
      return { ...team, teamSettings: null, derivedSettings: null };
    }

    return team;
  });
