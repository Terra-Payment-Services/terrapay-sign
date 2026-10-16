import type { IncomingMessage } from 'node:http';

import {
  APP_DOCUMENT_UPLOAD_SIZE_LIMIT,
  APP_ENVELOPE_UPLOAD_TOTAL_SIZE_LIMIT_BYTES,
} from '@documenso/lib/constants/app';
import { getIpAddress } from '@documenso/lib/universal/get-ip-address';
import type { Context, MiddlewareHandler, Next } from 'hono';
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

export const FILE_UPLOAD_BODY_LIMIT_BYTES = UPLOAD_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

/**
 * Multipart bodies on tRPC and API v2, which may carry several files: the files
 * the upload screens allow together, plus the form around them. That is 64 MiB,
 * one client's share of the byte budget, which a declared body reserves, so a
 * larger body is refused as too large rather than always as busy.
 */
export const MULTIPART_API_BODY_LIMIT_BYTES = APP_ENVELOPE_UPLOAD_TOTAL_SIZE_LIMIT_BYTES + MULTIPART_OVERHEAD_BYTES;

/**
 * JSON bodies on tRPC and API v2. The largest legitimate ones are a profile
 * avatar sent as base64 in `bytes` and drawn signatures sent as data URLs,
 * several of which can share one batched request. Both are well under a
 * megabyte in practice; ten leaves a wide margin.
 */
export const JSON_API_BODY_LIMIT_BYTES = 10 * MEBIBYTE;

/** `/api/auth/*`, whose sign-in, password and two-factor bodies are a few KB at most. */
export const AUTH_BODY_LIMIT_BYTES = MEBIBYTE;

/**
 * `/api/jobs/*`. Production's BullMQ handler reads no body outside the admin
 * board, but the local provider's bulk-send payload, a CSV of up to 4M
 * characters, can serialise to about 12 MiB.
 */
export const JOBS_BODY_LIMIT_BYTES = 16 * MEBIBYTE;

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
 * Bounds on reading a chunked body into memory before the route sees it.
 *
 * The pre-read holds bodies that may be legitimate, so the drain bounds above
 * would refuse real uploads on slow links. A request with no body byte after
 * `PRE_READ_FIRST_BYTE_MS` (curl waits about 1 s for `100 Continue`), or that
 * sends less than `MIN_PRE_READ_BYTES_PER_SECOND` over the trailing
 * `PRE_READ_WINDOW_MS` (a trailing window, so a burst cannot buy minutes of
 * trickling), or that has not ended after `MAX_PRE_READ_MS`, is answered 408
 * with `Connection: close`. A 5 MB upload passes at any steady rate above the
 * floor. The timed-out body is not drained, so it takes no drain slot.
 */
const PRE_READ_FIRST_BYTE_MS = 3000;
const PRE_READ_WINDOW_MS = 10_000;
const MIN_PRE_READ_BYTES_PER_SECOND = 32 * 1024;
const MAX_PRE_READ_MS = 180_000;
const PRE_READ_CHECK_MS = 100;
const PRE_READ_WINDOW_SLOTS = PRE_READ_WINDOW_MS / PRE_READ_CHECK_MS;

/**
 * Bytes all chunked pre-reads and declared bodies may hold at once, about 6 %
 * of the 4096 MiB task. A chunk or a declared length that would take the total
 * past it is answered 503 with `Retry-After: 1` and `Connection: close`. A
 * declared body reserves its whole length before the route reads it.
 */
const MAX_HELD_PRE_READ_BYTES = 256 * MEBIBYTE;

let heldPreReadBytes = 0;

/**
 * Bytes one client may hold of that budget, so that filling it takes at least
 * four clients. 64 MiB fits one full file upload with room for JSON beside it.
 * The client is keyed as the rate limiter keys it (`getIpAddress`, trusting
 * one proxy hop by default), and a request with no address shares `unknown`.
 */
const MAX_HELD_PRE_READ_BYTES_PER_CLIENT = 64 * MEBIBYTE;

