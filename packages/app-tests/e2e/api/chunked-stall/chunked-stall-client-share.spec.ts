import { expect, test } from '@playwright/test';
import type { Held } from './support/fill';
import {
  addresses,
  expectHoldersRefusedCleanly,
  fillUntilRefused,
  IN_FLIGHT_SLACK_BYTES,
  openHolderBytes,
  SHARE_BYTES,
  shareUploadBytes,
} from './support/fill';
import type { RawConnection } from './support/raw-connection';
import {
  CHUNKED_BUDGET_BYTES,
  FILE_UPLOAD_LIMIT_BYTES,
  MIB,
  MULTIPART_CONTENT_TYPE,
  openRawConnection,
  UPLOAD_PATH,
} from './support/raw-connection';

/**
 * per-client share: one client key (X-Forwarded-For, one trusted hop, as the rate limiter resolves it) may hold
 * 64 MiB of chunked pre-read bytes, inside the 256 MiB process-wide budget. Its own group because it fills those
 * budgets: nothing else that holds chunked bytes may run beside it.
 */
test.describe.configure({ mode: 'default' });

const uploadBytes = shareUploadBytes(FILE_UPLOAD_LIMIT_BYTES);
const stop = { value: false };
const everything: RawConnection[] = [];

const track = (held: Held[], refused: Held | null) => {
  everything.push(...held.map((entry) => entry.conn), ...(refused ? [refused.conn] : []));
};

test.afterEach(() => {
  stop.value = true;

  for (const conn of everything.splice(0)) {
    conn.destroy();
  }

  stop.value = false;
});

const expectRefusal = async (conn: RawConnection) => {
  const response = await conn.waitResponse(10_000);

  expect(response, `no answer for the refused request (${conn.writeError() ?? 'no error'})`).not.toBeNull();
  expect(response?.statusCode).toBe(503);
  expect(response?.headers['retry-after']).toBe('1');
  expect(response?.headers.connection?.toLowerCase()).toBe('close');
};

const finishAll = async (held: Held[]) => {
  stop.value = true;

  await Promise.all(
    held.map(async ({ conn }, index) => {
      await conn.finish();

      const answer = await conn.waitResponse(60_000);

      expect(answer, `held request ${index} got no answer after it ended`).not.toBeNull();
      expect([408, 413, 503]).not.toContain(answer?.statusCode);
    }),
  );

  stop.value = false;
};

const maxUploads = Math.floor(SHARE_BYTES / uploadBytes) + 4;

