import { expect } from '@playwright/test';

import type { RawConnection } from './raw-connection';

/**
 * Wait for the server to free the socket and assert the close time against
 * both bounds. A close before the lower bound means something other than the
 * deadline ended the request, and a socket still open at the cap means the
 * server held it (F1, F2, F3, F9). The client never closes its own side here.
 */
export const expectClosedBetween = async (
  label: string,
  conn: RawConnection,
  window: { minMs: number; maxMs: number },
  waitCapMs: number = window.maxMs + 5000,
  originMs = 0,
) => {
  const closedAt = await conn.waitClosed(waitCapMs + originMs);

  expect(
    closedAt,
    `${label}: socket still open ${Math.round(conn.elapsedMs() - originMs)} ms after the reference point, upper bound ${window.maxMs} ms (held far past the bound)`,
  ).not.toBeNull();

  const relative = (closedAt as number) - originMs;

  expect(
    relative,
    `${label}: closed at ${Math.round(relative)} ms, before the ${window.minMs} ms lower bound`,
  ).toBeGreaterThanOrEqual(window.minMs);
  expect(
    relative,
    `${label}: closed at ${Math.round(relative)} ms, after the ${window.maxMs} ms upper bound`,
  ).toBeLessThanOrEqual(window.maxMs);

  return relative;
};

/** When a status line was received it must be the 408 with Connection: close. */
export const expectTimeoutIfAnswered = (label: string, conn: RawConnection) => {
  const response = conn.response();

  if (response === null) {
    expect(
      conn.writeError() ?? conn.closeKind(),
      `${label}: closed with no response and no reset or write error`,
    ).not.toBeNull();
    return null;
  }

  expect(response.statusCode, `${label}: status`).toBe(408);
  expect(response.headers.connection?.toLowerCase(), `${label}: Connection header`).toBe('close');

  return response;
};
