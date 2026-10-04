import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { presignScopeCoversEnvelope } from '@documenso/lib/server-only/embedding-presign/presign-scope-covers-envelope';
import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import { checkEnvelopeFileAccess } from '@documenso/lib/server-only/envelope/check-envelope-file-access';
import type { DocumentDataVersion } from '@documenso/lib/types/document';
import { sha256 } from '@documenso/lib/universal/crypto';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import type { DocumentData, EnvelopeItem } from '@prisma/client';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

import type { HonoEnv } from '../../../router';
import { getPresignBearerToken } from '../files.helpers';

const route = new Hono<HonoEnv>();

const ZGetEnvelopeItemPdfRequestParamsSchema = z.object({
  envelopeId: z.string().min(1),
  envelopeItemId: z.string().min(1),
  documentDataId: z.string().min(1),
  version: z.enum(['initial', 'current']),
});

/**
 * Returns a PDF file for an envelope item.
 */
route.get(
  '/envelope/:envelopeId/envelopeItem/:envelopeItemId/dataId/:documentDataId/:version/item.pdf',
  sValidator('param', ZGetEnvelopeItemPdfRequestParamsSchema),
  async (c) => {
    const { envelopeId, envelopeItemId, documentDataId, version } = c.req.valid('param');

    const presignToken = getPresignBearerToken(c);

    const session = await getOptionalSession(c);

    let userId = session.user?.id;

    // A presign token is minted from an API token, and an API token belongs to
    // one team. The token's user may well belong to other teams too, so the
    // user alone is not the boundary: without this the token opened any
    // envelope its user could see, in any of their teams.
    let presignTeamId: number | undefined;

    // A token scoped to one envelope opens that envelope and no other in the team.
    let presignScope: string | undefined;

    // Check the presign token if one was sent
    if (presignToken) {
      const verifiedToken = await verifyEmbeddingPresignToken({
        token: presignToken,
      }).catch(() => undefined);

      userId = verifiedToken?.userId;
      presignTeamId = verifiedToken?.teamId;
      presignScope = verifiedToken?.scope;
    }

    if (!userId) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Note: We authenticate whether the user can access this in the
    // `checkEnvelopeFileAccess` below, which applies the envelope's visibility.
    const envelopeItem = await prisma.envelopeItem.findFirst({
      where: {
        id: envelopeItemId,
        envelopeId,
        documentDataId,
      },
      include: {
        documentData: true,
        envelope: {
          select: {
            id: true,
            secondaryId: true,
            teamId: true,
          },
        },
      },
    });

    if (!envelopeItem) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (presignToken && envelopeItem.envelope.teamId !== presignTeamId) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (presignToken && !presignScopeCoversEnvelope(presignScope, envelopeItem.envelope)) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Check whether the user has access to the document.
    const hasAccess = await checkEnvelopeFileAccess({
      userId,
      envelopeId: envelopeItem.envelope.id,
    });

    if (!hasAccess) {
      return c.json({ error: 'Not found' }, 404);
    }

    return await handleEnvelopeItemPdfRequest({
      c,
      envelopeItem,
      version,
    });
  },
);

type HandleEnvelopeItemPdfRequestOptions = {
  c: Context<HonoEnv>;
  envelopeItem: EnvelopeItem & {
    documentData: DocumentData;
  };
  version: DocumentDataVersion;
};

export const handleEnvelopeItemPdfRequest = async ({
  c,
  envelopeItem,
  version,
}: HandleEnvelopeItemPdfRequestOptions) => {
  // Determine which PDF data to use based on version requested.
  const documentDataToUse =
    version === 'current' ? envelopeItem.documentData.data : envelopeItem.documentData.initialData;

  const etag = Buffer.from(sha256(documentDataToUse)).toString('hex');

  if (c.req.header('If-None-Match') === etag) {
    return c.status(304);
  }

  const file = await getFileServerSide({
    type: envelopeItem.documentData.type,
    data: documentDataToUse,
  }).catch((error) => {
    console.error(error);

    return null;
  });

  if (!file) {
    return c.json({ error: 'Not found' }, 404);
  }

  // Note: Only set these headers on success.
  c.header('Content-Type', 'application/pdf');
  c.header('ETag', etag);
  // Kept out of every cache, as in files.helpers.ts.
  c.header('Cache-Control', 'private, no-store');

  return c.body(file);
};

export default route;
