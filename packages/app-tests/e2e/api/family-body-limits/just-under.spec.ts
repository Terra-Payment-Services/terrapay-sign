import { expect, test } from '@playwright/test';

import { buildJsonBody } from '../chunked-stall/support/raw-connection';
import { CEILING_BYTES, connectionPool, FAMILY_ROUTES, JSON_TYPE } from './support/families';

/**
 * criterion 8 (F4, F5): a JSON body one byte under its family's ceiling, declared with Content-Length and sent at
 * full speed, gets the route's own answer. The answers were measured on the unfixed server, so this file passes there
 * and must still pass once the limits are in place. A ceiling set below the specification's figure answers 413 here.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(2000);

test.afterEach(() => pool.destroyAll());

test.describe('criterion 8: one byte under the ceiling', () => {
  for (const route of FAMILY_ROUTES) {
    test(`${route.name} gives the route's own ${route.ownAnswer.status}`, async () => {
      const body = buildJsonBody(CEILING_BYTES[route.family] - 1);
      const conn = await pool.connect({
        path: route.path,
        contentType: JSON_TYPE,
        contentLength: body.length,
        headers: route.headers,
      });

      await conn.sendBody(body);

      const response = await conn.waitResponse(30_000);

      expect(
        response,
        `${route.name}: no answer (${conn.writeError() ?? conn.closeKind() ?? 'socket still open'})`,
      ).not.toBeNull();
      expect(response?.statusCode, `${route.name}: status (body ${response?.body.slice(0, 200)})`).toBe(
        route.ownAnswer.status,
      );
      route.ownAnswer.body(response?.body ?? '');
    });
  }
});
