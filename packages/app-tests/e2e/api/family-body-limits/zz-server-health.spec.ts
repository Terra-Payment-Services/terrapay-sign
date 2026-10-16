import fs from 'node:fs';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { expect, test } from '@playwright/test';

/**
 * criterion 9: the server is still up after the other family-body-limits files, and its log carries no unhandled
 * rejection or uncaught exception. The name sorts it last in the directory, and the project runs one file at a time.
 * A spec cannot see a server's log unless it is told where it is, so E2E_SERVER_LOG names the file and the log test is
 * skipped without it.
 */
test.describe('criterion 9: the server stays up', () => {
  test('/api/health answers 200', async ({ request }) => {
    const response = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/health`);

    expect(response.status()).toBe(200);
  });

  test('the server log carries no unhandled rejection or uncaught exception', () => {
    const logPath = process.env.E2E_SERVER_LOG;

    test.skip(!logPath, 'E2E_SERVER_LOG is not set, so the server log cannot be read');

    const log = fs.readFileSync(logPath as string, 'utf8');
    const offending = log
      .split('\n')
      .filter((line) => /unhandled ?rejection|uncaught ?exception|ERR_UNHANDLED/i.test(line));

    expect(offending, 'log lines naming an unhandled rejection or uncaught exception').toEqual([]);
    expect(log.length, 'the log is empty, so it is not the server log').toBeGreaterThan(0);
  });
});