const heldPreReadBytesByClient = new Map<string, number>();

/** Count `bytes` against the budget and `client`'s share, or report that they do not fit. */
const tryHold = (client: string, bytes: number) => {
  const clientHeld = heldPreReadBytesByClient.get(client) ?? 0;

  if (heldPreReadBytes + bytes > MAX_HELD_PRE_READ_BYTES || clientHeld + bytes > MAX_HELD_PRE_READ_BYTES_PER_CLIENT) {
    return false;
  }

  heldPreReadBytes += bytes;
  heldPreReadBytesByClient.set(client, clientHeld + bytes);

  return true;
};

const clientKey = (c: Context) => {
  try {
    return getIpAddress(c.req.raw);
  } catch {
    return 'unknown';
  }
};

/** True when the body is read into memory before the route: no Content-Length, or a Transfer-Encoding. */
const isChunked = (headers: Headers) => headers.has('transfer-encoding') || !headers.has('content-length');

type PreReadResult =
  | { kind: 'done'; chunks: Uint8Array[] }
  | { kind: 'over-limit' }
  | { kind: 'timeout' }
  | { kind: 'busy' };

/**
 * The bounds above on one body, on a clock the caller keeps. The pre-read runs
 * it on the wall clock; a Content-Length body runs it on the client's.
 */
const createPaceBounds = () => {
  const window = new Array<number>(PRE_READ_WINDOW_SLOTS).fill(0);
  let size = 0;
  let tick = 0;
  let windowBytes = 0;

  // The window advances by elapsed time, every missed slot included, so a late timer cannot keep old bytes counted.
  const advance = (elapsedMs: number) => {
    const target = Math.floor(elapsedMs / PRE_READ_CHECK_MS);
    const steps = Math.min(target - tick, PRE_READ_WINDOW_SLOTS);

    for (let step = 1; step <= steps; step++) {
      const next = (tick + step) % PRE_READ_WINDOW_SLOTS;

      windowBytes -= window[next];
      window[next] = 0;
    }

    tick = Math.max(tick, target);
  };

  return {
    count: (elapsedMs: number, bytes: number) => {
      advance(elapsedMs);
      size += bytes;
      window[tick % PRE_READ_WINDOW_SLOTS] += bytes;
      windowBytes += bytes;
    },
    isCrossed: (elapsedMs: number) => {
      advance(elapsedMs);

      const isFirstByteLate = size === 0 && elapsedMs >= PRE_READ_FIRST_BYTE_MS;
      const isTooSlow =
        elapsedMs >= PRE_READ_WINDOW_MS && windowBytes < (PRE_READ_WINDOW_MS / 1000) * MIN_PRE_READ_BYTES_PER_SECOND;

      return isFirstByteLate || isTooSlow || elapsedMs >= MAX_PRE_READ_MS;
    },
  };
};

/**
 * Read a chunked body into memory within the bounds above. `hold` reports the
 * bytes counted against the budget so far, which the caller releases.
 */
const preReadBody = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxSize: number,
  client: string,
  hold: (bytes: number) => void,
): Promise<PreReadResult> => {
  const startedAt = Date.now();
  const pace = createPaceBounds();
  const chunks: Uint8Array[] = [];
  let size = 0;

  // The timeout settles the race below and leaves the reader alive, so the 408's linger can still read and drop.
  let onTimeout = () => {};
  const timedOut = new Promise<'timeout'>((resolve) => {
    onTimeout = () => resolve('timeout');
  });

  const timer = setInterval(() => {
    if (pace.isCrossed(Date.now() - startedAt)) {
      onTimeout();
    }
  }, PRE_READ_CHECK_MS);

  try {
    for (;;) {
      const result = await Promise.race([reader.read(), timedOut]);

      if (result === 'timeout') {
        return { kind: 'timeout' };
      }

      const { done, value } = result;

      if (done) {
        return { kind: 'done', chunks };
      }

      size += value.length;
      pace.count(Date.now() - startedAt, value.length);

      if (size > maxSize) {
        return { kind: 'over-limit' };
      }

      if (!tryHold(client, value.length)) {
        return { kind: 'busy' };
      }

      hold(value.length);
      chunks.push(value);
    }
  } finally {
    clearInterval(timer);
  }
};

