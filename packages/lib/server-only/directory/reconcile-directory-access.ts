import type { Role } from '@prisma/client';

import { isAdmin } from '../../utils/is-admin';
import type { EntraDirectoryMember } from './entra-graph';

/**
 * Core of the Entra ID access reconciliation.
 *
 * Every dependency is injected so the decision logic can be exercised without a
 * directory, a database or a job runtime. The job handler supplies the real
 * implementations.
 *
 * The rules this enforces, in order of how much damage getting them wrong would
 * do:
 *
 *  1. It disables accounts. It never deletes one, and it never re-enables one.
 *     A re-enable is a decision for a human, because the reason an account was
 *     disabled is not recorded anywhere this job can read.
 *  2. It never disables an administrator, so a directory or configuration
 *     mistake cannot lock everybody out of the admin surface.
 *  3. It refuses to act at all when the directory answer looks wrong, rather
 *     than acting on a partial answer.
 */

export type ReconcilableUser = {
  id: number;
  email: string;
  name: string | null;
  roles: Role[];
  disabled: boolean;
};

export type ReconcileDirectoryAccessConfig = {
  /**
   * When true, decide everything and log it, but change nothing.
   */
  dryRun: boolean;

  /**
   * Abort the run if the directory returns fewer than this many members. A
   * misconfigured group id, a revoked permission or a half-failed API call all
   * present as a small or empty membership, which would otherwise read as
   * "almost nobody works here any more".
   */
  minimumMemberCount: number;

  /**
   * Abort the run if it would disable more than this proportion of the accounts
   * it considered, expressed as a fraction between 0 and 1.
   */
  maximumDisableRatio: number;
};

export type ReconcileDirectoryAccessLogger = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type ReconcileDirectoryAccessOptions = {
  config: ReconcileDirectoryAccessConfig;
  logger: ReconcileDirectoryAccessLogger;

  /**
   * Read the full set of directory members who may hold access: the
   * transitive membership of the access group, or every member user in the
   * tenant. Throwing aborts the run.
   */
  getDirectoryMembers: () => Promise<EntraDirectoryMember[]>;

  /**
   * Read the Documenso accounts eligible for reconciliation.
   */
  getReconcilableUsers: () => Promise<ReconcilableUser[]>;

  /**
   * Disable a single Documenso account.
   */
  disableUserAccount: (options: { id: number }) => Promise<void>;
};

export type ReconcileDirectoryAccessAbortReason = 'membership-below-floor' | 'disable-ratio-exceeded';

export type ReconcileDirectoryAccessResult = {
  outcome: 'completed' | 'aborted';
  abortReason?: ReconcileDirectoryAccessAbortReason;
  dryRun: boolean;
  directoryMemberCount: number;
  entitledEmailCount: number;
  consideredUserCount: number;
  skippedAdminCount: number;
  candidateUserIds: number[];
  disabledUserIds: number[];
  failedUserIds: number[];
};

const normaliseEmail = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();

  return trimmed ? trimmed : null;
};

/**
 * Build the set of email addresses that still confer access.
 *
 * Both `mail` and `userPrincipalName` are collected because a tenant may hold a
 * person's routable address in either, and Documenso may have been seeded from
 * either. A member who is in the group but disabled in Entra contributes
 * nothing: being disabled upstream is exactly the offboarding signal this job
 * exists to act on.
 */
const buildEntitledEmailSet = (members: EntraDirectoryMember[]): Set<string> => {
  const entitled = new Set<string>();

  for (const member of members) {
    if (!member.accountEnabled) {
      continue;
    }

    const mail = normaliseEmail(member.mail);
    const userPrincipalName = normaliseEmail(member.userPrincipalName);

    if (mail) {
      entitled.add(mail);
    }

    if (userPrincipalName) {
      entitled.add(userPrincipalName);
    }
  }

  return entitled;
};

