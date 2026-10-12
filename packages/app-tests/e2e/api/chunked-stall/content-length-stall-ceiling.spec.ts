import { expect, test } from '@playwright/test';

import { expectClosedBetween } from './support/assertions';
import { expectOnlyTheTimeout } from './support/content-length';
import {
  FILE_UPLOAD_LIMIT_BYTES,
  KIB,
  MIB,
  MULTIPART_CONTENT_TYPE,
  openRawConnection,
  TRPC_PATH,
  UPLOAD_PATH,
} from './support/raw-connection';
import { signInCookieHeader } from './support/session';

/**
 * criterion 4, the one slow test: about three minutes. Its own group, as the ceiling is.
 */
test.describe('criterion 4: ceiling', () => {
  test('a Content-Length upload that stays above the floor is answered 408 with Connection: close by 181 s', async () => {
    test.setTimeout(240_000);

    // 51 MiB declared, sent at 64 KiB/s: above the 32 KiB/s floor throughout, and 11.25 MiB in 180 s, so it cannot
    // finish. The file upload limit is 51 MiB at the default and 6 MiB when the server is configured for 5 MB files;
    // below 12 MiB the body could finish inside 180 s, so the same request goes to /api/trpc, whose multipart limit is
    // 501 MiB (or 51 MiB at 5 MB files).
    const isUpload = FILE_UPLOAD_LIMIT_BYTES >= 12 * MIB;
    const conn = await openRawConnection({
      path: isUpload ? UPLOAD_PATH : TRPC_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      contentLength: isUpload ? FILE_UPLOAD_LIMIT_BYTES : 51 * MIB,
      headers: { Cookie: await signInCookieHeader() },
    });

    try {
      void conn.sendPaced(null, 64 * KIB, { tickMs: 125 });

      await expectClosedBetween('ceiling', conn, { minMs: 179_900, maxMs: 181_000 }, 190_000);

      const response = expectOnlyTheTimeout('ceiling', conn);

      expect(response, 'no status line before the close').not.toBeNull();
      expect(response?.headAtMs).toBeGreaterThanOrEqual(179_900);
      expect(response?.headAtMs).toBeLessThanOrEqual(181_000);
    } finally {
      conn.destroy();
    }
  });
});
