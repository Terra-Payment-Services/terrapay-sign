import { expect } from '@playwright/test';

import type { RawConnection } from './raw-connection';
import { MULTIPART_CONTENT_TYPE, TRPC_PATH, UPLOAD_PATH } from './raw-connection';

/**
 * Shared by the specs: bodies that declare a Content-Length and then stall or trickle.
 */

export const JSON_TYPE = 'application/json';

/** A tRPC-served API v2 route that takes a JSON body. */
export const V2_PATH = '/api/v2/envelope/create';

/** The declared length used where the body is never meant to arrive: 1 MiB, inside every route's limit. */
export const DECLARED_BYTES = 1_048_576;

/** The four request shapes the specification names for criteria 1 to 3 and 8. */
export const CL_ROUTES = [
  { name: 'api.files multipart', path: UPLOAD_PATH, type: MULTIPART_CONTENT_TYPE },
  { name: 'api.trpc json', path: TRPC_PATH, type: JSON_TYPE },
  { name: 'api.trpc multipart', path: TRPC_PATH, type: MULTIPART_CONTENT_TYPE },
  { name: 'api.v2 json', path: V2_PATH, type: JSON_TYPE },
] as const;

/**
 * Criterion 8 and F5: the only thing the client may ever see is the 408 in its form, and nothing after it. A
 * trickling client mid-write may see a reset in place of the status line (criterion 2), and only then is a missing
 * response accepted. Call once the socket has closed.
 */
export const expectOnlyTheTimeout = (label: string, conn: RawConnection, options: { mayBeReset?: boolean } = {}) => {
  const response = conn.response();

  if (response === null) {
    expect(options.mayBeReset, `${label}: closed with no status line and no reset is allowed here`).toBe(true);
    expect(conn.writeError() ?? conn.closeKind(), `${label}: closed with no response and no reset`).not.toBeNull();

    return null;
  }

  expect(response.statusCode, `${label}: status (body ${response.body.slice(0, 200)})`).toBe(408);
  expect(response.headers.connection?.toLowerCase(), `${label}: Connection header`).toBe('close');
  expect(JSON.parse(response.body || 'null'), `${label}: body`).toEqual({ error: 'Request timeout' });
  expect(conn.responseCount(), `${label}: responses received on the connection`).toBe(1);

  return response;
};
