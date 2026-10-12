import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT, NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';

/**
 * A raw HTTP/1.1 client over node:net for the tests. Playwright's request
 * fixture cannot send headers without a body, pace a body or see when the
 * server closes a socket, and node:http hides the close behind its own
 * timeouts. Every time here is milliseconds since the request headers were
 * flushed to the kernel, which is the origin the specification measures from.
 */

export type ParsedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  /** Milliseconds from the end of the header write to the first byte of the status line. */
  headAtMs: number;
};

export type CloseKind = 'fin' | 'reset';

export type RawConnection = {
  /** Milliseconds since the headers were written. */
  elapsedMs: () => number;
  response: () => ParsedResponse | null;
  /** How many HTTP status lines have arrived on this connection. More than one means a second response. */
  responseCount: () => number;
  /** Milliseconds at which the server ended or reset the socket, or null while it is open. */
  closedAtMs: () => number | null;
  closeKind: () => CloseKind | null;
  /** The first write error seen (EPIPE, ECONNRESET), or null. */
  writeError: () => string | null;
  bytesSent: () => number;
  /** One framed chunk (or raw bytes under Content-Length). Resolves once flushed, or at once if the socket is gone. */
  send: (data: Buffer) => Promise<void>;
  /** The whole buffer in slices, honouring back-pressure. */
  sendBody: (data: Buffer, sliceBytes?: number) => Promise<void>;
  /**
   * The whole buffer in slices, still writing after the server's FIN, until it is flushed or the socket is gone.
   * Resolves with the bytes flushed. Needs `allowHalfOpen`, or the socket ends its own side on the FIN.
   */
  sendPastFin: (data: Buffer, sliceBytes?: number) => Promise<number>;
  /**
   * Pace bytes at a steady rate, one write per tick. With `data` null the bytes are filler. Stops when the data runs
   * out, when `until` returns true or when the socket closes.
   */
  sendPaced: (
    data: Buffer | null,
    bytesPerSecond: number,
    options?: { tickMs?: number; until?: () => boolean },
  ) => Promise<void>;
  /** The terminating zero chunk. */
  finish: () => Promise<void>;
  /** Resolves with the close time, or null if the socket is still open after `maxMs`. */
  waitClosed: (maxMs: number) => Promise<number | null>;
  /** Resolves with the complete response (or what arrived before the close), or null on timeout. */
  waitResponse: (maxMs: number) => Promise<ParsedResponse | null>;
  destroy: () => void;
};

export type OpenOptions = {
  path: string;
  contentType: string;
  /** Omit for Transfer-Encoding: chunked. */
  contentLength?: number;
  /** Sent as X-Forwarded-For: the client key the rate limiter and the per-client share use (one trusted hop). */
  forwardedFor?: string;
  /** Keep writing after the server's FIN instead of ending this side with it. */
  allowHalfOpen?: boolean;
  /** Extra request headers, such as the session Cookie of an authenticated request. */
  headers?: Record<string, string>;
};

const target = () => new URL(NEXT_PUBLIC_WEBAPP_URL());

const sleep = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

const decodeChunked = (raw: Buffer) => {
  const parts: Buffer[] = [];
  let offset = 0;

  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset);

    if (lineEnd === -1) {
      return { body: Buffer.concat(parts), isComplete: false };
    }

    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString('latin1').split(';')[0], 16);

    if (size === 0) {
      return { body: Buffer.concat(parts), isComplete: true };
    }

    if (lineEnd + 2 + size > raw.length) {
      return { body: Buffer.concat(parts), isComplete: false };
    }

    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }

  return { body: Buffer.concat(parts), isComplete: false };
};

