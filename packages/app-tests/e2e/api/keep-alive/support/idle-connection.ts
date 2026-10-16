import net from 'node:net';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';

/**
 * A raw HTTP/1.1 keep-alive client over node:net for the keep-alive tests. Playwright's request fixture and node:http pool
 * and reopen connections behind the test's back, which is exactly what F5 forbids: a second response that arrived
 * because the client silently reconnected. Here one net.Socket is opened once, and every event it emits is recorded
 * with the time it happened, so a test can say the server never closed it and that both responses used it.
 */

export type HttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type IdleConnection = {
  /** The one socket this connection owns. */
  socket: net.Socket;
  /** How many times the socket emitted 'connect'. One means no reconnect happened. */
  connectCount: () => number;
  /** The local port the socket was bound to when it connected. */
  localPort: () => number | undefined;
  /** performance.now() when the server ended (FIN) or closed or reset the socket, or null while it is open. */
  closedAt: () => number | null;
  /** performance.now() at which the last complete response finished arriving, or null before the first. */
  lastResponseEndedAt: () => number | null;
  /** Every HTTP status line received on this socket. */
  statusLineCount: () => number;
  /** Event names the socket emitted, in order. */
  events: () => string[];
  /** Bytes received after the last complete response, as text. */
  strayBytes: () => string;
  /** Sends one GET and resolves with its complete response, or null if the socket closed or maxMs passed. */
  get: (path: string, maxMs: number) => Promise<HttpResponse | null>;
  /** Resolves with performance.now() at the server's close, or null if still open after maxMs. */
  waitClosed: (maxMs: number) => Promise<number | null>;
  destroy: () => void;
};

const target = () => new URL(NEXT_PUBLIC_WEBAPP_URL());

export const sleepMs = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseHead = (raw: Buffer) => {
  const headEnd = raw.indexOf('\r\n\r\n');

  if (headEnd === -1) {
    return null;
  }

  const [statusLine, ...headerLines] = raw.subarray(0, headEnd).toString('latin1').split('\r\n');
  const headers: Record<string, string> = {};

  for (const line of headerLines) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  return { statusCode: Number(statusLine.split(' ')[1]), headers, bodyStart: headEnd + 4 };
};

/** The length of the first complete response in `raw`, or null while it is incomplete. */
const completeResponseLength = (raw: Buffer): { length: number; response: HttpResponse } | null => {
  const head = parseHead(raw);

  if (head === null) {
    return null;
  }

  const rest = raw.subarray(head.bodyStart);

  if (head.headers['content-length'] !== undefined) {
    const size = Number(head.headers['content-length']);

    return rest.length >= size
      ? {
          length: head.bodyStart + size,
          response: {
            statusCode: head.statusCode,
            headers: head.headers,
            body: rest.subarray(0, size).toString('utf8'),
          },
        }
      : null;
  }

  if (head.headers['transfer-encoding']?.includes('chunked')) {
    const parts: Buffer[] = [];
    let offset = 0;

    while (offset < rest.length) {
      const lineEnd = rest.indexOf('\r\n', offset);

      if (lineEnd === -1) {
        return null;
      }

      const size = Number.parseInt(rest.subarray(offset, lineEnd).toString('latin1').split(';')[0], 16);

      if (size === 0) {
        const end = lineEnd + 4;

        return rest.length >= end
          ? {
              length: head.bodyStart + end,
              response: {
                statusCode: head.statusCode,
                headers: head.headers,
                body: Buffer.concat(parts).toString('utf8'),
              },
            }
          : null;
      }

      if (lineEnd + 2 + size + 2 > rest.length) {
        return null;
      }

      parts.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
      offset = lineEnd + 2 + size + 2;
    }

    return null;
  }

  return { length: head.bodyStart, response: { statusCode: head.statusCode, headers: head.headers, body: '' } };
};

