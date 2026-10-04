import {
  type AddressLookup,
  guardedFetch as guardedFetchWithContext,
  systemLookup,
} from '@documenso/lib/server-only/http/guarded-fetch';
import type { PinnedTransport } from '@documenso/lib/server-only/http/pinned-fetch';
import { isPubliclyRoutableAddress } from '@documenso/lib/universal/ip-address';

import { RevocationFetchError } from './errors';

/**
 * The outbound side of revocation checking.
 *
 * Every URL used here comes out of a certificate, and certificates arrive in
 * documents that other people send us. A responder URL is therefore attacker
 * influenced input pointed straight at our own network, which is the classic
 * shape of a server side request forgery. The library's default provider hands
 * those URLs to `fetch` unmodified.
 *
 * The rules and the redirect handling live in
 * `@documenso/lib/server-only/http/guarded-fetch`, which OpenID discovery uses
 * as well, and the address ranges in `@documenso/lib/universal/ip-address`. Security logic that two callers need should have one implementation,
 * because a second copy is a place for the two to disagree later. This file is
 * what makes the shared guard speak in revocation's own vocabulary and throw
 * revocation's own error type.
 *
 * The one rule chosen here rather than there: http is allowed alongside https.
 * OCSP and CRL endpoints are published over plain http by design, since the
 * objects they serve are signed, so https cannot be required the way it is for
 * the CSC transport or for OpenID discovery.
 *
 * The connection is pinned to the addresses the guard checked, so a responder
 * name that resolves differently when the socket opens (DNS rebinding) cannot
 * reach our network.
 */

const REVOCATION_FETCH_CONTEXT = {
  subject: 'revocation',
  createError: (message: string) => new RevocationFetchError(message),
  isOwnError: (error: unknown) => error instanceof RevocationFetchError,
  allowedProtocols: ['http:', 'https:'] as const,
};

export { type AddressLookup, isPubliclyRoutableAddress, systemLookup };

export type GuardedFetchOptions = {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Wall clock budget for the request and the body read together. */
  timeoutMs: number;
  /** Hard cap on the response body. */
  maxResponseBytes: number;
  /** Replaces the pinned transport. Tests only; see `guarded-fetch`. */
  fetchFn?: PinnedTransport;
  lookup: AddressLookup;
};

/**
 * Fetch a revocation object under the rules described at the top of this file.
 *
 * @throws {RevocationFetchError} on a refused URL, a non-2xx status, a timeout,
 *   an over-cap body, or a redirect we are not willing to follow.
 */
export const guardedFetch = async (options: GuardedFetchOptions): Promise<Uint8Array> =>
  await guardedFetchWithContext({ ...options, ...REVOCATION_FETCH_CONTEXT });