test.describe('per-client share', () => {
  test('one address is held to its share and the chunk that crosses it gets 503, while another address is admitted', async () => {
    test.setTimeout(120_000);

    const [clientA, clientB] = addresses(2, 0);
    const { held, refused, bytesAtRefusal } = await fillUntilRefused({
      addresses: [clientA],
      uploadBytes,
      maxUploads,
      stop,
    });

    track(held, refused);
    console.log(
      `[share] ${JSON.stringify({ uploadMiB: uploadBytes / MIB, admitted: held.length, refusedPresent: refused !== null })}`,
    );

    expect(
      refused,
      `no upload from one address was refused after ${held.length} admitted of ${uploadBytes / MIB} MiB`,
    ).not.toBeNull();
    await expectRefusal((refused as Held).conn);

    expect(bytesAtRefusal).toBeLessThanOrEqual(SHARE_BYTES + IN_FLIGHT_SLACK_BYTES);
    expect(bytesAtRefusal).toBeGreaterThanOrEqual(SHARE_BYTES - uploadBytes);

    for (const [index, entry] of held.entries()) {
      expect(entry.conn.closedAtMs(), `admitted request ${index} was closed`).toBeNull();
      expect(entry.conn.response(), `admitted request ${index} was answered while open`).toBeNull();
    }

    // Isolation: the same moment, another address is admitted and answers as its Content-Length twin does.
    const body = Buffer.alloc(2 * MIB, 0x78);
    const chunked = await openRawConnection({
      path: UPLOAD_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      forwardedFor: clientB,
    });
    const twin = await openRawConnection({
      path: UPLOAD_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      contentLength: body.length,
      forwardedFor: clientB,
    });

    everything.push(chunked, twin);
    await chunked.sendBody(body);
    await chunked.finish();
    await twin.sendBody(body);

    const chunkedAnswer = await chunked.waitResponse(15_000);
    const twinAnswer = await twin.waitResponse(15_000);

    expect(chunkedAnswer).not.toBeNull();
    expect(chunkedAnswer?.statusCode, 'a second address while the first is at its share').not.toBe(503);
    expect(chunkedAnswer?.statusCode).toBe(twinAnswer?.statusCode);
    expect(chunkedAnswer?.body).toBe(twinAnswer?.body);
  });

  test('a burst of refused connections beyond any cap on lingering sockets is still answered and closed in time', async () => {
    test.setTimeout(120_000);

    const [clientA] = addresses(1, 10);
    const { held, refused } = await fillUntilRefused({ addresses: [clientA], uploadBytes, maxUploads, stop });

    track(held, refused);
    expect(refused, 'the address never reached its share').not.toBeNull();

    // More refusals at once than MAX_LINGERING_REFUSALS (64), so some find the linger cap full. Each is closed within
    // 1 s of its 503 whether it lingered (500 ms) or not.
    const payload = Buffer.alloc(uploadBytes, 0x78);
    const burst = await Promise.all(
      Array.from({ length: 70 }, async () =>
        openRawConnection({ path: UPLOAD_PATH, contentType: MULTIPART_CONTENT_TYPE, forwardedFor: clientA }),
      ),
    );

    everything.push(...burst);
    await Promise.all(burst.map(async (conn) => conn.sendBody(payload)));

    await Promise.all(
      burst.map(async (conn, index) => {
        const response = await conn.waitResponse(11_000);

        expect(response?.statusCode, `burst connection ${index} was not answered 503`).toBe(503);
        expect(response?.headers.connection?.toLowerCase()).toBe('close');

        const closedAt = await conn.waitClosed(Math.max(0, (response?.headAtMs ?? 0) + 1_000 - conn.elapsedMs()));

        expect(closedAt, `burst connection ${index} was still open 1 s after its 503`).not.toBeNull();
        expect((closedAt as number) - (response as { headAtMs: number }).headAtMs).toBeLessThanOrEqual(1_000);
      }),
    );
  });

  test('after the held requests end, the same address is admitted again', async () => {
    test.setTimeout(120_000);

    const [clientA] = addresses(1, 20);
    const { held, refused } = await fillUntilRefused({ addresses: [clientA], uploadBytes, maxUploads, stop });

    track(held, refused);
    expect(refused, 'the address never reached its share').not.toBeNull();
    await expectRefusal((refused as Held).conn);
    await finishAll(held);

    const again = await openRawConnection({
      path: UPLOAD_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      forwardedFor: clientA,
    });

    everything.push(again);
    await again.sendBody(Buffer.alloc(uploadBytes, 0x78));
    await again.finish();

    const answer = await again.waitResponse(15_000);

    expect(answer).not.toBeNull();
    expect(answer?.statusCode, 'the address after its requests ended').not.toBe(503);
  });

  test('with five addresses each filling toward its share, the 256 MiB bound still holds', async () => {
    test.setTimeout(180_000);

    const five = addresses(5, 30);
    const { held, refused, bytesAtRefusal, refusedWhileHolding } = await fillUntilRefused({
      addresses: five,
      uploadBytes,
      maxUploads: Math.floor(CHUNKED_BUDGET_BYTES / uploadBytes) + 8,
      stop,
    });

    track(held, refused);
    console.log(
      `[share] ${JSON.stringify({ five: five.length, admitted: held.length, total: bytesAtRefusal / MIB, refusedWhileHolding: refusedWhileHolding.length })}`,
    );

    expect(refused, `no upload was refused after ${held.length} admitted`).not.toBeNull();
    await expectRefusal((refused as Held).conn);
    await expectHoldersRefusedCleanly(refusedWhileHolding);

    expect(bytesAtRefusal).toBeLessThanOrEqual(CHUNKED_BUDGET_BYTES + IN_FLIGHT_SLACK_BYTES);
    expect(bytesAtRefusal).toBeGreaterThanOrEqual(CHUNKED_BUDGET_BYTES - 24 * MIB);

    for (const address of five) {
      expect(openHolderBytes(held, address), `${address} held more than its share`).toBeLessThanOrEqual(
        SHARE_BYTES + IN_FLIGHT_SLACK_BYTES,
      );
    }
  });
});