/** Opens a connection to the E2E server, or to the origin given (the shutdown test's own server). */
export const openIdleConnection = async (origin?: string): Promise<IdleConnection> => {
  const { hostname, port } = origin ? new URL(origin) : target();
  // allowHalfOpen keeps this side from ending the socket in answer to the server's FIN, so a close is the server's.
  const socket = net.connect({ host: hostname, port: Number(port), allowHalfOpen: true });
  socket.setNoDelay(true);

  let pending = Buffer.alloc(0);
  let statusLines = 0;
  let closedAt: number | null = null;
  let lastResponseEndedAt: number | null = null;
  let connects = 0;
  const events: string[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const markClosed = (name: string) => {
    events.push(name);

    if (closedAt === null) {
      closedAt = performance.now();
    }

    notify();
  };

  socket.on('connect', () => {
    connects += 1;
    events.push('connect');
  });
  socket.on('data', (data) => {
    pending = Buffer.concat([pending, data]);
    notify();
  });
  socket.on('end', () => markClosed('end'));
  socket.on('close', () => markClosed('close'));
  socket.on('error', () => markClosed('error'));

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

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

  return {
    socket,
    connectCount: () => connects,
    localPort: () => socket.localPort,
    closedAt: () => closedAt,
    lastResponseEndedAt: () => lastResponseEndedAt,
    statusLineCount: () => statusLines,
    events: () => [...events],
    strayBytes: () => pending.toString('latin1'),
    get: async (path, maxMs) => {
      if (closedAt !== null || socket.destroyed) {
        return null;
      }

      await new Promise<void>((resolve) =>
        socket.write(
          [`GET ${path} HTTP/1.1`, `Host: ${hostname}:${port}`, 'Connection: keep-alive', 'Accept: */*', '', ''].join(
            '\r\n',
          ),
          () => resolve(),
        ),
      );

      const isComplete = await waitFor(() => completeResponseLength(pending) !== null || closedAt !== null, maxMs);
      const complete = completeResponseLength(pending);

      if (!isComplete || complete === null) {
        return null;
      }

      lastResponseEndedAt = performance.now();
      statusLines += 1;
      pending = pending.subarray(complete.length);

      return complete.response;
    },
    waitClosed: async (maxMs) => ((await waitFor(() => closedAt !== null, maxMs)) ? closedAt : null),
    destroy: () => socket.destroy(),
  };
};

/**
 * A connection that has sent the start of a request and keeps sending one byte at a time, never finishing the
 * headers. Times are milliseconds since the first byte was flushed.
 */
export type DribbleConnection = {
  elapsedMs: () => number;
  /** Milliseconds after the first byte at which the server ended or reset the socket, or null while it is open. */
  closedAtMs: () => number | null;
  /** The status line of whatever the server wrote before closing, or null. */
  statusCode: () => number | null;
  waitClosed: (maxMs: number) => Promise<number | null>;
  destroy: () => void;
};

export const openDribbleConnection = async (byteIntervalMs = 2000): Promise<DribbleConnection> => {
  const { hostname, port } = target();
  const socket = net.connect({ host: hostname, port: Number(port), allowHalfOpen: true });
  socket.setNoDelay(true);

  let originMs = 0;
  let closedAtMs: number | null = null;
  let received = '';
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const markClosed = () => {
    if (closedAtMs === null) {
      closedAtMs = performance.now() - originMs;
    }

    clearInterval(ticker);
    notify();
  };
  let ticker: NodeJS.Timeout | undefined;

  socket.on('data', (data) => (received += data.toString('latin1')));
  socket.on('end', markClosed);
  socket.on('close', markClosed);
  socket.on('error', markClosed);

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const open = `GET /api/health HTTP/1.1\r\nHost: ${hostname}:${port}\r\nX-Slow: `;

  await new Promise<void>((resolve) => socket.write(open, () => resolve()));
  originMs = performance.now();

  // The header value grows by one byte per tick and the line never ends, so the headers are never complete.
  ticker = setInterval(() => {
    if (!socket.destroyed && !socket.writableEnded) {
      socket.write('a', () => undefined);
    }
  }, byteIntervalMs);

  return {
    elapsedMs: () => performance.now() - originMs,
    closedAtMs: () => closedAtMs,
    statusCode: () => {
      const match = /^HTTP\/1\.1 (\d{3}) /.exec(received);

      return match ? Number(match[1]) : null;
    },
    waitClosed: async (maxMs) =>
      await new Promise<number | null>((resolve) => {
        if (closedAtMs !== null) {
          resolve(closedAtMs);
          return;
        }

        const finish = (result: number | null) => {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(result);
        };
        const check = () => {
          if (closedAtMs !== null) {
            finish(closedAtMs);
          }
        };
        const timer = setTimeout(() => finish(null), maxMs);
        listeners.add(check);
      }),
    destroy: () => {
      clearInterval(ticker);
      socket.destroy();
    },
  };
};
