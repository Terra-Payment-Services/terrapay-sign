import { createMiddleware } from 'hono/factory';

import type { HonoEnv } from './router';

/**
 * Paths that never render HTML and therefore do not need security headers.
 *
 * Browsers ignore CSP and friends on non-document responses, so we skip
 * them to keep API/manifest/asset responses clean.
 */
const NON_PAGE_PATH_REGEX = /^(\/api\/|\/ingest\/|\/__manifest|\/assets\/|\/apple-.*|\/favicon.*)/;

/**
 * Embed routes serve our white-label embed UI. Customers iframe these from
 * arbitrary origins, so `frame-ancestors` must be wildcard, and customer-
 * supplied CSS is injected at runtime as `<style>` elements which means
 * `style-src-elem` cannot be nonce-restricted on these routes.
 */
const EMBED_PATH_REGEX = /^\/embed(\/|\.data|$)/;

/**
 * Upstream also let any origin frame `/sign/:token`, `/d/:token`, `/signin`,
 * `/forgot-password`, `/check-email` and `/unverified-account`, for customers
 * who iframe the signing page directly and for the embed reauth flow, which
 * navigates the iframe to `/signin`. Nothing frames TerraPay Sign, so those
 * pages now get `frame-ancestors 'self'` like every other page, and a signing
 * link cannot be clickjacked from someone else's site. The cost, accepted on
 * purpose: if `/embed` is ever framed by a third party, its "sign in as a
 * different account" step is refused inside the frame.
 */

/**
 * HTTP Strict Transport Security, a year, subdomains included. Sent on every
 * response rather than only on ones this process saw arrive over TLS, because
 * TLS ends at the load balancer and RFC 6797 has browsers ignore the header on
 * a plain HTTP response anyway, so there is nothing to gain from trusting
 * `X-Forwarded-Proto` to decide.
 */
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

/**
 * Hono context variable name where the per-request CSP nonce is stashed.
 *
 * Read by `getLoadContext` (server/load-context.ts) so the nonce can be
 * threaded into React Router's `<ServerRouter nonce>` and surfaced in the
 * root loader for use by `<Scripts>`, `<Links>`, etc.
 */
export const CSP_NONCE_KEY = 'cspNonce' as const;

const generateNonce = () => {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);

  let binary = '';

  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }

  return btoa(binary);
};

type CspPathKind = 'embed' | 'default';

const buildCspHeader = ({ nonce, kind }: { nonce: string; kind: CspPathKind }) => {
  // `'self'` is included alongside `'strict-dynamic'` as a fallback for
  // browsers that don't understand `'strict-dynamic'`. Modern browsers
  // ignore `'self'` (and other host/scheme sources) when `'strict-dynamic'`
  // is present.
  const directives = [
    // Egress lockdown. Upstream set no `default-src` and no `connect-src`, so
    // the policy governed scripts, styles and framing but placed no limit at
    // all on where the page could send or fetch data. This deployment must not
    // contact any vendor or third party, so the fallback is closed to `'self'`
    // and the fetch-family directives are named explicitly rather than left to
    // inheritance. The effect is that a stray CDN font, a tracking pixel or a
    // re-added analytics beacon is refused by the browser rather than merely
    // absent from the source, which is the difference between "we happen not
    // to call out" and "calling out does not work".
    //
    // `data:` and `blob:` on img-src are required: the PDF viewer paints page
    // renders from blob URLs and signature pads produce data URLs. `font-src`
    // is `'self'` only, because every face is self-hosted from
    // apps/remix/public/fonts and none is fetched from a CDN.
    `default-src 'self'`,
    `connect-src 'self'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `media-src 'self' blob:`,
    `frame-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `form-action 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // PDF.js (apps/remix/app/components/general/pdf-viewer/pdf-viewer.tsx)
    // creates a Web Worker via `new Worker(url)`. `'strict-dynamic'` does
    // not reliably propagate to worker creation across browsers, and
    // without `worker-src` the browser falls back to `script-src` which
    // would block the worker. `blob:` covers libs that inline workers.
    `worker-src 'self' blob:`,
    // Inline `style=""` attributes cannot be nonced or hashed (CSP3 has no
    // mechanism for it), and React inline styles, framer-motion, react-rnd,
    // konva, etc. all rely on them. `'unsafe-inline'` for attributes is
    // industry standard and does not weaken `style-src-elem`.
    `style-src-attr 'unsafe-inline'`,
  ];

  // Embeds inject customer-supplied CSS via runtime-created `<style>`
  // elements (see apps/remix/app/utils/css-vars.ts). Nonce-stamping those
  // would be brittle for white-label customers, so we accept
  // `'unsafe-inline'` on the embed scope only. Frameable (auth/signing)
  // pages do NOT load customer CSS and keep the strict nonced policy.
  if (kind === 'embed') {
    directives.push(`style-src-elem 'self' 'unsafe-inline'`);
  } else {
    directives.push(`style-src-elem 'self' 'nonce-${nonce}'`);
  }

  // Only the embed routes are meant to be framed by another origin. Every
  // other page gets clickjacking protection.
  if (kind === 'embed') {
    directives.push(`frame-ancestors *`);
  } else {
    directives.push(`frame-ancestors 'self'`);
  }

  return directives.join('; ');
};

const classifyPath = (path: string): CspPathKind => {
  if (EMBED_PATH_REGEX.test(path)) {
    return 'embed';
  }

  return 'default';
};

/**
 * Owns response security headers for page responses:
 * `Content-Security-Policy`, plus `Referrer-Policy` and
 * `X-Content-Type-Options` on embed routes (preserved from the per-route
 * `headers()` export this middleware replaces), and
 * `Strict-Transport-Security` on every response, API ones included.
 *
 * Generates a per-request CSP nonce and stashes it on the Hono context so
 * `getLoadContext` (server/load-context.ts) can thread it into React
 * Router for `<ServerRouter nonce>` and `<Scripts nonce>` etc.
 *
 * Path-aware classification:
 * - `embed`     — wildcard `frame-ancestors`, `'unsafe-inline'`
 *                 style-src-elem (white-label CSS injection), strict
 *                 nonced script-src.
 * - default     — strict nonced script-src and style-src-elem,
 *                 `frame-ancestors 'self'` for clickjacking protection.
 */
export const securityHeadersMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const nonce = generateNonce();

  c.set(CSP_NONCE_KEY, nonce);

  await next();

  c.res.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);

  const path = c.req.path;

  if (NON_PAGE_PATH_REGEX.test(path)) {
    return;
  }

  const kind = classifyPath(path);

  c.res.headers.set('Content-Security-Policy', buildCspHeader({ nonce, kind }));

  // Preserved from the per-route `headers()` export in
  // apps/remix/app/routes/embed+/_v0+/_layout.tsx, which has been removed.
  if (kind === 'embed') {
    if (!c.res.headers.has('Referrer-Policy')) {
      c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    }

    if (!c.res.headers.has('X-Content-Type-Options')) {
      c.res.headers.set('X-Content-Type-Options', 'nosniff');
    }
  }
});