/**
 * The same bounds on a Content-Length body, which the route reads itself
 *. They measure the client: the clock runs only while a read is waiting
 * on the socket, so time the route spends elsewhere, with a chunk already
 * waiting for it, does not count. `timedOut` settles when a bound is crossed.
 * The route's pending read is then left alone until the socket is done and
 * only fails after that, so the route's answer to the failure reaches no one.
 */
const watchBody = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const pace = createPaceBounds();
  let clientMs = 0;
  let waitingSince: number | null = null;
  let isTimedOut = false;

  const clock = () => clientMs + (waitingSince === null ? 0 : Date.now() - waitingSince);

  let onTimeout = () => {};
  const timedOut = new Promise<'timeout'>((resolve) => {
    onTimeout = () => resolve('timeout');
  });

  const timer = setInterval(() => {
    if (waitingSince !== null && pace.isCrossed(clock())) {
      isTimedOut = true;
      clearInterval(timer);
      onTimeout();
    }
  }, PRE_READ_CHECK_MS);

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      waitingSince = Date.now();

      const { done, value } = await reader.read().finally(() => {
        clientMs = clock();
        waitingSince = null;
      });

      if (isTimedOut) {
        // The linger reads and drops the rest and ends the socket; only then does the route's read fail.
        await reader.closed.catch(() => undefined);
        controller.error(new Error('Request timeout'));

        return;
      }

      if (done) {
        controller.close();

        return;
      }

      pace.count(clientMs, value.length);
      controller.enqueue(value);
    },
    async cancel(reason) {
      clearInterval(timer);
      await reader.cancel(reason);
    },
  });

  return { body, timedOut, stop: () => clearInterval(timer) };
};

/**
 * How long a connection refused out of the pre-read keeps reading after its
 * answer. Node destroys a `Connection: close` socket as soon as the answer is
 * written, and closing with the client's bytes still unread sends a reset,
 * which can reach a client that is still writing before the answer does. So
 * the answer is followed by a FIN, the body is read and dropped, and the
 * socket is destroyed `REFUSAL_LINGER_MS` later. The bytes are not held.
 *
 * At most `MAX_LINGERING_REFUSALS` sockets read and drop at once. Past that a
 * refused socket still gets its answer, the FIN and the same delay before it
 * is destroyed, but nothing reads its body, so a flood of refusals costs no
 * more than the sockets themselves.
 */
const REFUSAL_LINGER_MS = 500;
const MAX_LINGERING_REFUSALS = 64;

let lingeringRefusals = 0;

const lingerAfterAnswer = (c: Context, reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const socket = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket;

  if (!socket) {
    return;
  }

  socket.destroySoon = () => {
    socket.end();

    setTimeout(() => {
      reader.cancel().catch(() => undefined);
      socket.destroy();
    }, REFUSAL_LINGER_MS).unref();
  };

  if (lingeringRefusals >= MAX_LINGERING_REFUSALS) {
    return;
  }

  lingeringRefusals++;

  void (async () => {
    try {
      while (!(await reader.read()).done) {
        // Dropped.
      }
    } catch {
      // The socket is gone.
    } finally {
      lingeringRefusals--;
    }
  })();
};

