import {
  ENTRA_RECONCILE_DRY_RUN,
  ENTRA_RECONCILE_MAX_DISABLE_RATIO,
  ENTRA_RECONCILE_MINIMUM_MEMBERS,
  NEXT_PRIVATE_ENTRA_CLIENT_ID,
  NEXT_PRIVATE_ENTRA_CLIENT_SECRET,
  NEXT_PRIVATE_ENTRA_TENANT_ID,
} from '../../constants/app';
import { env } from '../../utils/env';

/**
 * Refuse to start a production server on which the directory reconcile would not act.
 *
 * Sign-in through Entra stops a leaver opening a new session, but a session they already hold
 * lasts until it expires or the hourly reconcile disables the account. Each condition below
 * turns that reconcile into a job that runs and changes nothing, which looks healthy and is
 * not: cron only fires under BullMQ, the handler skips a run without the Entra credentials,
 * dry run disables nobody, and the default minimum of ten members would accept a directory
 * read that came back nearly empty.
 *
 * The thresholds are read through the same parsers the job uses, so a value the job would
 * refuse at run time stops the server here instead.
 */
export const assertDirectoryReconcileIsLive = () => {
  if (env('NODE_ENV') !== 'production') {
    return;
  }

  // These point the job's token request, which carries the client secret, and its Graph reads
  // somewhere other than Microsoft. Production ignores them, and refuses to start with them set
  // whatever NOT_REQUIRED says, so a stray test setting cannot reach a deployment unnoticed. Present
  // means defined: an empty value is refused too.
  const baseUrlOverrides = ['NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL', 'NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL'].filter(
    (variable) => env(variable) !== undefined,
  );

  if (baseUrlOverrides.length > 0) {
    throw new Error(
      `Refusing to start: ${baseUrlOverrides.join(' and ')} must not be set in production, where the directory ` +
        'reconcile talks only to Microsoft.',
    );
  }

  // `npm run start` sets NODE_ENV to production for CI's end-to-end run and the image smoke
  // test too, so those say outright that they are not a deployment. The task definition never
  // sets this.
  if (env('NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED') === 'true') {
    return;
  }

  const problems: string[] = [];

  if (env('NEXT_PRIVATE_JOBS_PROVIDER') !== 'bullmq') {
    problems.push('NEXT_PRIVATE_JOBS_PROVIDER must be "bullmq", since cron runs under no other provider');
  }

  if (!NEXT_PRIVATE_ENTRA_TENANT_ID() || !NEXT_PRIVATE_ENTRA_CLIENT_ID() || !NEXT_PRIVATE_ENTRA_CLIENT_SECRET()) {
    problems.push(
      'NEXT_PRIVATE_ENTRA_TENANT_ID, NEXT_PRIVATE_ENTRA_CLIENT_ID and NEXT_PRIVATE_ENTRA_CLIENT_SECRET must all be set',
    );
  }

  if (ENTRA_RECONCILE_DRY_RUN()) {
    problems.push('NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN must be "false"');
  }

  if (!env('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS')?.trim()) {
    problems.push('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS must be set to a figure near the directory size');
  }

  for (const parse of [ENTRA_RECONCILE_MINIMUM_MEMBERS, ENTRA_RECONCILE_MAX_DISABLE_RATIO]) {
    try {
      parse();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to start: the directory reconcile would not disable leavers. ${problems.join('; ')}.`);
  }
};
