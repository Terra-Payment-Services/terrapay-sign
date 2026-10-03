import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { AppError } from '@documenso/lib/errors/app-error';
import { isRecipientTokenAccess2FASatisfied } from '@documenso/lib/server-only/2fa/email/recipient-access-2fa-cookie';
import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import { checkEnvelopeFileAccess } from '@documenso/lib/server-only/envelope/check-envelope-file-access';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import type { Prisma } from '@prisma/client';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { HonoEnv } from '../../router';
import { handleEnvelopeItemFileRequest, resolveFileUploadUserId } from './files.helpers';
import {
  ZGetEnvelopeItemFileDownloadRequestParamsSchema,
  ZGetEnvelopeItemFileRequestParamsSchema,
  ZGetEnvelopeItemFileRequestQuerySchema,
  ZGetEnvelopeItemFileTokenDownloadRequestParamsSchema,
  ZGetEnvelopeItemFileTokenRequestParamsSchema,
  ZUploadPdfRequestSchema,
} from './files.types';
import getEnvelopeItemPdfRoute from './routes/get-envelope-item-pdf';
import getEnvelopeItemPdfByTokenRoute from './routes/get-envelope-item-pdf-by-token';

/**
 * Works out who is uploading before the form is parsed. The validator reads
 * the whole multipart body, and it used to run first, so an anonymous caller
 * had the server buffer an upload it was about to refuse.
 */
const requireUploadUser = createMiddleware<HonoEnv & { Variables: { uploadUserId: number } }>(async (c, next) => {
  const userId = await resolveFileUploadUserId(c);

  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('uploadUserId', userId);

  await next();
});