/** The pre-read's 408, also sent when a Content-Length body crosses a bound as the route reads it. */
const answerTimeout = (c: Context, reader: ReadableStreamDefaultReader<Uint8Array>) => {
  lingerAfterAnswer(c, reader);
  c.header('Connection', 'close');

  return c.json({ error: 'Request timeout' }, 408);
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

  const answerBusy = (c: Context, reader: ReadableStreamDefaultReader<Uint8Array>) => {
    lingerAfterAnswer(c, reader);
    c.header('Connection', 'close');
    c.header('Retry-After', '1');

    return c.json({ error: 'Service unavailable' }, 503);
  };

  const limit = async (c: Context, next: Next, client: string, hold: (bytes: number) => void) => {
    if (!c.req.raw.body) {
      return await next();
    }

    if (!isChunked(c.req.raw.headers)) {
      const contentLength = parseInt(c.req.raw.headers.get('content-length') || '0', 10);

      if (contentLength > maxSize + MAX_DISCARD_BYTES) {
        c.header('Connection', 'close');

        return onError(c);
      }

      if (contentLength > maxSize) {
        return await refuse(c, c.req.raw.body.getReader(), contentLength);
      }

      const reader = c.req.raw.body.getReader();

      // The route's parser will buffer the whole declared length, so it is held before the route runs.
      if (!tryHold(client, contentLength)) {
        return answerBusy(c, reader);
      }

      hold(contentLength);

      const watched = watchBody(reader);
      const requestInit: RequestInit & { duplex: 'half' } = { body: watched.body, duplex: 'half' };

      c.req.raw = new Request(c.req.raw, requestInit);

      // On a timeout the route is left running on a read that fails later; the race keeps its outcome handled.
      try {
        if ((await Promise.race([next(), watched.timedOut])) === 'timeout') {
          return answerTimeout(c, reader);
        }
      } finally {
        watched.stop();
      }
    } else {
      const reader = c.req.raw.body.getReader();
      const result = await preReadBody(reader, maxSize, client, hold);

      if (result.kind === 'over-limit') {
        return await refuse(c, reader, MAX_DISCARD_BYTES);
      }

      // Answered at once and kept out of discardBody: the client has stopped sending or the budget is spent.
      if (result.kind === 'timeout') {
        return answerTimeout(c, reader);
      }

      if (result.kind === 'busy') {
        return answerBusy(c, reader);
      }

      const { chunks } = result;

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

      await next();
    }

    const unreadBody = c.req.raw.body;

    if (unreadBody && !c.req.raw.bodyUsed && !unreadBody.locked) {
      if (!(await discardBody(unreadBody.getReader(), maxSize))) {
        c.header('Connection', 'close');
      }
    }
  };

  // Held bytes, pre-read or declared, stay held until the route has finished with them, whichever way the request ends.
  return async (c, next) => {
    const client = clientKey(c);
    let held = 0;

    try {
      return await limit(c, next, client, (bytes) => {
        held += bytes;
      });
    } finally {
      heldPreReadBytes -= held;

      if (held > 0) {
        const clientHeld = (heldPreReadBytesByClient.get(client) ?? 0) - held;

        if (clientHeld > 0) {
          heldPreReadBytesByClient.set(client, clientHeld);
        } else {
          heldPreReadBytesByClient.delete(client);
        }
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

const chunkedMultipartApiBodyLimit = bodyLimit({
  maxSize: FILE_UPLOAD_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

const jsonApiBodyLimit = bodyLimit({
  maxSize: JSON_API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

/**
 * For `/api/v1/*`, which takes JSON only and parses it before checking the
 * token, so any body, multipart included, is held to the JSON ceiling.
 */
export const apiV1BodyLimit = jsonApiBodyLimit;

/** For `/api/auth/*`, which parses JSON before every handler and its sign-in checks. */
export const authBodyLimit = bodyLimit({
  maxSize: AUTH_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

/** For `/api/jobs/*`, whose local provider reads the body before checking its signature. */
export const jobsBodyLimit = bodyLimit({
  maxSize: JOBS_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

/**
 * For `/api/trpc/*` and the API v2 routes, which serve the same router. A
 * multipart body may carry files; anything else is held to the JSON ceiling.
 */
export const apiBodyLimit = createMiddleware<HonoEnv>(async (c, next) => {
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    // A chunked body is buffered before the route sees it, so it is held to one file's worth.
    if (isChunked(c.req.raw.headers)) {
      return await chunkedMultipartApiBodyLimit(c, next);
    }

    return await multipartApiBodyLimit(c, next);
  }

  return await jsonApiBodyLimit(c, next);
});
