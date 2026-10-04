import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

import { ipFamily } from '../../universal/ip-address';

/**
 * An outbound request that connects only to addresses somebody already vetted.
 *
 * The guard in `guarded-fetch` resolves a hostname and checks every address it
 * gets back. Handing the URL to `fetch` afterwards lets the platform resolve the
 * name a second time when it connects, and a hostile DNS server can answer that
 * second question with loopback or the instance metadata address. That is DNS
 * rebinding, and the only cure is to make the connection use the answer that
 * was checked.
 *
 * Node's `fetch` offers no way to do that without the `undici` package, which
 * this repository does not depend on. `http.request` and `https.request` take a
 * `lookup` option, and this file supplies one that answers from the vetted list
 * and never consults DNS. The URL's hostname still goes to the request as
 * `host`, so the `Host` header, the TLS server name and the certificate check
 * are all done against the name and never against the address.
 *
 * Differences from `fetch` a caller should know about:
 *
 * - redirects are never followed. A 3xx comes back as it is, which is what
 *   `redirect: 'manual'` asks for and what every caller here wants.
 * - no `accept-encoding` is sent and nothing is decompressed.
 * - each request opens its own connection. A pooled socket would be keyed on
 *   host and port, not on the address this request was allowed to reach.
 * - `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are ignored on purpose. A proxy
 *   would make its own DNS lookup and connect wherever that said, which is the
 *   gap this file closes, and production runs without one.
 */

/**
 * Sends one request to `url`, connecting only to one of `addresses`.
 *
 * `typeof fetch` fits this shape, which is how the tests substitute a fake.
 */
export type PinnedTransport = (url: string, init: RequestInit, addresses: readonly string[]) => Promise<Response>;

/** Statuses the `Response` constructor refuses to pair with a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for `net.connect` that answers from a fixed list.
 *
 * Node calls it two ways. With family autoselection on, the default since Node
 * 20, it passes `all: true` and wants every address with its family. Otherwise
 * it wants one address. Both are answered here, and a family the caller asked
 * for is respected when the list has one.
 */
const lookupFrom =
  (addresses: readonly string[]) =>
  (_hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const entries = addresses.map((address) => ({ address, family: ipFamily(address) }));
    const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates = wanted === 0 ? entries : entries.filter((entry) => entry.family === wanted);

    if (candidates.length === 0) {
      const error: NodeJS.ErrnoException = new Error(`No vetted address of family ${wanted}`);
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }

    if (options.all) {
      callback(null, candidates);
      return;
    }

    callback(null, candidates[0].address, candidates[0].family);
  };

const headersOf = (response: IncomingMessage): Headers => {
  const headers = new Headers();

  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
  }

  return headers;
};

const bodyBytes = (body: RequestInit['body']): string | Uint8Array | undefined => {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  throw new TypeError('A pinned request body must be a string or a byte array');
};

const abortErrorOf = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') {
    return signal.reason;
  }

  const error = new Error('The operation was aborted');
  error.name = 'AbortError';

  return error;
};

/**
 * Send a request that connects to one of `addresses` and nowhere else.
 *
 * @param url - An http or https URL. Its hostname is used for the `Host`
 *   header, the TLS server name and the certificate check.
 * @param init - Method, headers, a string or byte body, and an abort signal.
 *   An abort before or after the headers arrive rejects or errors the body
 *   with an `AbortError`.
 * @param addresses - The addresses the connection may use, already vetted.
 * @returns A `Response` whose body streams from the socket.
 */
export const pinnedFetch: PinnedTransport = async (url, init, addresses) => {
  const target = new URL(url);
  const signal = init.signal ?? undefined;

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError(`A pinned request cannot use ${target.protocol}`);
  }

  if (addresses.length === 0) {
    throw new TypeError(`A pinned request to ${target.hostname} needs at least one address`);
  }

  if (signal?.aborted) {
    throw abortErrorOf(signal);
  }

  const body = bodyBytes(init.body);
  const headers: Record<string, string> = {};

  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });

  if (body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const request = send(
      {
        protocol: target.protocol,
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers,
        lookup: lookupFrom(addresses),
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;

        const onAbort = () => {
          response.destroy(abortErrorOf(signal as AbortSignal));
        };

        signal?.addEventListener('abort', onAbort, { once: true });
        response.once('close', () => signal?.removeEventListener('abort', onAbort));

        if (NULL_BODY_STATUSES.has(status)) {
          response.resume();
        }

        // The constructor throws on a status outside 200 to 599, which a
        // server is free to send.
        try {
          resolve(
            new Response(
              NULL_BODY_STATUSES.has(status)
                ? null
                : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
              { status, statusText: response.statusMessage, headers: headersOf(response) },
            ),
          );
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );

    const onAbort = () => {
      request.destroy(abortErrorOf(signal as AbortSignal));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    request.once('close', () => signal?.removeEventListener('abort', onAbort));
    request.once('error', reject);
    request.end(body);
  });
};
