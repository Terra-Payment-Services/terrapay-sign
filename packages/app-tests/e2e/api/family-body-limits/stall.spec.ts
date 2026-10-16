import { expect, test } from '@playwright/test';

import { expectClosedBetween } from '../chunked-stall/support/assertions';
import { expectOnlyTheTimeout } from '../chunked-stall/support/content-length';
import { connectionPool, FAMILY_ROUTES, JSON_TYPE, STALL_DECLARED_BYTES } from './support/families';

/**
 * Criteria 5 and 6: a body that declares a length inside its family's ceiling and then stalls or trickles is
 * answered by the pace bounds. Times are milliseconds from the end of the header write. Every request is
 * unauthenticated. Today each route waits for the body with no deadline (F1, F2), so the socket is still open when the
 * upper bound passes.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(1000);

test.afterEach(() => pool.destroyAll());

test.describe('criterion 5: Content-Length declared, headers sent, no body byte', () => {
  for (const route of FAMILY_ROUTES) {
    test(`${route.name} answers 408 Request timeout with Connection: close between 2.9 s and 3.5 s`, async () => {
      const conn = await pool.connect({
        path: route.path,
        contentType: JSON_TYPE,
        contentLength: STALL_DECLARED_BYTES[route.family],
        headers: route.headers,
      });

      const closedAt = await expectClosedBetween(route.name, conn, { minMs: 2900, maxMs: 4100 }, 9000);
      const response = expectOnlyTheTimeout(route.name, conn);

      expect(response, `${route.name}: closed with no status line`).not.toBeNull();
      expect(
        response?.headAtMs,
        `${route.name}: 408 arrived at ${Math.round(response?.headAtMs ?? 0)} ms`,
      ).toBeGreaterThanOrEqual(2900);
      expect(
        response?.headAtMs,
        `${route.name}: 408 arrived at ${Math.round(response?.headAtMs ?? 0)} ms`,
      ).toBeLessThanOrEqual(3500);
      expect(closedAt).toBeGreaterThanOrEqual(response?.headAtMs ?? 0);
    });
  }
});

test.describe('criterion 6: the same declared length trickled at 100 bytes a second', () => {
  for (const route of FAMILY_ROUTES) {
    test(`${route.name} closes the socket between 9.9 s and 11 s, and any status line is the 408`, async () => {
      const conn = await pool.connect({
        path: route.path,
        contentType: JSON_TYPE,
        contentLength: STALL_DECLARED_BYTES[route.family],
        headers: route.headers,
      });

      void conn.sendPaced(null, 100, { tickMs: 1000 });

      await expectClosedBetween(route.name, conn, { minMs: 9900, maxMs: 11_000 }, 16_000);

      const response = expectOnlyTheTimeout(route.name, conn, { mayBeReset: true });

      if (response) {
        expect(
          response.headAtMs,
          `${route.name}: 408 arrived at ${Math.round(response.headAtMs)} ms`,
        ).toBeGreaterThanOrEqual(9900);
        expect(
          response.headAtMs,
          `${route.name}: 408 arrived at ${Math.round(response.headAtMs)} ms`,
        ).toBeLessThanOrEqual(11_000);
      }
    });
  }
});
