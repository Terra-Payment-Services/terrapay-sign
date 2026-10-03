import { lookup as dnsLookup } from 'node:dns/promises';

import { ipFamily, isPubliclyRoutableAddress } from '../../universal/ip-address';

/**
 * Outbound HTTP for URLs somebody else chose, kept on a short lead.
 *
 * Several places in this codebase fetch a URL that arrives from outside. The
 * revocation checker takes responder URLs out of certificates other people send
 * us. OpenID discovery takes its URL from what an organisation manager types
 * into the enterprise SSO portal, and the token endpoint and the key set that
 * the sign in then uses are named by the document at that URL. Every one of
 * them is server side request forgery in the classic shape, a URL from an
 * untrusted party pointed at our own network, so they share this guard rather
 * than each growing one that drifts.
 *
 * What this enforces:
 *
 * - only the protocols the caller names. Revocation allows plain http, because
 *   OCSP and CRL endpoints are published that way by design. Discovery allows
 *   https alone.
 * - every address the hostname resolves to must be publicly routable. Loopback,
 *   link local, private, carrier grade NAT, multicast and reserved ranges are
 *   all refused, in IPv4, IPv6 and IPv4 mapped IPv6 form. The ranges themselves
 *   live in `universal/ip-address`, which the webhook URL check also asks and
 *   which therefore may not import a node builtin.
 * - redirects are followed only to the same host, at most twice, and never from
 *   https down to http. Each hop is re-resolved and re-checked.
 * - a wall clock timeout covers the whole exchange, including the body read.
 * - the body is read through a reader and abandoned the moment it exceeds the
 *   cap, so a server cannot stream us out of memory.
 *
 * Residual risk, stated rather than hidden: the address check happens before
 * the connection, so a name that resolves differently on the second lookup
 * (DNS rebinding) is not covered. Closing that needs connection level pinning,
 * which Node's fetch does not expose.
 */

/** Resolves a hostname to the addresses a connection might really use. */
export type AddressLookup = (hostname: string) => Promise<string[]>;

/**
 * What a caller has to say about itself so the messages name the right thing.
 *
 * `subject` is a lowercase noun that reads inside a sentence, for example
 * "revocation" or "OpenID discovery". `createError` turns a message into the
 * error type that caller's own code already catches.
 */
export type GuardedFetchContext = {
  subject: string;
  createError: (message: string) => Error;
  /**
   * Recognises an error this module already raised through `createError`, so a
   * refusal keeps its own wording instead of being wrapped a second time as a
   * transport failure.
   */
  isOwnError: (error: unknown) => boolean;
  /** Protocols this caller will accept, as `URL.protocol` values. */
  allowedProtocols: readonly string[];
  /**
   * Turns off the routable-address requirement, leaving only the protocol
   * check. This exists for one caller, OpenID discovery, which needs a
   * developer running an identity provider on their own machine to work. That
   * caller decides from the environment rather than from the URL, and the
   * decision is made there. Leave it unset everywhere else.
   */
  allowLocalAddresses?: boolean;
};

/**
 * What the address check needs, which is less than a whole fetch needs.
 *
 * `assertUrlIsPubliclyFetchable` is documented for use on its own by a caller
 * that issues its own request. Such a caller has no redirect loop of ours to
 * recognise errors inside, so asking it for `isOwnError` would be asking for a
 * function nothing calls.
 */
export type AddressCheckContext = Pick<
  GuardedFetchContext,
  'subject' | 'createError' | 'allowedProtocols' | 'allowLocalAddresses'
>;

export type GuardedFetchOptions = GuardedFetchContext & {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Wall clock budget for the request and the body read together. */
  timeoutMs: number;
  /** Hard cap on the response body. */
  maxResponseBytes: number;
  fetchFn: typeof fetch;
  lookup: AddressLookup;
};

const MAX_REDIRECTS = 2;

/** Default resolver: whatever the platform would connect to, both families. */
export const systemLookup: AddressLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });

  return results.map((result) => result.address);
};

const readableProtocols = (allowedProtocols: readonly string[]): string =>
  allowedProtocols.map((protocol) => protocol.replace(':', '')).join(' and ');

const resolve = async (hostname: string, lookup: AddressLookup, context: AddressCheckContext): Promise<string[]> => {
  try {
    return await lookup(hostname);
  } catch {
    throw context.createError(`Could not resolve ${context.subject} host ${hostname}`);
  }
};

/**
 * Refuse a URL we are not willing to open a connection to.
 *
 * Callers that hand the request to a library rather than to `guardedFetch` use
 * this on its own, which checks the destination without covering redirects the
 * library may follow afterwards.
 *
 * @param url - The destination, already parsed.
 * @param lookup - How to resolve a hostname. Injected by the tests.
 * @param context - Naming and error construction for the calling module.
 * @throws The caller's error type when the protocol is not allowed, the host is
 *   missing, the host does not resolve, or any resolved address is not public.
 */
