import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { HonoEnv } from './router';

/**
 * Request body ceilings, applied before anything parses a body.
 *
 * Nothing capped a request body before. `/api/files/upload-pdf` parsed the
 * whole multipart form, then looked at the session, then compared the file
 * with the 50 MB limit, so anyone could make the server buffer as much as they
 * cared to send. `bodyLimit` below refuses on Content-Length before parsing
 * and counts a chunked body as it arrives, answering 413 either way.
 */

const MEBIBYTE = 1024 * 1024;

/** The largest file an upload may carry, in bytes, as `files.ts` measures it. */
const UPLOAD_FILE_MAX_BYTES = APP_DOCUMENT_UPLOAD_SIZE_LIMIT * MEBIBYTE;

/** Room for multipart boundaries, part headers and the small text fields beside a file. */
const MULTIPART_OVERHEAD_BYTES = MEBIBYTE;

/**
 * Files one tRPC or API v2 request may legitimately carry.
 *
 * Envelope creation and the embedded editor take `files` as a repeatable form
 * field, up to the organisation's `envelopeItemCount` claim. That claim
 * defaults to 5 (`DEFAULT_MINIMUM_ENVELOPE_ITEM_COUNT`) and an admin can raise
 * it with no upper bound, so no static figure is exact. Ten covers the default
 * twice over; an organisation given more than ten items would be refused here.
 */
const MAX_FILES_PER_REQUEST = 10;

export const FILE_UPLOAD_BODY_LIMIT_BYTES = UPLOAD_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

export const MULTIPART_API_BODY_LIMIT_BYTES = MAX_FILES_PER_REQUEST * UPLOAD_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

/**
 * JSON bodies on tRPC and API v2. The largest legitimate ones are a profile
 * avatar sent as base64 in `bytes` and drawn signatures sent as data URLs,
 * several of which can share one batched request. Both are well under a
 * megabyte in practice; ten leaves a wide margin.
 */
export const JSON_API_BODY_LIMIT_BYTES = 10 * MEBIBYTE;

/**
 * Most a body is read past the limit before it is refused, so the connection
 * can be kept. Past it the 413 goes out with `Connection: close` instead.
 */
const MAX_DISCARD_BYTES = 64 * MEBIBYTE;

/**
 * How long a drain may take, and how fast it must go. Every refused request
 * is unauthenticated and refused before rate limiting, so a drain must not let
 * a slow sender hold a connection. After `DISCARD_GRACE_MS`, which matches the
 * 500 ms `@hono/node-server` already allowed its own drain, a drain that has
 * averaged less than `MIN_DISCARD_BYTES_PER_SECOND` stops; none runs past
 * `MAX_DISCARD_MS`. A client on loopback sends 11 MiB in about 60 ms, so a
 * real sender clears the floor easily; a stalled or trickling one is answered
 * with `Connection: close` within about half a second.
 */
const DISCARD_GRACE_MS = 500;
const MIN_DISCARD_BYTES_PER_SECOND = MEBIBYTE;
const MAX_DISCARD_MS = 10_000;
const DISCARD_CHECK_MS = 100;

/** Drains running at once; past it a refusal closes the connection straight away. */
const MAX_CONCURRENT_DISCARDS = 16;

let activeDiscards = 0;

/** Read and drop at most `maxBytes` within the bounds above; true if the body ended within them. */
const discardBody = async (reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number) => {
  if (activeDiscards >= MAX_CONCURRENT_DISCARDS) {
    reader.cancel().catch(() => undefined);

    return false;
  }

  activeDiscards++;

  const startedAt = Date.now();
  let discarded = 0;
  let isStopped = false;

  // Cancelling settles the pending read, so the loop below wakes and stops.
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    const isTooSlow = elapsedMs >= DISCARD_GRACE_MS && discarded < (elapsedMs / 1000) * MIN_DISCARD_BYTES_PER_SECOND;

    if (isTooSlow || elapsedMs >= MAX_DISCARD_MS) {
      isStopped = true;
      reader.cancel().catch(() => undefined);
    }
  }, DISCARD_CHECK_MS);

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (isStopped) {
        return false;
      }

      if (done) {
        return true;
      }

      discarded += value.length;

      if (discarded > maxBytes) {
        break;
      }
    }

    await reader.cancel();
  } catch {
    // The client went away; there is nothing left to drain.
  } finally {
    clearInterval(timer);
    activeDiscards--;
  }

  return false;
};

/**
 * Hono's `bodyLimit`, changed so that a connection survives a refusal.
 *
 * A response sent before the client has finished its body loses the
 * connection. Node's HTTP client (v26) stops writing once that early response
 * has ended, so the server sees the body stall and drops the socket. And
 * `@hono/node-server` cannot drain what is left: once the body stream exists,
 * `Readable.toWeb` pauses the request whenever its queue fills, so the drain
 * stalls and the socket is destroyed 500 ms later. A client that reuses it
 * gets a reset.
 *
 * So an oversized body is read and discarded, never buffered, before the 413
 * is sent, up to `MAX_DISCARD_BYTES` past the limit and within the time, rate
 * and concurrency bounds above. A body the route answered without reading is
 * discarded the same way, bounded by the limit itself. Whatever is not drained
 * within the bounds is answered with `Connection: close`.
 */
const bodyLimit = (options: { maxSize: number; onError: (c: Context) => Response }): MiddlewareHandler => {
  const { maxSize, onError } = options;

  const refuse = async (c: Context, reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number) => {
    if (!(await discardBody(reader, maxBytes))) {
      c.header('Connection', 'close');
    }

    return onError(c);
  };

  return async (c, next) => {
    if (!c.req.raw.body) {
      return await next();
    }

    if (c.req.raw.headers.has('content-length') && !c.req.raw.headers.has('transfer-encoding')) {
      const contentLength = parseInt(c.req.raw.headers.get('content-length') || '0', 10);

      if (contentLength > maxSize + MAX_DISCARD_BYTES) {
        c.header('Connection', 'close');

        return onError(c);
      }

      if (contentLength > maxSize) {
        return await refuse(c, c.req.raw.body.getReader(), contentLength);
      }
    } else {
      let size = 0;
      const chunks: Uint8Array[] = [];
      const reader = c.req.raw.body.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        size += value.length;

        if (size > maxSize) {
          return await refuse(c, reader, MAX_DISCARD_BYTES);
        }

        chunks.push(value);
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }

          controller.close();
        },
      });

      const requestInit: RequestInit & { duplex: 'half' } = { body, duplex: 'half' };

      c.req.raw = new Request(c.req.raw, requestInit);
    }

    await next();

    const unreadBody = c.req.raw.body;

    if (unreadBody && !c.req.raw.bodyUsed && !unreadBody.locked) {
      if (!(await discardBody(unreadBody.getReader(), maxSize))) {
        c.header('Connection', 'close');
      }
    }
  };
};

/** For `/api/files/*`, whose only body is a single uploaded PDF. */
export const fileUploadBodyLimit = bodyLimit({
  maxSize: FILE_UPLOAD_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

const multipartApiBodyLimit = bodyLimit({
  maxSize: MULTIPART_API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

const jsonApiBodyLimit = bodyLimit({
  maxSize: JSON_API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

/**
 * For `/api/trpc/*` and the API v2 routes, which serve the same router. A
 * multipart body may carry files; anything else is held to the JSON ceiling.
 */
export const apiBodyLimit = createMiddleware<HonoEnv>(async (c, next) => {
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    return await multipartApiBodyLimit(c, next);
  }

  return await jsonApiBodyLimit(c, next);
});
