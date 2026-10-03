import { ipFamily, isPubliclyRoutableAddress } from './ip-address';

/**
 * This lives under `universal/` because the browser bundles it. The tRPC
 * webhook router validates its URL schema with this on the client, so anything
 * it imports ends up in the browser graph. It sat under `server-only/` until a
 * change here pulled in `node:dns` and `node:net` through a shared helper and
 * stopped the application building, and the directory name was part of why
 * that looked safe. Keep this file free of node builtins, and of anything that
 * imports one.
 */

/**
 * Whether a URL's host is an address nobody outside this network can reach.
 *
 * The ranges live in one place now, `isPubliclyRoutableAddress` in
 * `universal/ip-address`, which the revocation fetcher and OIDC discovery also
 * use through `guarded-fetch`. This file used to carry its own list, written as
 * string prefixes, and it agreed with the shared one on loopback, RFC 1918,
 * link local and both spellings of an IPv4 mapped IPv6 address. It called six
 * other unroutable ranges public: carrier grade NAT at
 * 100.64.0.0/10, which is what AWS hands out, the benchmarking range, TEST-NET,
 * multicast, the reserved 240.0.0.0/4, and 0.0.0.0/8 beyond the exact
 * 0.0.0.0. A webhook aimed at any of them would have been accepted.
 *
 * Still synchronous, and still answers false for a hostname, because a name
 * cannot be resolved without waiting. That is not a hole here: it is a first
 * pass for form validation, and `assertNotPrivateUrl` resolves the name and
 * checks every address it gets back before anything is delivered.
 *
 * @param url - The URL a person typed into the webhook form.
 * @returns True when the host is an address that should not be reachable.
 */
export const isPrivateUrl = (url: string): boolean => {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all. The schema that calls this rejects it separately, and
    // answering true here would report the wrong reason.
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;

  if (bare === 'localhost') {
    return true;
  }

  if (ipFamily(bare) === 0) {
    // A name. Nothing can be decided without resolving it.
    return false;
  }

  return !isPubliclyRoutableAddress(bare);
};