export const openRawConnection = async (options: OpenOptions): Promise<RawConnection> => {
  const { hostname, port } = target();
  const isChunked = options.contentLength === undefined;

  const socket = net.connect({ host: hostname, port: Number(port), allowHalfOpen: options.allowHalfOpen ?? false });
  socket.setNoDelay(true);

  const received: Buffer[] = [];
  let originMs = 0;
  let firstByteAtMs: number | null = null;
  let closedAt: number | null = null;
  let closeKind: CloseKind | null = null;
  let writeError: string | null = null;
  let bytesSent = 0;
  const listeners = new Set<() => void>();

  const elapsedMs = () => performance.now() - originMs;
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const markClosed = (kind: CloseKind) => {
    if (closedAt === null) {
      closedAt = elapsedMs();
      closeKind = kind;
    }

    notify();
  };

  socket.on('data', (data) => {
    if (firstByteAtMs === null) {
      firstByteAtMs = elapsedMs();
    }

    received.push(data);
    notify();
  });
  socket.on('end', () => markClosed('fin'));
  socket.on('close', () => markClosed('fin'));
  socket.on('error', (error: NodeJS.ErrnoException) => {
    writeError = writeError ?? error.code ?? error.message;
    markClosed('reset');
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const head = [
    `POST ${options.path} HTTP/1.1`,
    `Host: ${hostname}:${port}`,
    `Content-Type: ${options.contentType}`,
    'Accept: */*',
    ...(options.forwardedFor ? [`X-Forwarded-For: ${options.forwardedFor}`] : []),
    ...Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    isChunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${options.contentLength}`,
    '',
    '',
  ].join('\r\n');

  await new Promise<void>((resolve) => socket.write(head, () => resolve()));
  originMs = performance.now();

  const response = (): ParsedResponse | null => {
    const raw = Buffer.concat(received);
    const headEnd = raw.indexOf('\r\n\r\n');

    if (headEnd === -1) {
      return null;
    }

    const [statusLine, ...headerLines] = raw.subarray(0, headEnd).toString('latin1').split('\r\n');
    const headers: Record<string, string> = {};

    for (const line of headerLines) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).trim().toLowerCase();
      headers[name] = headers[name]
        ? `${headers[name]}, ${line.slice(colon + 1).trim()}`
        : line.slice(colon + 1).trim();
    }

    const rest = raw.subarray(headEnd + 4);
    const body = headers['transfer-encoding']?.includes('chunked') ? decodeChunked(rest).body : rest;

    return {
      statusCode: Number(statusLine.split(' ')[1]),
      headers,
      body: body.toString('utf8'),
      headAtMs: firstByteAtMs ?? 0,
    };
  };

  const responseCount = () =>
    Buffer.concat(received)
      .toString('latin1')
      .match(/HTTP\/1\.1 \d{3} /g)?.length ?? 0;

  const isResponseComplete = () => {
    const raw = Buffer.concat(received);
    const headEnd = raw.indexOf('\r\n\r\n');

    if (headEnd === -1) {
      return false;
    }

    const headText = raw.subarray(0, headEnd).toString('latin1').toLowerCase();
    const rest = raw.subarray(headEnd + 4);
    const length = /content-length: (\d+)/.exec(headText);

    if (length) {
      return rest.length >= Number(length[1]);
    }

    if (headText.includes('transfer-encoding: chunked')) {
      return decodeChunked(rest).isComplete;
    }

    return /^http\/1\.1 (1|204|304)/.test(headText);
  };

  const waitFor = async (isDone: () => boolean, maxMs: number) =>
    await new Promise<boolean>((resolve) => {
      if (isDone()) {
        resolve(true);
        return;
      }

      const finish = (result: boolean) => {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(result);
      };
      const check = () => {
        if (isDone()) {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), maxMs);
      listeners.add(check);
    });

  const frame = (data: Buffer) =>
    isChunked ? Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from('\r\n')]) : data;

  const send = async (data: Buffer) => {
    if (closedAt !== null || socket.destroyed || socket.writableEnded) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.write(frame(data), (error) => {
        if (error) {
          writeError = writeError ?? (error as NodeJS.ErrnoException).code ?? error.message;
        } else {
          bytesSent += data.length;
        }

        resolve();
      });
    });
  };

  const sendBody = async (data: Buffer, sliceBytes = 64 * 1024) => {
    for (let offset = 0; offset < data.length && closedAt === null; offset += sliceBytes) {
      await send(data.subarray(offset, offset + sliceBytes));
    }
  };

  const sendPastFin = async (data: Buffer, sliceBytes = 64 * 1024) => {
    let flushed = 0;

    for (let offset = 0; offset < data.length && !socket.destroyed && !socket.writableEnded; offset += sliceBytes) {
      const slice = data.subarray(offset, offset + sliceBytes);
      const isFlushed = await new Promise<boolean>((resolve) => socket.write(frame(slice), (error) => resolve(!error)));

      if (!isFlushed) {
        break;
      }

      flushed += slice.length;
    }

    return flushed;
  };

  const sendPaced: RawConnection['sendPaced'] = async (data, bytesPerSecond, paceOptions = {}) => {
    const tickMs = paceOptions.tickMs ?? 100;
    const startedAt = performance.now();
    let sent = 0;

    while (closedAt === null && !paceOptions.until?.() && (data === null || sent < data.length)) {
      await sleep(tickMs);

      const due = Math.floor((bytesPerSecond * (performance.now() - startedAt)) / 1000);
      const count = data === null ? due - sent : Math.min(due, data.length) - sent;

      if (count > 0) {
        await send(data === null ? Buffer.alloc(count, 0x78) : data.subarray(sent, sent + count));
        sent += count;
      }
    }
  };

  return {
    elapsedMs,
    response,
    responseCount,
    closedAtMs: () => closedAt,
    closeKind: () => closeKind,
    writeError: () => writeError,
    bytesSent: () => bytesSent,
    send,
    sendBody,
    sendPastFin,
    sendPaced,
    finish: async () => {
      if (closedAt === null && !socket.destroyed) {
        await new Promise<void>((resolve) => socket.write('0\r\n\r\n', () => resolve()));
      }
    },
    waitClosed: async (maxMs) => ((await waitFor(() => closedAt !== null, maxMs)) ? closedAt : null),
    waitResponse: async (maxMs) =>
      (await waitFor(() => isResponseComplete() || closedAt !== null, maxMs)) ? response() : null,
    destroy: () => socket.destroy(),
  };
};

/** A tRPC-shaped JSON body of exactly `totalBytes` bytes. */
export const buildJsonBody = (totalBytes: number) => {
  const prefix = '{"json":{"name":"';
  const suffix = '"}}';

  return Buffer.from(`${prefix}${'a'.repeat(totalBytes - prefix.length - suffix.length)}${suffix}`);
};

/** A multipart/form-data body of exactly `totalBytes` bytes carrying one file part. */
export const MULTIPART_BOUNDARY = 'c39boundary';
export const MULTIPART_CONTENT_TYPE = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`;

export const buildMultipartBody = (totalBytes: number) => {
  const prefix = `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  const suffix = `\r\n--${MULTIPART_BOUNDARY}--\r\n`;

  return Buffer.concat([
    Buffer.from(prefix),
    Buffer.alloc(totalBytes - prefix.length - suffix.length, 0x78),
    Buffer.from(suffix),
  ]);
};

/**
 * A multipart/form-data body of exactly `totalBytes` bytes carrying a real PDF (assets/example.pdf) padded with
 * comment lines after its end marker, so that a route which validates the file answers 200 rather than refusing it.
 */
export const buildPdfMultipartBody = (totalBytes: number) => {
  const prefix = `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  const suffix = `\r\n--${MULTIPART_BOUNDARY}--\r\n`;
  const pdf = fs.readFileSync(path.resolve(__dirname, '../../../../../../assets/example.pdf'));
  const padding = Buffer.alloc(totalBytes - prefix.length - suffix.length - pdf.length - 1, 0x78);

  padding.fill('%padding padding padding padding padding\n', 0, padding.length);
  padding[padding.length - 1] = 0x0a;

  return Buffer.concat([Buffer.from(prefix), pdf, Buffer.from('\n'), padding, Buffer.from(suffix)]);
};

export const MIB = 1024 * 1024;
export const KIB = 1024;

export const TRPC_PATH = '/api/trpc/profile.updateProfile';
export const UPLOAD_PATH = '/api/files/upload-pdf';

/** The four route families that share the pre-read. */
export const STALL_ROUTES = [
  { name: 'api.trpc', path: TRPC_PATH },
  { name: 'api.v2', path: '/api/v2/envelope/find' },
  { name: 'api.v2-beta', path: '/api/v2-beta/envelope/find' },
  { name: 'api.files', path: UPLOAD_PATH },
] as const;

export const sleepMs = sleep;

/**
 * The body limits, derived as apps/remix/server/body-limit.ts derives them from the configured per-file size:
 * one file plus 1 MiB for a single upload, ten files plus 1 MiB for a multipart API body. The specification's
 * figures (51 MiB and 501 MiB) are these at the default of 50.
 */
export const FILE_LIMIT_MB = APP_DOCUMENT_UPLOAD_SIZE_LIMIT;
export const FILE_UPLOAD_LIMIT_BYTES = FILE_LIMIT_MB * MIB + MIB;
export const MULTIPART_API_LIMIT_BYTES = 10 * FILE_LIMIT_MB * MIB + MIB;
/** The chunked pre-read budget, fixed by the specification. */
export const CHUNKED_BUDGET_BYTES = 256 * MIB;

/** A distinct documentation-range-style address per number, so each gets its own client key. */
export const addressFor = (index: number) => `10.39.${Math.floor(index / 250)}.${(index % 250) + 1}`;