export const assertUrlIsPubliclyFetchable = async (
  url: URL,
  lookup: AddressLookup,
  context: AddressCheckContext,
): Promise<void> => {
  const { subject, createError, allowedProtocols } = context;

  if (!allowedProtocols.includes(url.protocol)) {
    throw createError(
      `Refusing a ${url.protocol} ${subject} URL: only ${readableProtocols(allowedProtocols)} are allowed`,
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (hostname.length === 0) {
    throw createError(`Refusing a ${subject} URL with no host`);
  }

  if (context.allowLocalAddresses) {
    return;
  }

  const addresses = ipFamily(hostname) !== 0 ? [hostname] : await resolve(hostname, lookup, context);

  if (addresses.length === 0) {
    throw createError(`Refusing a ${subject} URL whose host ${hostname} did not resolve to any address`);
  }

  for (const address of addresses) {
    if (!isPubliclyRoutableAddress(address)) {
      throw createError(
        `Refusing ${subject} host ${hostname}: it resolves to ${address}, which is not publicly routable`,
      );
    }
  }
};

/**
 * Read a response body, abandoning it the moment it goes over the cap.
 *
 * Exported for a caller that issues its own request because it needs the body
 * of an error response, which `guardedFetch` does not hand back. Such a caller
 * still has to stop a server streaming it out of memory, and this is the same
 * reader rather than a second one that drifts.
 *
 * @throws The caller's error type when the body, or the length it declares,
 *   goes over `maxResponseBytes`.
 */
export const readCappedBody = async (
  response: Response,
  maxResponseBytes: number,
  context: Pick<GuardedFetchContext, 'subject' | 'createError'>,
): Promise<Uint8Array> => {
  const { subject, createError } = context;

  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);

  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw createError(
      `Refusing a ${subject} response that declares ${declaredLength} bytes, over the ${maxResponseBytes} byte cap`,
    );
  }

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());

    if (buffer.length > maxResponseBytes) {
      throw createError(`The ${subject} response exceeds the ${maxResponseBytes} byte cap`);
    }

    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.length;

      if (total > maxResponseBytes) {
        throw createError(`The ${subject} response exceeds the ${maxResponseBytes} byte cap`);
      }

      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return body;
};

const nextHop = (current: URL, response: Response, context: GuardedFetchContext): URL => {
  const { subject, createError } = context;

  const location = response.headers.get('location');

  if (!location) {
    throw createError(`Refusing a ${subject} redirect from ${current.host} that carries no location`);
  }

  let next: URL;

  try {
    next = new URL(location, current);
  } catch {
    throw createError(`Refusing an unparseable ${subject} redirect location from ${current.host}`);
  }

  if (next.host !== current.host) {
    throw createError(
      `Refusing a ${subject} redirect from ${current.host} to ${next.host}: cross-host redirects are not followed`,
    );
  }

  if (current.protocol === 'https:' && next.protocol !== 'https:') {
    throw createError(`Refusing a ${subject} redirect from https to ${next.protocol} on ${current.host}`);
  }

  return next;
};

/**
 * Fetch a URL under the rules described at the top of this file.
 *
 * @returns The response body, at most `maxResponseBytes` long.
 * @throws The caller's error type on a refused URL, a non-2xx status, a
 *   timeout, an over-cap body, or a redirect we are not willing to follow.
 */
export const guardedFetch = async ({
  url,
  method,
  headers,
  body,
  timeoutMs,
  maxResponseBytes,
  fetchFn,
  lookup,
  subject,
  createError,
  isOwnError,
  allowedProtocols,
  allowLocalAddresses,
}: GuardedFetchOptions): Promise<Uint8Array> => {
  const context: GuardedFetchContext = {
    subject,
    createError,
    isOwnError,
    allowedProtocols,
    allowLocalAddresses,
  };

  let target: URL;

  try {
    target = new URL(url);
  } catch {
    throw createError(`Refusing a ${subject} URL that does not parse: ${url}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertUrlIsPubliclyFetchable(target, lookup, context);

      const response = await fetchFn(target.toString(), {
        method,
        headers,
        body: body ? (body.slice() as unknown as BodyInit) : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        target = nextHop(target, response, context);
        continue;
      }

      if (!response.ok) {
        throw createError(`The ${subject} request to ${target.host} failed: HTTP ${response.status}`);
      }

      return await readCappedBody(response, maxResponseBytes, context);
    }

    throw createError(`The ${subject} request to ${target.host} redirected more than ${MAX_REDIRECTS} times`);
  } catch (error) {
    if (isOwnError(error)) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw createError(`The ${subject} request to ${target.host} timed out after ${timeoutMs}ms`);
    }

    throw createError(
      `The ${subject} request to ${target.host} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
};
