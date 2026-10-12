import { expect, test } from '@playwright/test';
import { IN_FLIGHT_SLACK_BYTES } from './support/fill';
import type { RawConnection } from './support/raw-connection';
import {
  addressFor,
  CHUNKED_BUDGET_BYTES,
  FILE_UPLOAD_LIMIT_BYTES,
  KIB,
  MIB,
  MULTIPART_CONTENT_TYPE,
  openRawConnection,
  UPLOAD_PATH,
} from './support/raw-connection';

/**
 * criterion 8: chunked pre-reads together may hold 256 MiB. Its own group
 * because it fills that budget, so nothing else that holds chunked bytes may
 * run beside it.
 *
 * Each upload is 2 MiB under the file upload limit (49 MiB at the default 50 MB
 * limit, so five fit and the sixth crosses; 4 MiB at 5 MB, so 64 fit and the
 * 65th crosses). The 2 MiB of headroom per request is what the hold below eats.
 */
test.describe('criterion 8: byte budget', () => {
  test('the upload that would take the held total past 256 MiB is answered 503, those admitted are unaffected, and the budget is released', async () => {
    test.setTimeout(180_000);

    const uploadBytes = FILE_UPLOAD_LIMIT_BYTES - 2 * MIB;
    const payload = Buffer.alloc(uploadBytes, 0x78);
    const maxFit = Math.floor(CHUNKED_BUDGET_BYTES / uploadBytes);
    const held: RawConnection[] = [];
    const stop = { value: false };
    let refused: RawConnection | null = null;
    let admittedBytes = 0;
    // Every connection gets an address of its own, so the per-client share never applies and this test
    // keeps measuring the 256 MiB process-wide bound.
    let nextAddress = 0;
    const address = () => addressFor(nextAddress++);

    try {
      for (let index = 0; index < maxFit + 4 && refused === null; index += 1) {
        const conn = await openRawConnection({
          path: UPLOAD_PATH,
          contentType: MULTIPART_CONTENT_TYPE,
          forwardedFor: address(),
        });

        await conn.sendBody(payload);

        // A 4 MiB body fits in the loopback socket buffers, so the client can finish writing before the server has
        // read the chunk that crosses the budget. The server answers within a millisecond or two of reading it, so
        // wait up to 150 ms for an answer or a close before counting this request admitted. The 150 ms is paid by
        // every admitted request (about 10 s for 64 of them), which the hold's 2 MiB of headroom each easily covers.
        // Only holders still open count: one whose own next chunk crossed the budget was answered 503 and its
        // bytes were released, so its frozen count is no longer held.
        const heldWhenBodyEnded = held
          .filter((other) => other.response() === null && other.closedAtMs() === null)
          .reduce((total, other) => total + other.bytesSent(), 0);
        const answered = await conn.waitResponse(150);

        if (answered !== null || conn.response() !== null || conn.closedAtMs() !== null) {
          refused = conn;
          admittedBytes = heldWhenBodyEnded;
          break;
        }

        held.push(conn);

        // Hold just above the 32 KiB/s floor without ending the request.
        void conn.sendPaced(null, 40 * KIB, { tickMs: 125, until: () => stop.value });
      }

      const response = refused ? await (refused as RawConnection).waitResponse(10_000) : null;

      console.log(
        `[budget] ${JSON.stringify({ uploadMiB: uploadBytes / MIB, admitted: held.length, maxFit, refusedStatus: response?.statusCode ?? null })}`,
      );

      expect(
        refused,
        `no upload was refused after ${held.length} admitted of ${uploadBytes / MIB} MiB each`,
      ).not.toBeNull();
      expect(response?.statusCode).toBe(503);
      expect(response?.headers['retry-after']).toBe('1');
      expect(response?.headers.connection?.toLowerCase()).toBe('close');

      // The bytes the admitted requests had sent when the refusal came (their bodies plus hold bytes) never pass
      // the budget, and the refused request's own bytes are what took the total past it. Refusal not early: within
      // 24 MiB of the budget, which is more than the hold bytes can account for.
      expect(admittedBytes).toBeLessThanOrEqual(CHUNKED_BUDGET_BYTES + IN_FLIGHT_SLACK_BYTES);
      expect(admittedBytes).toBeGreaterThanOrEqual(CHUNKED_BUDGET_BYTES - 24 * MIB);
      expect(admittedBytes + (refused as RawConnection).bytesSent()).toBeGreaterThan(CHUNKED_BUDGET_BYTES - 64 * KIB);

      // A holder whose own trickle chunk crossed the budget at the edge was refused: that is the specified
      // behaviour, so it must have been answered exactly 503 with the refusal headers. Any other holder is open.
      const refusedHolders = held.filter((conn) => conn.response() !== null || conn.closedAtMs() !== null);
      const openHolders = held.filter((conn) => !refusedHolders.includes(conn));

      console.log(`[budget] ${JSON.stringify({ refusedWhileHolding: refusedHolders.length })}`);

      for (const [index, conn] of refusedHolders.entries()) {
        const answer = await conn.waitResponse(10_000);

        expect(answer?.statusCode, `refused holder ${index}: status`).toBe(503);
        expect(answer?.headers['retry-after'], `refused holder ${index}: Retry-After`).toBe('1');
        expect(answer?.headers.connection?.toLowerCase(), `refused holder ${index}: Connection`).toBe('close');
      }

      stop.value = true;

      await Promise.all(
        openHolders.map(async (conn, index) => {
          await conn.finish();

          const answer = await conn.waitResponse(60_000);

          expect(answer, `admitted request ${index} got no answer after it ended`).not.toBeNull();
          expect([408, 413, 503]).not.toContain(answer?.statusCode);
        }),
      );

      const again = await openRawConnection({
        path: UPLOAD_PATH,
        contentType: MULTIPART_CONTENT_TYPE,
        forwardedFor: address(),
      });

      held.push(again);
      await again.sendBody(Buffer.alloc(MIB, 0x78));
      await again.finish();

      const admitted = await again.waitResponse(15_000);

      expect(admitted).not.toBeNull();
      expect(admitted?.statusCode, 'a new chunked request after the budget was released').not.toBe(503);
    } finally {
      stop.value = true;

      for (const conn of [...held, ...(refused ? [refused] : [])]) {
        conn.destroy();
      }
    }
  });
});
