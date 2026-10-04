import { Hono } from 'hono';

import { MicrosoftAuthOptions } from '../config';
import { handleOAuthCallbackUrl } from '../lib/utils/handle-oauth-callback-url';
import type { HonoAuthContext } from '../types/context';

/**
 * Have to create this route instead of bundling callback with oauth routes to provide
 * backwards compatibility for self-hosters (since we used to use NextAuth).
 */
export const callbackRoute = new Hono<HonoAuthContext>()
  /**
   * Microsoft callback verification.
   */
  .get('/microsoft', async (c) => handleOAuthCallbackUrl({ c, clientOptions: MicrosoftAuthOptions }));