export const reconcileDirectoryAccess = async ({
  config,
  logger,
  getDirectoryMembers,
  getReconcilableUsers,
  disableUserAccount,
}: ReconcileDirectoryAccessOptions): Promise<ReconcileDirectoryAccessResult> => {
  logger.info(
    `[entra-reconcile] Starting run (dryRun: ${config.dryRun}, minimumMemberCount: ${config.minimumMemberCount}, ` +
      `maximumDisableRatio: ${config.maximumDisableRatio})`,
  );

  let members: EntraDirectoryMember[];

  try {
    members = await getDirectoryMembers();
  } catch (error) {
    // An unreadable directory is not evidence that anybody has left. Abort and
    // let the job runtime record the failure.
    logger.error(
      `[entra-reconcile] Aborting run: the Microsoft Graph membership read failed. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    throw error;
  }

  const entitledEmails = buildEntitledEmailSet(members);

  if (members.length < config.minimumMemberCount) {
    logger.error(
      `[entra-reconcile] Aborting run: the directory returned ${members.length} members, below the configured ` +
        `floor of ${config.minimumMemberCount}. No account was disabled. This usually means the group id is wrong, ` +
        'the application permission was revoked, or the directory read was partial.',
    );

    return {
      outcome: 'aborted',
      abortReason: 'membership-below-floor',
      dryRun: config.dryRun,
      directoryMemberCount: members.length,
      entitledEmailCount: entitledEmails.size,
      consideredUserCount: 0,
      skippedAdminCount: 0,
      candidateUserIds: [],
      disabledUserIds: [],
      failedUserIds: [],
    };
  }

  const users = await getReconcilableUsers();

  // Administrators are excluded here as well as in the query that feeds this
  // function. The duplication is deliberate: this is the guard that survives
  // somebody later changing the query.
  const admins = users.filter((user) => isAdmin(user));

  const consideredUsers = users.filter((user) => !user.disabled && !isAdmin(user));

  // Accounts are matched to the directory by email address rather than by the
  // Entra object id, because the Documenso `User` table has no column to hold
  // an external identity and adding one is a schema change beyond the scope of
  // this job. Storing the object id would survive a mailbox rename, which email
  // matching does not; a rename here presents as a departure and gets the
  // account disabled until a human re-enables it. That is the safe direction of
  // failure, but it is still worth fixing.
  //
  // Follow-up: add an `externalDirectoryId` column to `User`, populate it on
  // OIDC sign-in from the `oid` claim, and prefer it over email here.
  const candidates = consideredUsers.filter((user) => {
    const email = normaliseEmail(user.email);

    return !email || !entitledEmails.has(email);
  });

  logger.info(
    `[entra-reconcile] Directory returned ${members.length} members (${entitledEmails.size} entitled email ` +
      `addresses). Considered ${consideredUsers.length} enabled non-admin accounts, skipped ${admins.length} ` +
      `admin accounts, matched ${consideredUsers.length - candidates.length}, found ${candidates.length} without ` +
      'directory access.',
  );

  const disableRatio = consideredUsers.length === 0 ? 0 : candidates.length / consideredUsers.length;

  if (candidates.length > 0 && disableRatio > config.maximumDisableRatio) {
    logger.error(
      `[entra-reconcile] Aborting run: this run would disable ${candidates.length} of ${consideredUsers.length} ` +
        `considered accounts (${(disableRatio * 100).toFixed(1)}%), above the configured maximum of ` +
        `${(config.maximumDisableRatio * 100).toFixed(1)}%. No account was disabled. Candidate account ids: ` +
        `${candidates.map((user) => user.id).join(', ')}.`,
    );

    return {
      outcome: 'aborted',
      abortReason: 'disable-ratio-exceeded',
      dryRun: config.dryRun,
      directoryMemberCount: members.length,
      entitledEmailCount: entitledEmails.size,
      consideredUserCount: consideredUsers.length,
      skippedAdminCount: admins.length,
      candidateUserIds: candidates.map((user) => user.id),
      disabledUserIds: [],
      failedUserIds: [],
    };
  }

  const disabledUserIds: number[] = [];
  const failedUserIds: number[] = [];

  for (const user of candidates) {
    if (config.dryRun) {
      logger.info(
        `[entra-reconcile] Dry run: would disable account ${user.id} (${user.email}), which is absent from the ` +
          'directory or disabled in it. No change made.',
      );

      continue;
    }

    try {
      await disableUserAccount({ id: user.id });

      disabledUserIds.push(user.id);

      logger.info(
        `[entra-reconcile] Disabled account ${user.id} (${user.email}), absent from the directory or disabled ` +
          'in it.',
      );
    } catch (error) {
      failedUserIds.push(user.id);

      // One account failing to disable is not a reason to abandon the rest, but
      // it must be visible, so it is logged individually and counted.
      logger.error(
        `[entra-reconcile] Failed to disable account ${user.id} (${user.email}). ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  logger.info(
    `[entra-reconcile] Run complete (dryRun: ${config.dryRun}). Candidates: ${candidates.length}, disabled: ` +
      `${disabledUserIds.length}, failed: ${failedUserIds.length}.`,
  );

  return {
    outcome: 'completed',
    dryRun: config.dryRun,
    directoryMemberCount: members.length,
    entitledEmailCount: entitledEmails.size,
    consideredUserCount: consideredUsers.length,
    skippedAdminCount: admins.length,
    candidateUserIds: candidates.map((user) => user.id),
    disabledUserIds,
    failedUserIds,
  };
};
