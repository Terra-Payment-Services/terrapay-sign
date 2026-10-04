import { isRecipientTokenAccess2FASatisfied } from '@documenso/lib/server-only/2fa/email/recipient-access-2fa-cookie';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import type { Prisma } from '@prisma/client';
import { Hono } from 'hono';
import { z } from 'zod';

import type { HonoEnv } from '../../../router';
import { handleEnvelopeItemPdfRequest } from './get-envelope-item-pdf';

const route = new Hono<HonoEnv>();

const ZGetEnvelopeItemByTokenParamsSchema = z.object({
  token: z.string().min(1),
  envelopeId: z.string().min(1),
  envelopeItemId: z.string().min(1),
  documentDataId: z.string().min(1),
  version: z.enum(['initial', 'current']),
});

/**
 * Returns a PDF file for an envelope item using a token.
 */
route.get(
  '/token/:token/envelope/:envelopeId/envelopeItem/:envelopeItemId/dataId/:documentDataId/:version/item.pdf',
  sValidator('param', ZGetEnvelopeItemByTokenParamsSchema),
  async (c) => {
    const { token, envelopeId, envelopeItemId, documentDataId, version } = c.req.valid('param');

    if (!token) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Recipient token based query.
    let envelopeItemWhereQuery: Prisma.EnvelopeItemWhereInput = {
      id: envelopeItemId,
      documentDataId,
      envelope: {
        id: envelopeId,
        recipients: {
          some: {
            token,
          },
        },
      },
    };

    // QR token based query.
    if (token.startsWith('qr_')) {
      envelopeItemWhereQuery = {
        id: envelopeItemId,
        documentDataId,
        envelope: {
          id: envelopeId,
          qrToken: token,
        },
      };
    }

    if (!(await isRecipientTokenAccess2FASatisfied({ headers: c.req.raw.headers, token }))) {
      return c.json({ error: 'Access code required' }, 401);
    }

    // Validate envelope access.
    const envelopeItem = await prisma.envelopeItem.findFirst({
      where: envelopeItemWhereQuery,
      include: {
        documentData: true,
      },
    });

    if (!envelopeItem) {
      return c.json({ error: 'Not found' }, 404);
    }

    return await handleEnvelopeItemPdfRequest({
      c,
      envelopeItem,
      version,
    });
  },
);

export default route;
