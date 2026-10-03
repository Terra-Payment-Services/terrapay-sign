import { env } from '../utils/env';

const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/**
 * The number of proxies in front of the app that append to X-Forwarded-For,
 * read from NEXT_PRIVATE_TRUSTED_PROXY_HOPS. Anything that is not a positive
 * integer falls back to the default of one, which is a single load balancer.
 */
export const getTrustedProxyHops = (): number => {
  const hops = Number(env('NEXT_PRIVATE_TRUSTED_PROXY_HOPS'));

  if (!Number.isInteger(hops) || hops < 1) {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }

  return hops;
};

/**
 * Pick the client address out of an X-Forwarded-For value.
 *
 * Every proxy appends the address it received the connection from, so the
 * entries a client sends itself sit on the left and the ones our own proxies
 * add sit on the right. With `trustedHops` proxies, the client is the entry
 * that many places from the right. Anything further left was supplied by the
 * client and cannot be trusted. When the header is shorter than expected, the
 * left-most entry is the best remaining guess.
 */
export const getClientIpFromForwardedFor = (forwardedFor: string, trustedHops: number): string | undefined => {
  const entries = forwardedFor
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return undefined;
  }

  return entries[Math.max(0, entries.length - trustedHops)];
};

export const getIpAddress = (req: Request) => {
  // Check for forwarded headers first (common in proxy setups)
  const forwarded = req.headers.get('x-forwarded-for');

  if (forwarded) {
    const clientIp = getClientIpFromForwardedFor(forwarded, getTrustedProxyHops());

    if (clientIp) {
      return clientIp;
    }
  }

  // Check for real IP header (used by some proxies)
  const realIp = req.headers.get('x-real-ip');

  if (realIp) {
    return realIp;
  }

  // Check for client IP header
  const clientIp = req.headers.get('x-client-ip');

  if (clientIp) {
    return clientIp;
  }

  // Check for CF-Connecting-IP (Cloudflare)
  const cfConnectingIp = req.headers.get('cf-connecting-ip');

  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  // Check for True-Client-IP (Akamai and Cloudflare)
  const trueClientIp = req.headers.get('true-client-ip');

  if (trueClientIp) {
    return trueClientIp;
  }

  throw new Error('No IP address found');
};
