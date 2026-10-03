import { prisma } from '@documenso/prisma';
import { Role } from '@prisma/client';

import {
  ENTRA_RECONCILE_DRY_RUN,
  ENTRA_RECONCILE_MAX_DISABLE_RATIO,
  ENTRA_RECONCILE_MINIMUM_MEMBERS,
  NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_SECRET,
  NEXT_PRIVATE_ENTRA_TENANT_ID,
} from '../../../constants/app';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import { fetchEntraGroupMembers, fetchEntraTenantUsers } from '../../../server-only/directory/entra-graph';
import { reconcileDirectoryAccess } from '../../../server-only/directory/reconcile-directory-access';
import { disableUser } from '../../../server-only/user/disable-user';
import type { JobRunIO } from '../../client/_internal/job';
import type { TReconcileDirectoryAccessJobDefinition } from './reconcile-directory-access';

export const run = async ({ io }: { payload: TReconcileDirectoryAccessJobDefinition; io: JobRunIO }) => {
  const tenantId = NEXT_PRIVATE_ENTRA_TENANT_ID();
  const clientId = NEXT_PRIVATE_ENTRA_CLIENT_ID();
  const clientSecret = NEXT_PRIVATE_ENTRA_CLIENT_SECRET();
  const groupId = NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID();

  if (!tenantId || !clientId || !clientSecret) {
    io.logger.info(
      '[entra-reconcile] Skipping run: the Entra directory reconciliation is not configured. Set ' +
        'NEXT_PRIVATE_ENTRA_TENANT_ID, NEXT_PRIVATE_ENTRA_CLIENT_ID and NEXT_PRIVATE_ENTRA_CLIENT_SECRET to ' +
        'enable it. NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID is optional and narrows access to one group.',
    );

    return;
  }

  const credentials = { tenantId, clientId, clientSecret };

  // A configured group takes precedence. Without one, every enabled member
  // account in the tenant confers access.
  io.logger.info(
    groupId
      ? `[entra-reconcile] Reconciling against the transitive membership of group ${groupId}.`
      : '[entra-reconcile] Reconciling against every enabled member user in the tenant.',
  );

  const result = await reconcileDirectoryAccess({
    config: {
      dryRun: ENTRA_RECONCILE_DRY_RUN(),
      minimumMemberCount: ENTRA_RECONCILE_MINIMUM_MEMBERS(),
      maximumDisableRatio: ENTRA_RECONCILE_MAX_DISABLE_RATIO(),
    },
    logger: io.logger,
    getDirectoryMembers: async () =>
      groupId ? await fetchEntraGroupMembers({ groupId, credentials }) : await fetchEntraTenantUsers({ credentials }),
    getReconcilableUsers: async () =>
      await prisma.user.findMany({
        where: {
          disabled: false,
          NOT: {
            roles: {
              has: Role.ADMIN,
            },
          },
        },
        select: {
          id: true,
          email: true,
          name: true,
          roles: true,
          disabled: true,
        },
      }),
    disableUserAccount: async ({ id }) => await disableUser({ id }),
  });

  if (result.outcome === 'aborted') {
    // The abort has already been logged with its numbers. Throwing surfaces it
    // as a failed job in Bull Board rather than letting a safety stop pass for
    // a clean run. A retry re-reads the directory and aborts again at no cost,
    // since an aborted run changes nothing.
    throw new AppError(AppErrorCode.LIMIT_EXCEEDED, {
      message: `Entra directory reconciliation aborted on a safety guard: ${result.abortReason}`,
    });
  }

  if (result.failedUserIds.length > 0) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: `Entra directory reconciliation failed to disable ${result.failedUserIds.length} account(s): ${result.failedUserIds.join(', ')}`,
    });
  }
};
