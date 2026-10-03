/**
 * Paths whose state-changing requests come from machines that authenticate
 * some other way, so the same-origin check does not apply to them:
 *
 * - /api/v1: the public API, authenticated only by an API token.
 * - /api/jobs: the background job handler, called by the job provider.
 * - /api/webhook/trigger: inbound webhook calls, authenticated by a secret.
 * - /api/upstream-watch/heartbeat: the watcher heartbeat, a bearer secret.
 */
const CSRF_EXEMPT_PATH_PREFIXES = ['/api/v1/', '/api/jobs/', '/api/webhook/trigger', '/api/upstream-watch/heartbeat'];

/**
 * The v2 API takes an API token, and falls back to the session cookie when no
 * Authorization header is sent. Only the token calls are exempt.
 */
const TOKEN_API_PATH_PREFIXES = ['/api/v2/', '/api/v2-beta/'];

/**
 * Whether a request to `path` (relative to the app's base path) is exempt from
 * the same-origin check.
 */
export const isCsrfExemptRequest = ({
  path,
  hasAuthorizationHeader,
}: {
  path: string;
  hasAuthorizationHeader: boolean;
}): boolean => {
  if (CSRF_EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }

  return hasAuthorizationHeader && TOKEN_API_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
};
