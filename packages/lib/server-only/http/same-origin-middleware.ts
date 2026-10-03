import type { Context } from 'hono';
import type { MiddlewareHandler } from 'hono/types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a state-changing request was sent from a page on another origin.
 *
 * Browsers attach Origin to every cross-origin request that is not a GET or
 * HEAD, so a mismatched Origin is decisive. Referer is the fallback for the
 * rare request that arrives without one. A request carrying neither did not
 * come from a page in a browser, so it cannot be riding a visitor's session
 * cookie, and it is let through.
 */
export const isCrossOriginUnsafeRequest = (req: Request, allowedOrigin: string): boolean => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return false;
  }

  const origin = req.headers.get('origin');

  if (origin !== null) {
    return origin !== allowedOrigin;
  }

  const referer = req.headers.get('referer');

  if (!referer) {
    return false;
  }

  try {
    return new URL(referer).origin !== allowedOrigin;
  } catch {
    return true;
  }
};

/**
 * Reject state-changing requests from other origins. This is the CSRF guard
 * for routes authenticated by the session cookie, which is sent on
 * cross-site requests because it is SameSite=None.
 *
 * Routes that other sites are meant to call, such as the token-authenticated
 * public API, must be passed through `isExempt`.
 */
export const createSameOriginMiddleware = (
  getAllowedOrigin: () => string,
  options?: { isExempt?: (c: Context) => boolean },
): MiddlewareHandler => {
  return async (c, next) => {
    if (options?.isExempt?.(c)) {
      await next();

      return;
    }

    if (isCrossOriginUnsafeRequest(c.req.raw, new URL(getAllowedOrigin()).origin)) {
      return c.json({ message: 'Forbidden', statusCode: 403 }, 403);
    }

    await next();
  };
};
