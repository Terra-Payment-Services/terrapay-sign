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

  /**
   * Entra object ids of the directory users this account has signed in as,
   * read from its stored Microsoft ID tokens by `readDirectoryObjectId`. Empty
   * for an account that has never signed in with Microsoft.
   */
  directoryObjectIds: string[];
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

  /**
   * Addresses never disabled, compared without regard to case: service and
   * shared accounts that are not people in the directory.
   */
  exemptEmails: string[];
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
  exemptUserCount: number;
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

/**
 * Reduce an Entra GUID, an object id or a tenant id, to the form it is compared
 * in. GUIDs are case-insensitive and may be written with surrounding braces and
 * whitespace, so ` {6F1C...} ` and `6f1c...` are the same. Returns null for an
 * empty id, which identifies nothing.
 */
const normaliseObjectId = (value: string): string | null => {
  const id = value
    .trim()
    .replace(/^\{(.*)\}$/, '$1')
    .trim()
    .toLowerCase();

  return id ? id : null;
};

/**
 * Read the Entra object id (`oid`) from a Microsoft ID token stored on an
 * `Account` row, or null when the token cannot vouch for one.
 *
 * The account's `providerAccountId` cannot serve, because it holds `sub`, which
 * Entra issues pairwise per application and which therefore never equals the
 * Graph `id`. `oid` does, and it survives a rename of the mailbox or the user
 * principal name.
 *
 * The signature is not checked here, for the reason `readIssuerFromIdToken`
 * gives: the token was verified against the authority's keys when the row was
 * written, and those keys have rotated since. An object id is accepted only from
 * a token whose `tid` is the tenant being reconciled, so a token from any other
 * directory leaves the account to the email match.
 */
export const readDirectoryObjectId = (idToken: string | null | undefined, tenantId: string): string | null => {
  const segments = typeof idToken === 'string' ? idToken.split('.') : [];

  if (segments.length !== 3) {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const { oid, tid } = payload as Record<string, unknown>;

  // Tenant ids are GUIDs too, so both sides are normalised the same way.
  if (
    typeof oid !== 'string' ||
    oid.trim().length === 0 ||
    typeof tid !== 'string' ||
    normaliseObjectId(tid) === null ||
    normaliseObjectId(tid) !== normaliseObjectId(tenantId)
  ) {
    return null;
  }

  return oid;
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

  const enabledMembers = members.filter((member) => member.accountEnabled);

  const entitledObjectIds = new Set(
    enabledMembers.map((member) => normaliseObjectId(member.id)).filter((id): id is string => id !== null),
  );

  // Only enabled members count toward the floor, each once however many rows
  // Graph returned for them. A directory that lost its people but kept their
  // disabled accounts is exactly the answer the floor exists to refuse.
  if (entitledObjectIds.size < config.minimumMemberCount) {
    logger.error(
      `[entra-reconcile] Aborting run: counting distinct enabled users only, the directory returned ${entitledObjectIds.size} ` +
        `members, below the configured floor of ${config.minimumMemberCount}. No account was disabled. This usually means the group id is wrong, ` +
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
      exemptUserCount: 0,
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

  const exemptEmails = new Set(config.exemptEmails.map((email) => normaliseEmail(email)));

  const isExempt = (user: ReconcilableUser) => {
    const email = normaliseEmail(user.email);

    return email !== null && exemptEmails.has(email);
  };

  const exemptUsers = users.filter((user) => !isAdmin(user) && isExempt(user));

  const consideredUsers = users.filter((user) => !user.disabled && !isAdmin(user) && !isExempt(user));

  // An account with an Entra object id is matched on that alone, which
  // survives a rename. Its email address is not consulted, because an address
  // can be reassigned: a leaver whose old address now belongs to somebody else
  // would otherwise keep their account, and their API tokens, indefinitely.
  // Only an account that has never signed in with Microsoft falls back to its
  // email address.
  //
  // The cost is a person deleted and recreated in Entra: the new object id is
  // one their account has never seen, so it is disabled until somebody
  // re-enables it. That is the safe direction of failure.
  const candidates = consideredUsers.filter((user) => {
    if (user.directoryObjectIds.length > 0) {
      return !user.directoryObjectIds.some((id) => {
        const normalised = normaliseObjectId(id);

        return normalised !== null && entitledObjectIds.has(normalised);
      });
    }

    const email = normaliseEmail(user.email);

    return !email || !entitledEmails.has(email);
  });

  logger.info(
    `[entra-reconcile] Directory returned ${members.length} members (${entitledEmails.size} entitled email ` +
      `addresses). Considered ${consideredUsers.length} enabled non-admin accounts, skipped ${admins.length} ` +
      `admin accounts and ${exemptUsers.length} exempt accounts, matched ${consideredUsers.length - candidates.length}, found ${candidates.length} without ` +
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
      exemptUserCount: exemptUsers.length,
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
    exemptUserCount: exemptUsers.length,
    candidateUserIds: candidates.map((user) => user.id),
    disabledUserIds,
    failedUserIds,
  };
};
