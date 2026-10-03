/**
 * Path segments that are themselves a credential, and the routes they follow.
 *
 * A recipient's signing link is `/sign/<token>`, and whoever holds that token
 * can sign as them. The request logger used to record every path verbatim, so
 * the log carried a working credential for each signing page served. The same
 * holds for direct template links, the audit report, the embed signing pages,
 * the file routes that take a recipient token, and the email verification,
 * password reset and invitation links.
 *
 * Each pattern names the route prefix and captures the segment after it, so
 * `.data` suffixes that React Router adds to loader requests are covered too.
 */
const TOKEN_PATH_PATTERNS: RegExp[] = [
  /^(\/embed\/(?:sign|direct)\/)[^/]+/,
  /^(\/(?:sign|d|report)\/)[^/]+/,
  /^(\/api\/files\/token\/)[^/]+/,
  /^(\/(?:verify-email|reset-password)\/)[^/]+/,
  /^(\/organisation\/(?:invite|decline)\/)[^/]+/,
  /^(\/team\/verify\/email\/)[^/]+/,
];

export const REDACTED_PATH_SEGMENT = '[redacted]';

/**
 * Replace a credential carried in a request path with a placeholder, keeping
 * the rest of the path so the log still says which route was hit.
 *
 * @param path - A request path without its query string, as `c.req.path` gives it.
 * @returns The path with any token segment replaced.
 */
export const redactPathTokens = (path: string): string => {
  for (const pattern of TOKEN_PATH_PATTERNS) {
    if (pattern.test(path)) {
      return path.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED_PATH_SEGMENT}`);
    }
  }

  return path;
};
