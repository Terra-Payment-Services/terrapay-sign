import { expect, test } from '@playwright/test';

import { expectClosedBetween } from './support/assertions';
import { FILE_UPLOAD_LIMIT_BYTES, KIB, MIB, openRawConnection, TRPC_PATH, UPLOAD_PATH } from './support/raw-connection';

/**
 * criterion 4, the one slow test: about three minutes. Its own group so
 * that the short tests can run without it, and so that its held bytes never
 * share the chunked byte budget with the budget tests.
 */
test.describe('criterion 4: ceiling', () => {
  test('a chunked upload that stays above the floor is answered 408 with Connection: close by 181 s', async () => {
    test.setTimeout(240_000);

    // 64 KiB/s for 180 s is 11.25 MiB: it needs the file upload limit to be 11.25 MiB or more. Below that the same
    // test runs on /api/trpc JSON (10 MiB limit) at 48 KiB/s, 8.4 MiB in 180 s. Both rates stay above the 32 KiB/s floor.
    const isUpload = FILE_UPLOAD_LIMIT_BYTES >= 12 * MIB;
    const conn = await openRawConnection({
      path: isUpload ? UPLOAD_PATH : TRPC_PATH,
      contentType: isUpload ? 'application/octet-stream' : 'application/json',
    });

    try {
      void conn.sendPaced(null, (isUpload ? 64 : 48) * KIB, { tickMs: 125 });

      await expectClosedBetween('ceiling', conn, { minMs: 179_900, maxMs: 181_000 }, 190_000);

      const response = conn.response();

      expect(response, 'no status line before the close').not.toBeNull();
      expect(response?.statusCode).toBe(408);
      expect(response?.headers.connection?.toLowerCase()).toBe('close');
      expect(response?.headAtMs).toBeGreaterThanOrEqual(179_900);
      expect(response?.headAtMs).toBeLessThanOrEqual(181_000);
    } finally {
      conn.destroy();
    }
  });
});
