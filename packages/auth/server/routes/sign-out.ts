import { prisma } from '@documenso/prisma';
import { Hono } from 'hono';
import { z } from 'zod';
import { invalidateSessions, validateSessionToken } from '../lib/session/session';
import { deleteSessionCookie, getSessionCookie } from '../lib/session/session-cookies';
import { sValidator } from '../lib/utils/s-validator';
import type { HonoAuthContext } from '../types/context';

const ZSignoutSessionSchema = z.object({
  sessionId: z.string().trim().min(1),
});

export const signOutRoute = new Hono<HonoAuthContext>()
  .post('/signout', async (c) => {
    const metadata = c.get('requestMetadata');

    const sessionToken = await getSessionCookie(c);

    if (!sessionToken) {
      return c.text('No session found', 401);
    }

    const { session } = await validateSessionToken(sessionToken);

    if (!session) {
      deleteSessionCookie(c);
      return c.text('No session found', 401);
    }

    await invalidateSessions({
      userId: session.userId,
      sessionIds: [session.id],
      metadata,
      isRevoke: false,
    });

    deleteSessionCookie(c);

    return c.body(null, 200);
  })
  .post('/signout-all', async (c) => {
    const metadata = c.get('requestMetadata');

    const sessionToken = await getSessionCookie(c);

    if (!sessionToken) {
      return c.text('No session found', 401);
    }

    const { session } = await validateSessionToken(sessionToken);

    if (!session) {
      deleteSessionCookie(c);
      return c.text('No session found', 401);
    }

    const userId = session.userId;

    const userSessionIds = await prisma.session
      .findMany({
        where: {
          userId,
          id: {
            not: session.id,
          },
        },
        select: {
          id: true,
        },
      })
      .then((sessions) => sessions.map((session) => session.id));

    await invalidateSessions({
      userId,
      sessionIds: userSessionIds,
      metadata,
      isRevoke: true,
    });

    return c.body(null, 200);
  })
  .post('/signout-session', sValidator('json', ZSignoutSessionSchema), async (c) => {
    const metadata = c.get('requestMetadata');

    const { sessionId: sessionIdToRevoke } = c.req.valid('json');

    const sessionToken = await getSessionCookie(c);

    if (!sessionToken) {
      return c.text('No session found', 401);
    }

    const { session } = await validateSessionToken(sessionToken);

    if (!session) {
      deleteSessionCookie(c);
      return c.text('No session found', 401);
    }

    await invalidateSessions({
      userId: session.userId,
      sessionIds: [sessionIdToRevoke],
      metadata,
      isRevoke: true,
    });

    if (session.id === sessionIdToRevoke) {
      deleteSessionCookie(c);
    }

    return c.body(null, 200);
  });
