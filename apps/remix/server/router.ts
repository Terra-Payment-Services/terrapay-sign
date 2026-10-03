import { tsRestHonoApp } from '@documenso/api/hono';
import { auth } from '@documenso/auth/server';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobsClient } from '@documenso/lib/jobs/client';
import { isCsrfExemptRequest } from '@documenso/lib/server-only/http/csrf-exemptions';
import { createSameOriginMiddleware } from '@documenso/lib/server-only/http/same-origin-middleware';
import { createRateLimitMiddleware } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import {
  apiTrpcRateLimit,
  apiV1RateLimit,
  apiV2RateLimit,
  fileUploadRateLimit,
} from '@documenso/lib/server-only/rate-limit/rate-limits';
import { migrateDeletedAccountServiceAccount } from '@documenso/lib/server-only/user/service-accounts/deleted-account';
import { migrateLegacyServiceAccount } from '@documenso/lib/server-only/user/service-accounts/legacy-service-account';
import { env } from '@documenso/lib/utils/env';
import { logger } from '@documenso/lib/utils/logger';
import { redactPathTokens } from '@documenso/lib/utils/redact-path-tokens';
import { openApiDocument } from '@documenso/trpc/server/open-api';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { cors } from 'hono/cors';
import type { RequestIdVariables } from 'hono/request-id';
import { requestId } from 'hono/request-id';
import type { Logger } from 'pino';

import { downloadRoute } from './api/download/download';
import { filesRoute } from './api/files/files';
import { apiBodyLimit, fileUploadBodyLimit } from './body-limit';
import { type AppContext, appContext } from './context';
import { appMiddleware } from './middleware';
import { securityHeadersMiddleware } from './security-headers';
import { openApiTrpcServerHandler } from './trpc/hono-trpc-open-api';
import { reactRouterTrpcServer } from './trpc/hono-trpc-remix';

// Re-exported so the rollup build (entry: server/router.ts) bundles them.
// server/main.js imports these from the rolled-up output: getLoadContext to wire
// into the React Router adapter, and the shutdown pair to answer SIGTERM.
export { createGracefulShutdown } from '@documenso/lib/utils/graceful-shutdown';
export { getLoadContext } from './load-context';

export const closeBackgroundJobs = async () => await jobsClient.close();

export interface HonoEnv {
  Variables: RequestIdVariables & {
    context: AppContext;
    logger: Logger;
    cspNonce: string;
  };
}

const basePath = (env('NEXT_PUBLIC_BASE_PATH') ?? '').replace(/\/$/, '');

const app = new Hono<HonoEnv>().basePath(basePath || '/');

/**
 * Database-backed rate limiting for API routes.
 */
const apiV1RateLimitMiddleware = createRateLimitMiddleware(apiV1RateLimit);
const apiV2RateLimitMiddleware = createRateLimitMiddleware(apiV2RateLimit);
const trpcRateLimitMiddleware = createRateLimitMiddleware(apiTrpcRateLimit);
const fileRateLimitMiddleware = createRateLimitMiddleware(fileUploadRateLimit);

const isCsrfExempt = (c: Context) =>
  isCsrfExemptRequest({
    path: c.req.path.slice(basePath.length) || '/',
    hasAuthorizationHeader: !!c.req.header('authorization'),
  });

/**
 * CSRF guard for every state-changing request the browser can send with the
 * session cookie: tRPC, the auth routes, file uploads, cookie-authenticated
 * v2 calls and React Router actions.
 */
const sameOriginMiddleware = createSameOriginMiddleware(NEXT_PUBLIC_WEBAPP_URL, { isExempt: isCsrfExempt });

/**
 * Attach session and context to requests.
 */
app.use(contextStorage());
app.use(appContext);

/**
 * Emit response security headers (CSP with per-request nonce, plus
 * Referrer-Policy and X-Content-Type-Options on embed routes). Must run
 * after `contextStorage()` so the nonce is readable via `getContext()` from
 * `getLoadContext`, and before the React Router handler so the response
 * carries the header.
 */
app.use(securityHeadersMiddleware);

/**
 * RR7 app middleware.
 */
app.use('*', appMiddleware);
app.use('*', requestId());
app.use(async (c, next) => {
  const metadata = c.get('context').requestMetadata;

  const honoLogger = logger.child({
    requestId: c.var.requestId,
    // Signing links and other token routes carry a credential in the path.
    requestPath: redactPathTokens(c.req.path),
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
  });

  c.set('logger', honoLogger);

  await next();
});

app.use('*', sameOriginMiddleware);

// Apply cors and rate limits to API routes.
app.use(`/api/v1/*`, cors());
app.use('/api/v1/*', apiV1RateLimitMiddleware);
app.use(`/api/v2/*`, cors());
app.use('/api/v2/*', apiBodyLimit);
app.use('/api/v2/*', apiV2RateLimitMiddleware);
app.use(`/api/v2-beta/*`, cors());
app.use('/api/v2-beta/*', apiBodyLimit);
app.use('/api/v2-beta/*', apiV2RateLimitMiddleware);

// Auth server.
app.route('/api/auth', auth);

// Files route. The body limit comes first so an oversized upload is refused
// before the rate limiter, the session lookup or the form parser touch it.
app.use('/api/files/*', fileUploadBodyLimit);
app.use('/api/files/upload-pdf', fileRateLimitMiddleware);
app.route('/api/files', filesRoute);

// API servers.
app.route('/api/v1', tsRestHonoApp);
app.use('/api/jobs/*', jobsClient.getApiHandler());

app.use('/api/trpc/*', apiBodyLimit);
app.use('/api/trpc/*', trpcRateLimitMiddleware);
app.use('/api/trpc/*', reactRouterTrpcServer);

// Unstable API server routes. Order matters for these two.
app.get(`/api/v2/openapi.json`, (c) => c.json(openApiDocument));
// Shadows the download routes that tRPC defines since tRPC-to-openapi doesn't support their return types.
app.route(`/api/v2`, downloadRoute);
app.use(`/api/v2/*`, async (c) =>
  openApiTrpcServerHandler(c, {
    isBeta: false,
  }),
);

// Unstable API server routes. Order matters for these two.
app.get(`/api/v2-beta/openapi.json`, (c) => c.json(openApiDocument));
// Shadows the download routes that tRPC defines since tRPC-to-openapi doesn't support their return types.
app.route(`/api/v2-beta`, downloadRoute);
app.use(`/api/v2-beta/*`, async (c) =>
  openApiTrpcServerHandler(c, {
    isBeta: true,
  }),
);

// Upstream started two vendor clients here and both have been removed.
//
// The telemetry client posted a startup event and then an hourly heartbeat,
// forever, to a PostHog project whose key and host are baked into the official
// Docker image at build time. It carried the app version, a database-persisted
// installation id and a per-container node id, and it set `disableGeoip: false`,
// so PostHog also resolved this server's public IP to a location. Its only
// opt-out was an environment variable, which is exactly the kind of thing that
// gets forgotten, so `telemetry-client.ts` has been deleted outright.
//
// The licence client POSTed the licence key to https://license.documenso.com on
// every boot. It existed only to gate the enterprise code, which has been
// deleted, so the client has gone with it.

// Start cron scheduler for background jobs (e.g. envelope expiration sweep).
// No-op for Inngest provider which handles cron externally.
jobsClient.startCron();

void migrateDeletedAccountServiceAccount();
void migrateLegacyServiceAccount();

export default app;
