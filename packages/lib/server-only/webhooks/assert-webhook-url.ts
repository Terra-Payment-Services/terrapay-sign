import { lookup } from 'node:dns/promises';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { isPrivateUrl } from '../../universal/is-private-url';
import { withTimeout } from '../../utils/timeout';

const ZIpSchema = z.string().ip();

const WEBHOOK_DNS_LOOKUP_TIMEOUT_MS = 3_000;

type TLookupAddress = {
  address: string;
  family: number;
};

type TLookupFn = (
  hostname: string,
  options: {
    all: true;
    verbatim: true;
  },
) => Promise<TLookupAddress[] | TLookupAddress>;

const normalizeHostname = (hostname: string) => hostname.toLowerCase().replace(/\.+$/, '');

const toAddressUrl = (address: string) => (address.includes(':') ? `http://[${address}]` : `http://${address}`);

/**
 * Parse the NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS environment variable into
 * a Set of lowercased hostnames/IPs that are allowed to resolve to private
 * addresses. The Set is built once at module load and never changes.
 *
 * Empty or unset = no bypasses (safe default).
 */
const webhookSSRFBypassHosts = (): Set<string> => {
  const raw = process.env['NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS'] ?? '';

  const hosts = new Set<string>();

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim().toLowerCase();

    if (trimmed.length > 0) {
      hosts.add(trimmed);
    }
  }

  return hosts;
};

const WEBHOOK_SSRF_BYPASS_HOSTS = webhookSSRFBypassHosts();

/**
 * Check whether the hostname of the given URL is present in the SSRF bypass
 * list. Matches against URL.hostname which covers both DNS names and raw IP
 * addresses uniformly.
 */
export const isBypassedHost = (url: string): boolean => {
  if (WEBHOOK_SSRF_BYPASS_HOSTS.size === 0) {
    return false;
  }

  try {
    const hostname = normalizeHostname(new URL(url).hostname);

    return WEBHOOK_SSRF_BYPASS_HOSTS.has(hostname);
  } catch {
    return false;
  }
};

/**
 * Assert that a webhook URL does not point at a private/loopback address,
 * checking both the literal host and its resolved DNS records. Throws an
 * AppError with WEBHOOK_INVALID_REQUEST if it does. Hosts listed in
 * NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS skip all checks.
 *
 * It fails closed. A lookup that errors, times out or returns nothing used to
 * let the URL through, which meant an attacker who could make our resolver
 * slow for 250 ms got past the check entirely. It now refuses, and the webhook
 * job's own retries cover a resolver that is merely having a bad moment.
 *
 * This check alone does not cover DNS rebinding, because the delivery resolves
 * the name again. `executeWebhookCall` closes that by validating the addresses
 * inside the connection's own lookup (see `createWebhookLookup`). Network-level
 * egress rules remain the deployment's responsibility.
 */
export const assertNotPrivateUrl = async (
  url: string,
  options?: {
    lookup?: TLookupFn;
  },
) => {
  if (isBypassedHost(url)) {
    return;
  }

  if (isPrivateUrl(url)) {
    throw new AppError(AppErrorCode.WEBHOOK_INVALID_REQUEST, {
      message: 'Webhook URL resolves to a private or loopback address',
    });
  }

  const refuse = (message: string) =>
    new AppError(AppErrorCode.WEBHOOK_INVALID_REQUEST, {
      message,
    });

  let hostname: string;

  try {
    hostname = normalizeHostname(new URL(url).hostname);
  } catch {
    throw refuse('Webhook URL is not a valid URL');
  }

  if (hostname.length === 0) {
    throw refuse('Webhook URL has no host');
  }

  // An IP literal was judged by `isPrivateUrl` above. URL keeps the brackets
  // on an IPv6 host, which would otherwise be sent to DNS and now refused.
  if (ZIpSchema.safeParse(hostname.replace(/^\[|\]$/g, '')).success) {
    return;
  }

  const resolveHostname = options?.lookup ?? lookup;

  let lookupResult: TLookupAddress[] | TLookupAddress | null;

  try {
    lookupResult = await withTimeout(
      resolveHostname(hostname, {
        all: true,
        verbatim: true,
      }),
      WEBHOOK_DNS_LOOKUP_TIMEOUT_MS,
    );
  } catch {
    throw refuse('Webhook URL host could not be resolved');
  }

  if (!lookupResult) {
    throw refuse('Webhook URL host could not be resolved in time');
  }

  const addresses = Array.isArray(lookupResult) ? lookupResult : [lookupResult];

  if (addresses.length === 0) {
    throw refuse('Webhook URL host did not resolve to any address');
  }

  if (addresses.some(({ address }) => isPrivateUrl(toAddressUrl(address)))) {
    throw refuse('Webhook URL resolves to a private or loopback address');
  }
};
