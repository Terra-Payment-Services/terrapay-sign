import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';

import type { HonoEnv } from './router';

/**
 * Request body ceilings, applied before anything parses a body.
 *
 * Nothing capped a request body before. `/api/files/upload-pdf` parsed the
 * whole multipart form, then looked at the session, then compared the file
 * with the 50 MB limit, so anyone could make the server buffer as much as they
 * cared to send. Hono's `bodyLimit` refuses on Content-Length before reading
 * and counts a chunked body as it arrives, answering 413 either way.
 */

const MEBIBYTE = 1024 * 1024;

/** The largest file an upload may carry, in bytes, as `files.ts` measures it. */
const UPLOAD_FILE_MAX_BYTES = APP_DOCUMENT_UPLOAD_SIZE_LIMIT * MEBIBYTE;

/** Room for multipart boundaries, part headers and the small text fields beside a file. */
const MULTIPART_OVERHEAD_BYTES = MEBIBYTE;

/**
 * Files one tRPC or API v2 request may legitimately carry.
 *
 * Envelope creation and the embedded editor take `files` as a repeatable form
 * field, up to the organisation's `envelopeItemCount` claim. That claim
 * defaults to 5 (`DEFAULT_MINIMUM_ENVELOPE_ITEM_COUNT`) and an admin can raise
 * it with no upper bound, so no static figure is exact. Ten covers the default
 * twice over; an organisation given more than ten items would be refused here.
 */
const MAX_FILES_PER_REQUEST = 10;

export const FILE_UPLOAD_BODY_LIMIT_BYTES = UPLOAD_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

export const MULTIPART_API_BODY_LIMIT_BYTES = MAX_FILES_PER_REQUEST * UPLOAD_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

/**
 * JSON bodies on tRPC and API v2. The largest legitimate ones are a profile
 * avatar sent as base64 in `bytes` and drawn signatures sent as data URLs,
 * several of which can share one batched request. Both are well under a
 * megabyte in practice; ten leaves a wide margin.
 */
export const JSON_API_BODY_LIMIT_BYTES = 10 * MEBIBYTE;

/** For `/api/files/*`, whose only body is a single uploaded PDF. */
export const fileUploadBodyLimit = bodyLimit({
  maxSize: FILE_UPLOAD_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

const multipartApiBodyLimit = bodyLimit({
  maxSize: MULTIPART_API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

const jsonApiBodyLimit = bodyLimit({
  maxSize: JSON_API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

/**
 * For `/api/trpc/*` and the API v2 routes, which serve the same router. A
 * multipart body may carry files; anything else is held to the JSON ceiling.
 */
export const apiBodyLimit = createMiddleware<HonoEnv>(async (c, next) => {
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    return await multipartApiBodyLimit(c, next);
  }

  return await jsonApiBodyLimit(c, next);
});
