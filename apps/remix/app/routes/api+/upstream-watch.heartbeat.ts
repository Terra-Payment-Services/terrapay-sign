import { createHash, timingSafeEqual } from 'node:crypto';

import { recordWatchHeartbeat } from '@documenso/lib/server-only/health/upstream-watch-heartbeat';
import { env } from '@documenso/lib/utils/env';

/**
 * Where the upstream watch reports that it ran.
 *
 * The watch runs as a weekly CI job on a build runner and the application runs
 * on Fargate, so nothing but this is shared between them. It used to prove it
 * was alive by mailing IT support every week whether or not it had found
 * anything, which turned the liveness signal into fifty two tickets a year
 * that somebody had to close. Mail now goes out only for a real finding, and
 * liveness is a field in /api/health for the monitor to watch.
 *
 * The endpoint takes a bearer secret and writes one Redis key. It reads
 * nothing, returns nothing about the service, and is useless to anyone who
 * reaches it without the secret.
 */
export const action = async ({ request }: { request: Request }) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }

  const secret = env('NEXT_PRIVATE_WATCH_HEARTBEAT_SECRET');

  // Unconfigured is closed, not open. A deployment that has not been given the
  // secret must refuse heartbeats rather than accept anyone's.
  if (!secret) {
    return Response.json({ error: 'not configured' }, { status: 503 });
  }

  if (!presented(request, secret)) {
    return Response.json({ error: 'unauthorised' }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'body is not json' }, { status: 400 });
  }

  const { ok, subject } = (body ?? {}) as Record<string, unknown>;

  try {
    await recordWatchHeartbeat({
      at: new Date().toISOString(),
      ok: ok === true,
      // Bounded, because it is echoed back by the health endpoint and the
      // watch is not the only thing that could ever call this.
      subject: typeof subject === 'string' ? subject.slice(0, 200) : undefined,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'could not record the heartbeat' },
      { status: 503 },
    );
  }

  return Response.json({ recorded: true });
};

/**
 * Whether the request carries the right bearer secret.
 *
 * Both sides are hashed before comparison. `timingSafeEqual` throws on a length
 * mismatch, so comparing the raw values would need a length check first and
 * that check would itself answer "how long is the secret". Digests are always
 * thirty two bytes, so the comparison is total and tells an attacker nothing
 * beyond right or wrong.
 */
const presented = (request: Request, secret: string): boolean => {
  const header = request.headers.get('authorization') ?? '';
  const offered = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

  return timingSafeEqual(digest(offered), digest(secret));
};
