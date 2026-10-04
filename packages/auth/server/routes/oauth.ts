import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { MicrosoftAuthOptions } from '../config';
import { handleOAuthAuthorizeUrl } from '../lib/utils/handle-oauth-authorize-url';
import type { HonoAuthContext } from '../types/context';

const ZOAuthAuthorizeSchema = z.object({
  redirectPath: z.string().optional(),
});

export const oauthRoute = new Hono<HonoAuthContext>()
  /**
   * Microsoft authorize endpoint.
   */
  .post('/authorize/microsoft', sValidator('json', ZOAuthAuthorizeSchema), async (c) => {
    const { redirectPath } = c.req.valid('json');

    return handleOAuthAuthorizeUrl({
      c,
      clientOptions: MicrosoftAuthOptions,
      redirectPath,
    });
  });
