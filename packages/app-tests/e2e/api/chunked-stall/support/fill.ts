import { expect } from '@playwright/test';
import type { RawConnection } from './raw-connection';
import { addressFor, KIB, MIB, MULTIPART_CONTENT_TYPE, openRawConnection, UPLOAD_PATH } from './raw-connection';

/** The per-client share of the chunked pre-read budget, fixed by the approved design. */
export const SHARE_BYTES = 64 * MIB;

export type Held = { conn: RawConnection; address: string };

/**
 * The size of one upload used to fill a share: 2 MiB under the file upload limit, capped at 10 MiB, and moved off
 * any size that divides the share exactly so that the refusal is not decided by the last byte.
 */
export const shareUploadBytes = (fileUploadLimitBytes: number) => {
  const capped = Math.min(fileUploadLimitBytes - 2 * MIB, 10 * MIB);

  return SHARE_BYTES % capped === 0 ? capped - MIB : capped;
};

/**
 * Allowance on an upper bound for bytes sent but not yet counted by the server. The holders keep sending 40 KiB/s
 * each while a body is written, so with 80 holders and a body that takes tens of milliseconds the client's count
 * runs ahead of the server's by well under 1 MiB.
 */
export const IN_FLIGHT_SLACK_BYTES = MIB;

/** A holder the server has already refused or closed: its bytes are released, so they no longer count as held. */
export const isRefused = (entry: Held) => entry.conn.response() !== null || entry.conn.closedAtMs() !== null;

/**
 * Bytes sent by holders that are still open. With a hundred holders trickling at the edge of a budget, a holder's own
 * next chunk can be the one that crosses it; the server answers that holder 503 and frees its bytes, so the frozen
 * count of a refused holder is no longer held anywhere.
 */
export const openHolderBytes = (held: Held[], address?: string) =>
  heldBytes(
    held.filter((entry) => !isRefused(entry)),
    address,
  );

/** Every holder refused while holding must have been answered 503 with Retry-After: 1 and Connection: close. */
export const expectHoldersRefusedCleanly = async (refusedHolders: Held[]) => {
  for (const [index, entry] of refusedHolders.entries()) {
    const response = await entry.conn.waitResponse(10_000);

    expect(response?.statusCode, `refused holder ${index}: status`).toBe(503);
    expect(response?.headers['retry-after'], `refused holder ${index}: Retry-After`).toBe('1');
    expect(response?.headers.connection?.toLowerCase(), `refused holder ${index}: Connection`).toBe('close');
  }
};

export const heldBytes = (held: Held[], address?: string) =>
  held
    .filter((entry) => address === undefined || entry.address === address)
    .reduce((sum, entry) => sum + entry.conn.bytesSent(), 0);

/**
 * Open chunked uploads one after another, taking the addresses in turn, each sending `uploadBytes` and then held
 * open just above the 32 KiB/s floor. After each body the request gets 150 ms to be answered or closed (the server
 * answers a refusal within a millisecond or two of reading the crossing chunk, but a body this size is already in
 * the socket buffers when the client finishes writing) before it counts as admitted. Stops at the first refusal.
 */
export const fillUntilRefused = async (options: {
  addresses: string[];
  uploadBytes: number;
  maxUploads: number;
  stop: { value: boolean };
}) => {
  const payload = Buffer.alloc(options.uploadBytes, 0x78);
  const held: Held[] = [];
  let refused: Held | null = null;
  let bytesAtRefusal = 0;
  let refusedWhileHolding: Held[] = [];

  for (let index = 0; index < options.maxUploads; index += 1) {
    const address = options.addresses[index % options.addresses.length];
    const conn = await openRawConnection({
      path: UPLOAD_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      forwardedFor: address,
    });

    await conn.sendBody(payload);

    // Snapshot before the wait: the holders go on sending during it, and that is not what the server had counted.
    const heldWhenBodyEnded = openHolderBytes(held);
    const refusedHoldersWhenBodyEnded = held.filter(isRefused);
    const answered = await conn.waitResponse(150);

    if (answered !== null || conn.response() !== null || conn.closedAtMs() !== null) {
      refused = { conn, address };
      bytesAtRefusal = heldWhenBodyEnded;
      refusedWhileHolding = refusedHoldersWhenBodyEnded;
      break;
    }

    held.push({ conn, address });
    void conn.sendPaced(null, 40 * KIB, { tickMs: 125, until: () => options.stop.value });
  }

  return { held, refused, bytesAtRefusal, refusedWhileHolding };
};

export const addresses = (count: number, offset: number) =>
  Array.from({ length: count }, (_, i) => addressFor(offset + i));
