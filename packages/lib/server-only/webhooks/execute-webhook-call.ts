import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import type { Prisma } from '@prisma/client';

import { isPubliclyRoutableAddress } from '../../universal/ip-address';
import { assertNotPrivateUrl, isBypassedHost } from './assert-webhook-url';

const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * How much of a receiver's response is kept. The body is stored on the webhook
 * call and shown in the webhook logs sheet, so an endpoint that answered with
 * megabytes used to have every byte written to the database and sent to the
 * browser. Anything past this is dropped and the stored text says so.
 */
export const WEBHOOK_RESPONSE_BODY_MAX_BYTES = 4096;

export const WEBHOOK_RESPONSE_TRUNCATION_MARKER = `\n[truncated: the response exceeded ${WEBHOOK_RESPONSE_BODY_MAX_BYTES} bytes]`;

export type WebhookCallResult = {
  success: boolean;
  responseCode: number;
  responseBody: Prisma.InputJsonValue | Prisma.JsonNullValueInput;
  responseHeaders: Record<string, string>;
};

type TResolvedAddress = {
  address: string;
  family: number;
};

/** Resolves a hostname to every address a connection might use. */
export type TWebhookResolver = (hostname: string) => Promise<TResolvedAddress[]>;

const systemResolver: TWebhookResolver = async (hostname) => await dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The `lookup` a webhook connection uses, which is where the address check has
 * to live to mean anything.
 *
 * Checking the URL and then handing it to `fetch` let the name be resolved a
 * second time when the connection opened, so a host that answered with a
 * public address for the check and a private one for the connection (DNS
 * rebinding) was delivered to. Here the addresses the socket connects to are
 * the very ones that were just checked, so there is no second answer to swap.
 * TLS SNI, certificate verification and the Host header all still use the
 * hostname, because only the resolution step is replaced.
 *
 * Node calls this with `all: true` when it races address families, which is
 * the default since Node 20, and expects an array back in that case.
 *
 * @param resolve - The resolver. Injected by the tests.
 * @param allowPrivate - True only for a host on the SSRF bypass list.
 */
export const createWebhookLookup = ({
  resolve,
  allowPrivate,
}: {
  resolve: TWebhookResolver;
  allowPrivate: boolean;
}): LookupFunction => {
  return (hostname, options, callback) => {
    const wantedFamily = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;

    resolve(hostname).then(
      (resolved) => {
        const addresses =
          wantedFamily === 4 || wantedFamily === 6
            ? resolved.filter((entry) => entry.family === wantedFamily)
            : resolved;

        if (addresses.length === 0) {
          callback(new Error(`Webhook host ${hostname} did not resolve to any address`), '');
          return;
        }

        const blocked = addresses.find((entry) => !isPubliclyRoutableAddress(entry.address));

        if (blocked && !allowPrivate) {
          callback(
            new Error(
              `Refusing webhook host ${hostname}: it resolves to ${blocked.address}, which is not publicly routable`,
            ),
            '',
          );
          return;
        }

        if (options.all) {
          callback(null, addresses);
          return;
        }

        callback(null, addresses[0].address, addresses[0].family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), '');
      },
    );
  };
};

type TWebhookResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  isTruncated: boolean;
};

const flattenHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> => {
  const flat: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    flat[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  return flat;
};

/**
 * POST a JSON body and read at most `WEBHOOK_RESPONSE_BODY_MAX_BYTES` back.
 *
 * Redirects are not followed: a 3xx is returned as the result, as it was with
 * `fetch(..., { redirect: 'manual' })`, and counts as a failed delivery.
 */
const postWebhook = async ({
  url,
  payload,
  headers,
  lookup,
}: {
  url: URL;
  payload: string;
  headers: Record<string, string>;
  lookup: LookupFunction;
}): Promise<TWebhookResponse> => {
  const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;

  if (!transport) {
    throw new Error(`Refusing a ${url.protocol} webhook URL: only http and https are allowed`);
  }

  return await new Promise<TWebhookResponse>((resolve, reject) => {
    let isSettled = false;

    const settle = (outcome: () => void) => {
      if (!isSettled) {
        isSettled = true;
        outcome();
      }
    };

    const request = transport.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(payload)) },
        lookup,
        // A fresh socket per delivery, so a pooled connection opened under some
        // other lookup is never reused for a webhook.
        agent: false,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;

        const finish = (isTruncated: boolean) => {
          settle(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: flattenHeaders(response.headers),
              text: Buffer.concat(chunks).toString('utf8'),
              isTruncated,
            }),
          );
        };

        response.on('data', (chunk: Buffer) => {
          if (isSettled) {
            return;
          }

          const remaining = WEBHOOK_RESPONSE_BODY_MAX_BYTES - total;

          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            finish(true);
            response.destroy();
            return;
          }

          chunks.push(chunk);
          total += chunk.length;
        });

        response.on('end', () => finish(false));
        response.on('error', (error) => settle(() => reject(error)));
      },
    );

    request.on('error', (error) => settle(() => reject(error)));
    request.end(payload);
  });
};

const parseBody = (text: string): Prisma.InputJsonValue => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const describeError = (error: unknown): string => {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return `Request timed out after ${WEBHOOK_TIMEOUT_MS}ms`;
  }

  return error instanceof Error ? error.message : 'Unknown error';
};

export const executeWebhookCall = async (options: {
  url: string;
  body: unknown;
  secret: string | null;
  /** Replaces DNS. Injected by the tests. */
  resolve?: TWebhookResolver;
}): Promise<WebhookCallResult> => {
  const { url, body, secret } = options;
  const resolve = options.resolve ?? systemResolver;

  try {
    await assertNotPrivateUrl(url, { lookup: async (hostname) => await resolve(hostname) });

    const response = await postWebhook({
      url: new URL(url),
      payload: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'X-TerraPay-Secret': secret ?? '',
        // Kept so receivers built against upstream Documenso keep verifying.
        'X-Documenso-Secret': secret ?? '',
      },
      lookup: createWebhookLookup({ resolve, allowPrivate: isBypassedHost(url) }),
    });

    return {
      success: response.status >= 200 && response.status < 300,
      responseCode: response.status,
      responseBody: response.isTruncated
        ? `${response.text}${WEBHOOK_RESPONSE_TRUNCATION_MARKER}`
        : parseBody(response.text),
      responseHeaders: response.headers,
    };
  } catch (err) {
    return {
      success: false,
      responseCode: 0,
      responseBody: describeError(err),
      responseHeaders: {},
    };
  }
};
