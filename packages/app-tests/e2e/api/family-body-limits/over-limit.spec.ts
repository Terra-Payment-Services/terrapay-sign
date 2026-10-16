import { expect, test } from '@playwright/test';

import {
  buildJsonBody,
  buildMultipartBody,
  KIB,
  MULTIPART_CONTENT_TYPE,
} from '../chunked-stall/support/raw-connection';
import {
  CEILING_BYTES,
  connectionPool,
  expectPayloadTooLarge,
  FAMILY_ROUTES,
  JSON_TYPE,
  MAX_DISCARD_BYTES,
  MULTIPART_ROUTES,
} from './support/families';

/**
 * Criteria 1 to 4: a body over its family's ceiling is refused with the payload-too-large answers before the route runs. Every
 * request is unauthenticated. Today none of the three families has a limit, so the route parses the body and answers
 * with its own 400, 401 or 404 (F1, F2, F6), or waits for a body that never comes. The side effects of an over-limit
 * request that would otherwise succeed are in over-limit-side-effects.spec.ts.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);

test.afterEach(() => pool.destroyAll());

test.describe('criterion 1: one byte over the ceiling, declared with Content-Length, at full speed', () => {
  for (const route of FAMILY_ROUTES) {
    test(`${route.name} answers 413 Payload too large`, async () => {
      const body = buildJsonBody(CEILING_BYTES[route.family] + 1);
      const conn = await pool.connect({
        path: route.path,
        contentType: JSON_TYPE,
        contentLength: body.length,
        headers: route.headers,
      });

      await conn.sendBody(body);

      expectPayloadTooLarge(route.name, conn, await conn.waitResponse(20_000));
    });
  }
});

test.describe('criterion 2: a Content-Length more than 64 MiB past the ceiling, no body sent', () => {
  for (const route of FAMILY_ROUTES) {
    test(`${route.name} answers 413 with Connection: close at once`, async () => {
      const conn = await pool.connect({
        path: route.path,
        contentType: JSON_TYPE,
        contentLength: CEILING_BYTES[route.family] + MAX_DISCARD_BYTES + 1,
        headers: route.headers,
      });

      const response = await conn.waitResponse(5000);

      expect(response, `${route.name}: no answer within 5 s of the headers`).not.toBeNull();
      expect(response?.statusCode, `${route.name}: status (body ${response?.body.slice(0, 200)})`).toBe(413);
      expect(response?.headers.connection?.toLowerCase(), `${route.name}: Connection header`).toBe('close');
      expect(response?.headAtMs, `${route.name}: 413 arrival`).toBeLessThan(1000);
      expect(conn.bytesSent(), `${route.name}: body bytes sent`).toBe(0);
    });
  }
});

test.describe('criterion 3: a chunked JSON body that passes the ceiling', () => {
  for (const route of FAMILY_ROUTES) {
    test(`${route.name} answers 413 Payload too large`, async () => {
      const body = buildJsonBody(CEILING_BYTES[route.family] + 64 * KIB);
      const conn = await pool.connect({ path: route.path, contentType: JSON_TYPE, headers: route.headers });

      await conn.sendBody(body);
      await conn.finish();

      expectPayloadTooLarge(route.name, conn, await conn.waitResponse(20_000));
    });
  }
});

test.describe('criterion 4: multipart/form-data is held to the same ceiling (F3)', () => {
  for (const route of MULTIPART_ROUTES) {
    test(`${route.name} answers 413 to a multipart body one byte over its ceiling`, async () => {
      const body = buildMultipartBody(CEILING_BYTES[route.family] + 1);
      const conn = await pool.connect({
        path: route.path,
        contentType: MULTIPART_CONTENT_TYPE,
        contentLength: body.length,
        headers: route.headers,
      });

      await conn.sendBody(body);

      expectPayloadTooLarge(route.name, conn, await conn.waitResponse(20_000));
    });
  }
});
