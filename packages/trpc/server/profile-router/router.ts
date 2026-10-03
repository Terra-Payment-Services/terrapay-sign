import type { SetAvatarImageOptions } from '@documenso/lib/server-only/profile/set-avatar-image';
import { setAvatarImage } from '@documenso/lib/server-only/profile/set-avatar-image';
import { deleteUser } from '@documenso/lib/server-only/user/delete-user';
import { findUserSecurityAuditLogs } from '@documenso/lib/server-only/user/find-user-security-audit-logs';
import { updateProfile } from '@documenso/lib/server-only/user/update-profile';

import { authenticatedProcedure, router } from '../trpc';
import {
  ZFindUserSecurityAuditLogsSchema,
  ZSetProfileImageMutationSchema,
  ZUpdateProfileMutationSchema,
} from './schema';

export const profileRouter = router({
  findUserSecurityAuditLogs: authenticatedProcedure
    .input(ZFindUserSecurityAuditLogsSchema)
    .query(async ({ input, ctx }) => {
      return await findUserSecurityAuditLogs({
        userId: ctx.user.id,
        ...input,
      });
    }),

  updateProfile: authenticatedProcedure.input(ZUpdateProfileMutationSchema).mutation(async ({ input, ctx }) => {
    const { name, signature } = input;

    await updateProfile({
      userId: ctx.user.id,
      name,
      signature,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  }),

  deleteAccount: authenticatedProcedure.mutation(async ({ ctx }) => {
    ctx.logger.info({
      input: {
        userId: ctx.user.id,
      },
    });

    await deleteUser({
      id: ctx.user.id,
    });
  }),

  setProfileImage: authenticatedProcedure.input(ZSetProfileImageMutationSchema).mutation(async ({ input, ctx }) => {
    const { bytes, teamId, organisationId } = input;

    ctx.logger.info({
      input: {
        teamId,
        organisationId,
      },
    });

    let target: SetAvatarImageOptions['target'] = {
      type: 'user',
    };

    if (teamId) {
      target = {
        type: 'team',
        teamId,
      };
    }

    if (organisationId) {
      target = {
        type: 'organisation',
        organisationId,
      };
    }

    return await setAvatarImage({
      userId: ctx.user.id,
      target,
      bytes,
      requestMetadata: ctx.metadata,
    });
  }),
});