export const filesRoute = new Hono<HonoEnv>()
  /**
   * Uploads a document file to the appropriate storage location and creates
   * a document data record.
   */
  .post('/upload-pdf', requireUploadUser, sValidator('form', ZUploadPdfRequestSchema), async (c) => {
    try {
      const userId = c.get('uploadUserId');

      const { file } = c.req.valid('form');

      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }

      // Todo: (RR7) This is new.
      // Add file size validation.
      // Convert MB to bytes (1 MB = 1024 * 1024 bytes)
      const MAX_FILE_SIZE = APP_DOCUMENT_UPLOAD_SIZE_LIMIT * 1024 * 1024;

      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: 'File too large' }, 400);
      }

      // This endpoint authenticates a person and is told no team, so the
      // uploader is the only claim recorded on the bytes. Nobody else can
      // attach them to an envelope.
      const result = await putNormalizedPdfFileServerSide(file, {
        owner: { userId, teamId: null },
      });

      return c.json(result);
    } catch (error) {
      console.error('Upload failed:', error);
      return c.json({ error: 'Upload failed' }, 500);
    }
  })
  .get(
    '/envelope/:envelopeId/envelopeItem/:envelopeItemId',
    sValidator('param', ZGetEnvelopeItemFileRequestParamsSchema),
    sValidator('query', ZGetEnvelopeItemFileRequestQuerySchema),
    async (c) => {
      const { envelopeId, envelopeItemId } = c.req.valid('param');
      const { token } = c.req.query();

      const session = await getOptionalSession(c);

      let userId = session.user?.id;

      // The presign token is bound to its API token's team, not to every team
      // its user belongs to. See get-envelope-item-pdf.ts.
      let presignTeamId: number | undefined;

      if (token) {
        const presignToken = await verifyEmbeddingPresignToken({
          token,
        }).catch(() => undefined);

        userId = presignToken?.userId;
        presignTeamId = presignToken?.teamId;
      }

      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const envelope = await prisma.envelope.findFirst({
        where: {
          id: envelopeId,
        },
        include: {
          envelopeItems: {
            where: {
              id: envelopeItemId,
            },
            include: {
              documentData: true,
            },
          },
        },
      });

      if (!envelope) {
        return c.json({ error: 'Envelope not found' }, 404);
      }

      if (token && envelope.teamId !== presignTeamId) {
        return c.json({ error: 'Envelope not found' }, 404);
      }

      const [envelopeItem] = envelope.envelopeItems;

      if (!envelopeItem) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      const hasAccess = await checkEnvelopeFileAccess({
        userId,
        envelopeId: envelope.id,
      });

      if (!hasAccess) {
        return c.json({ error: 'User does not have access to the team that this envelope is associated with' }, 403);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelope.status,
        documentData: envelopeItem.documentData,
        version: 'signed',
        isDownload: false,
        context: c,
      });
    },
  )
  .get(
    '/envelope/:envelopeId/envelopeItem/:envelopeItemId/download/:version?',
    sValidator('param', ZGetEnvelopeItemFileDownloadRequestParamsSchema),
    async (c) => {
      const logger = c.get('logger');

      try {
        const { envelopeId, envelopeItemId, version } = c.req.valid('param');

        const session = await getOptionalSession(c);

        if (!session.user) {
          return c.json({ error: 'Unauthorized' }, 401);
        }

        const envelope = await prisma.envelope.findFirst({
          where: {
            id: envelopeId,
          },
          include: {
            envelopeItems: {
              where: {
                id: envelopeItemId,
              },
              include: {
                documentData: true,
              },
            },
            recipients: {
              select: {
                role: true,
                signingStatus: true,
              },
            },
          },
        });

        if (!envelope) {
          return c.json({ error: 'Envelope not found' }, 404);
        }

        const [envelopeItem] = envelope.envelopeItems;

        if (!envelopeItem) {
          return c.json({ error: 'Envelope item not found' }, 404);
        }

        const hasDownloadAccess = await checkEnvelopeFileAccess({
          userId: session.user.id,
          envelopeId: envelope.id,
        });

        if (!hasDownloadAccess) {
          return c.json(
            {
              error: 'User does not have access to the team that this envelope is associated with',
            },
            403,
          );
        }

        if (!envelopeItem.documentData) {
          return c.json({ error: 'Document data not found' }, 404);
        }

        const baseOptions = {
          title: envelopeItem.title,
          documentData: envelopeItem.documentData,
          isDownload: true,
          context: c,
        } as const;

        if (version === 'pending') {
          return await handleEnvelopeItemFileRequest({
            ...baseOptions,
            version,
            envelopeItemId: envelopeItem.id,
            envelope,
          });
        }

        return await handleEnvelopeItemFileRequest({
          ...baseOptions,
          version,
          status: envelope.status,
        });
      } catch (error) {
        logger.error(error);

        if (error instanceof AppError) {
          const { status, body } = AppError.toRestAPIError(error);

          return c.json({ error: body.message, code: error.code }, status);
        }

        return c.json({ error: 'Internal server error' }, 500);
      }
    },
  )
  .get(
    '/token/:token/envelopeItem/:envelopeItemId',
    sValidator('param', ZGetEnvelopeItemFileTokenRequestParamsSchema),
    async (c) => {
      const { token, envelopeItemId } = c.req.valid('param');

      let envelopeWhereQuery: Prisma.EnvelopeItemWhereUniqueInput = {
        id: envelopeItemId,
        envelope: {
          recipients: {
            some: {
              token,
            },
          },
        },
      };

      if (token.startsWith('qr_')) {
        envelopeWhereQuery = {
          id: envelopeItemId,
          envelope: {
            qrToken: token,
          },
        };
      }

      if (!(await isRecipientTokenAccess2FASatisfied({ headers: c.req.raw.headers, token }))) {
        return c.json({ error: 'Access code required' }, 401);
      }

      const envelopeItem = await prisma.envelopeItem.findUnique({
        where: envelopeWhereQuery,
        include: {
          envelope: true,
          documentData: true,
        },
      });

      if (!envelopeItem) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelopeItem.envelope.status,
        documentData: envelopeItem.documentData,
        version: 'signed',
        isDownload: false,
        context: c,
      });
    },
  )
  .get(
    '/token/:token/envelopeItem/:envelopeItemId/download/:version?',
    sValidator('param', ZGetEnvelopeItemFileTokenDownloadRequestParamsSchema),
    async (c) => {
      const { token, envelopeItemId, version } = c.req.valid('param');

      let envelopeWhereQuery: Prisma.EnvelopeItemWhereUniqueInput = {
        id: envelopeItemId,
        envelope: {
          recipients: {
            some: {
              token,
            },
          },
        },
      };

      if (token.startsWith('qr_')) {
        envelopeWhereQuery = {
          id: envelopeItemId,
          envelope: {
            qrToken: token,
          },
        };
      }

      if (!(await isRecipientTokenAccess2FASatisfied({ headers: c.req.raw.headers, token }))) {
        return c.json({ error: 'Access code required' }, 401);
      }

      const envelopeItem = await prisma.envelopeItem.findUnique({
        where: envelopeWhereQuery,
        include: {
          envelope: true,
          documentData: true,
        },
      });

      if (!envelopeItem) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelopeItem.envelope.status,
        documentData: envelopeItem.documentData,
        version,
        isDownload: true,
        context: c,
      });
    },
  );

// PDF routes for both tokens and auth based
// Is different to the other file endpoints since it uses documentDataId for hard caching.
filesRoute.route('/', getEnvelopeItemPdfRoute);
filesRoute.route('/', getEnvelopeItemPdfByTokenRoute);
