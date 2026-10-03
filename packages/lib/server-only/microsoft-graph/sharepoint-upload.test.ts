import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MicrosoftGraphCredentials } from './graph-auth';
import { clearGraphTokenCache } from './graph-auth';
import {
  parseRetryAfterMs,
  SIMPLE_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_SIZE_BYTES,
  uploadFileToSharePoint,
} from './sharepoint-upload';

const credentials: MicrosoftGraphCredentials = {
  tenantId: 'tenant-id',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

const target = {
  siteId: 'contoso.sharepoint.com,site-collection,site',
  driveId: 'drive-id',
};

type StubbedCall = {
  url: string;
  init: RequestInit;
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const tokenResponse = () => jsonResponse(200, { access_token: 'bearer-token', expires_in: 3600 });

/**
 * The pre-authenticated link Graph hands back on a DriveItem. Adoption reads
 * the stored bytes through it, so the stub has to answer it.
 */
const DOWNLOAD_URL = 'https://contoso.sharepoint.com/download/pre-authenticated';

const binaryResponse = (content: Uint8Array) =>
  new Response(content, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });

/**
 * A Graph stub that answers the token endpoint and then hands every other
 * request to the supplied handler, recording each call.
 */
const createGraph = (handler: (call: StubbedCall, index: number) => Response | Promise<Response>) => {
  const calls: StubbedCall[] = [];

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('login.microsoftonline.com')) {
      return tokenResponse();
    }

    const call = { url, init: init ?? {} };

    calls.push(call);

    return await handler(call, calls.length - 1);
  });

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
};

const headerOf = (init: RequestInit, name: string): string | undefined => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const headers = (init.headers ?? {}) as Record<string, string>;

  return headers[name];
};

const bodyLengthOf = (init: RequestInit): number => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const body = init.body as Uint8Array | undefined;

  return body?.byteLength ?? 0;
};

describe('uploadFileToSharePoint', () => {
  beforeEach(() => {
    clearGraphTokenCache();
  });

  it('sends a file under 4 MB in a single request', async () => {
    const { calls, fetchFn } = createGraph(() =>
      jsonResponse(201, {
        id: 'item-id',
        webUrl: 'https://contoso.sharepoint.com/item',
      }),
    );

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: 'Contracts/2026/09',
      fileName: 'Small.pdf',
      content: new Uint8Array(1024),
      fetchFn,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].url).toContain('/drives/drive-id/root:/Contracts/2026/09/Small.pdf:/content');
    // fail, never replace. The archive is a write-once record and a taken
    // name means a collision or somebody else's file, neither of which is a
    // reason to destroy what is there.
    expect(calls[0].url).toContain('%40microsoft.graph.conflictBehavior=fail');
    expect(calls[0].url).not.toContain('createUploadSession');

    expect(result).toEqual({
      itemId: 'item-id',
      webUrl: 'https://contoso.sharepoint.com/item',
      path: 'Contracts/2026/09/Small.pdf',
    });
  });

  it('never puts the bearer token or the client secret in the upload URL', async () => {
    const { calls, fetchFn } = createGraph(() => jsonResponse(201, { id: 'item-id' }));

    await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: '',
      fileName: 'Small.pdf',
      content: new Uint8Array(16),
      fetchFn,
      sleep: async () => {},
    });

    expect(calls[0].url).not.toContain('client-secret');
    expect(calls[0].url).not.toContain('bearer-token');
    expect(headerOf(calls[0].init, 'Authorization')).toBe('Bearer bearer-token');
  });

  it('sends a 5.4 MB file through an upload session with correct Content-Range headers', async () => {
    const total = 5_400_000;

    expect(total).toBeGreaterThan(SIMPLE_UPLOAD_MAX_BYTES);

    const { calls, fetchFn } = createGraph((call) => {
      if (call.url.endsWith('/createUploadSession')) {
        return jsonResponse(200, {
          uploadUrl: 'https://upload.example/session-1',
        });
      }

      const range = headerOf(call.init, 'Content-Range') ?? '';
      const end = Number(range.split('-')[1]?.split('/')[0]);

      return end === total - 1
        ? jsonResponse(201, {
            id: 'item-id',
            webUrl: 'https://contoso.sharepoint.com/item',
          })
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: 'Contracts/2026/09',
      fileName: 'Large.pdf',
      content: new Uint8Array(total),
      fetchFn,
      sleep: async () => {},
    });

    const sessionCall = calls[0];
    const chunkCalls = calls.slice(1);

    expect(sessionCall.init.method).toBe('POST');
    expect(sessionCall.url).toContain('/root:/Contracts/2026/09/Large.pdf:/createUploadSession');
    expect(String(sessionCall.init.body)).toContain('"@microsoft.graph.conflictBehavior":"fail"');

    expect(chunkCalls).toHaveLength(2);
    expect(chunkCalls.every((call) => call.url === 'https://upload.example/session-1')).toBe(true);

    expect(headerOf(chunkCalls[0].init, 'Content-Range')).toBe(`bytes 0-${UPLOAD_CHUNK_SIZE_BYTES - 1}/${total}`);
    expect(headerOf(chunkCalls[1].init, 'Content-Range')).toBe(
      `bytes ${UPLOAD_CHUNK_SIZE_BYTES}-${total - 1}/${total}`,
    );

    // Every byte is accounted for exactly once, with no chunk exceeding the
    // 320 KiB multiple Graph requires.
    expect(bodyLengthOf(chunkCalls[0].init)).toBe(UPLOAD_CHUNK_SIZE_BYTES);
    expect(bodyLengthOf(chunkCalls[1].init)).toBe(total - UPLOAD_CHUNK_SIZE_BYTES);
    expect(UPLOAD_CHUNK_SIZE_BYTES % (320 * 1024)).toBe(0);

    // The upload URL is pre-authenticated, so the bearer token is not resent.
    expect(headerOf(chunkCalls[0].init, 'Authorization')).toBeUndefined();

    expect(result.itemId).toBe('item-id');
  });

  it('honours Retry-After on a 429 and then succeeds', async () => {
    const waits: number[] = [];

    const { calls, fetchFn } = createGraph((_call, index) =>
      index === 0
        ? jsonResponse(429, { error: { code: 'activityLimitReached' } }, { 'Retry-After': '7' })
        : jsonResponse(201, { id: 'item-id' }),
    );

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: 'Contracts',
      fileName: 'Throttled.pdf',
      content: new Uint8Array(2048),
      fetchFn,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(calls).toHaveLength(2);
    expect(waits).toEqual([7000]);
    expect(result.itemId).toBe('item-id');
  });

  it('honours Retry-After on 503 and 509 as well as 429', async () => {
    for (const status of [503, 509]) {
      clearGraphTokenCache();

      const waits: number[] = [];

      const { calls, fetchFn } = createGraph((_call, index) =>
        index === 0
          ? jsonResponse(status, { error: { code: 'serviceNotAvailable' } }, { 'Retry-After': '3' })
          : jsonResponse(201, { id: 'item-id' }),
      );

      await uploadFileToSharePoint({
        target,
        credentials,
        folderPath: '',
        fileName: 'Retried.pdf',
        content: new Uint8Array(64),
        fetchFn,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });

      expect(calls).toHaveLength(2);
      expect(waits).toEqual([3000]);
    }
  });

  it('resumes a resumable upload from the offset the session still expects', async () => {
    const total = 5_400_000;

    let statusChecks = 0;

    const { calls, fetchFn } = createGraph((call) => {
      if (call.url.endsWith('/createUploadSession')) {
        return jsonResponse(200, {
          uploadUrl: 'https://upload.example/session-1',
        });
      }

      if (call.init.method === 'GET') {
        statusChecks += 1;

        return jsonResponse(200, { nextExpectedRanges: ['0-'] });
      }

      const range = headerOf(call.init, 'Content-Range') ?? '';
      const start = Number(range.replace('bytes ', '').split('-')[0]);
      const end = Number(range.split('-')[1]?.split('/')[0]);

      // Fail the first chunk once, then behave.
      if (start === 0 && statusChecks === 0) {
        return jsonResponse(500, { error: { code: 'generalException' } });
      }

      return end === total - 1
        ? jsonResponse(201, { id: 'item-id' })
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: '',
      fileName: 'Resumed.pdf',
      content: new Uint8Array(total),
      fetchFn,
      sleep: async () => {},
    });

    const ranges = calls
      .filter((call) => call.init.method === 'PUT')
      .map((call) => headerOf(call.init, 'Content-Range'));

    expect(statusChecks).toBe(1);
    expect(ranges).toEqual([
      `bytes 0-${UPLOAD_CHUNK_SIZE_BYTES - 1}/${total}`,
      `bytes 0-${UPLOAD_CHUNK_SIZE_BYTES - 1}/${total}`,
      `bytes ${UPLOAD_CHUNK_SIZE_BYTES}-${total - 1}/${total}`,
    ]);
    expect(result.itemId).toBe('item-id');
  });

  it('throws rather than reporting success when a resumable upload cannot be resumed', async () => {
    const { fetchFn } = createGraph((call) => {
      if (call.url.endsWith('/createUploadSession')) {
        return jsonResponse(200, {
          uploadUrl: 'https://upload.example/session-1',
        });
      }

      if (call.init.method === 'GET') {
        return jsonResponse(404, { error: { code: 'itemNotFound' } });
      }

      return jsonResponse(500, { error: { code: 'generalException' } });
    });

    await expect(
      uploadFileToSharePoint({
        target,
        credentials,
        folderPath: '',
        fileName: 'Doomed.pdf',
        content: new Uint8Array(5_400_000),
        fetchFn,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/could not be resumed/);
  });

  it('throws when a simple upload fails, without echoing the Graph error body', async () => {
    const { fetchFn } = createGraph(() =>
      jsonResponse(403, {
        error: {
          code: 'accessDenied',
          message: 'client-secret leaked into the body',
        },
      }),
    );

    await expect(
      uploadFileToSharePoint({
        target,
        credentials,
        folderPath: '',
        fileName: 'Denied.pdf',
        content: new Uint8Array(32),
        fetchFn,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/status 403 \(code: accessDenied\)/);
  });

  it('adopts the file already at the path when its bytes are the bytes being filed', async () => {
    // A job that uploads and then dies before recording where the file went
    // comes back to a name taken by its own earlier attempt. Refusing that
    // forever would leave the contract unfiled while the library holds it.
    const content = Uint8Array.from({ length: 2048 }, (_, index) => index % 251);

    const { calls, fetchFn } = createGraph((call) => {
      if (call.url === DOWNLOAD_URL) {
        return binaryResponse(content);
      }

      return call.init.method === 'GET'
        ? jsonResponse(200, {
            id: 'existing-item-id',
            webUrl: 'https://contoso.sharepoint.com/existing',
            size: content.byteLength,
            '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
          })
        : jsonResponse(409, { error: { code: 'nameAlreadyExists' } });
    });

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: 'Contracts/2026/09',
      fileName: 'Filed.pdf',
      content,
      fetchFn,
      sleep: async () => {},
    });

    expect(result).toEqual({
      itemId: 'existing-item-id',
      webUrl: 'https://contoso.sharepoint.com/existing',
      path: 'Contracts/2026/09/Filed.pdf',
    });

    // The item is addressed without the trailing colon, which belongs to the
    // `root:/path:/action` form rather than to the item itself.
    expect(calls[1].url).toContain('/root:/Contracts/2026/09/Filed.pdf?');
    expect(calls[1].url).toContain('size');

    // The bytes were read back. Size alone never decides.
    expect(calls[2].url).toBe(DOWNLOAD_URL);
    expect(headerOf(calls[2].init, 'Authorization')).toBeUndefined();
  });

  it('refuses to adopt a file whose bytes differ, even at exactly the same length', async () => {
    // The bug this covers: byte length is not identity. A different contract of
    // the same length, filed here, would be recorded as this one.
    const content = new Uint8Array(2048).fill(7);
    const impostor = new Uint8Array(2048).fill(8);

    const { fetchFn } = createGraph((call) => {
      if (call.url === DOWNLOAD_URL) {
        return binaryResponse(impostor);
      }

      return call.init.method === 'GET'
        ? jsonResponse(200, {
            id: 'somebody-elses-item',
            size: impostor.byteLength,
            '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
          })
        : jsonResponse(409, { error: { code: 'nameAlreadyExists' } });
    });

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: '',
      fileName: 'Taken.pdf',
      content,
      fetchFn,
      sleep: async () => {},
    }).catch((error: Error) => error);

    expect(result).toBeInstanceOf(Error);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    expect((result as Error).message).not.toMatch(/somebody-elses-item/);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    expect((result as Error).message).toMatch(/held by a different file/);
  });

  it('writes under the next candidate name when a different file holds the wanted one', async () => {
    // Without this the same conflict repeats on every sweep and the contract is
    // never filed, with nobody told.
    const content = new Uint8Array(2048).fill(7);
    const impostor = new Uint8Array(2048).fill(8);

    const { fetchFn } = createGraph((call) => {
      if (call.url === DOWNLOAD_URL) {
        return binaryResponse(impostor);
      }

      if (call.init.method === 'GET') {
        return jsonResponse(200, {
          id: 'somebody-elses-item',
          size: impostor.byteLength,
          '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
        });
      }

      return call.url.includes('Taken%20(2).pdf')
        ? jsonResponse(201, {
            id: 'new-item-id',
            webUrl: 'https://contoso.sharepoint.com/new',
          })
        : jsonResponse(409, { error: { code: 'nameAlreadyExists' } });
    });

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: 'Contracts/2026/09',
      fileName: 'Taken.pdf',
      content,
      fetchFn,
      sleep: async () => {},
    });

    expect(result.itemId).toBe('new-item-id');
    // The recorded path is where the bytes went, not where they were wanted.
    expect(result.path).toBe('Contracts/2026/09/Taken (2).pdf');
  });

  it('gives up once every candidate name is held by a different file', async () => {
    const impostor = new Uint8Array(2048).fill(8);

    const { fetchFn } = createGraph((call) => {
      if (call.url === DOWNLOAD_URL) {
        return binaryResponse(impostor);
      }

      return call.init.method === 'GET'
        ? jsonResponse(200, {
            id: 'x',
            size: impostor.byteLength,
            '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
          })
        : jsonResponse(409, { error: { code: 'nameAlreadyExists' } });
    });

    await expect(
      uploadFileToSharePoint({
        target,
        credentials,
        folderPath: '',
        fileName: 'Besieged.pdf',
        content: new Uint8Array(2048).fill(7),
        fetchFn,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/candidate names for Besieged\.pdf is held by a different file/);
  });

  it('fails rather than adopting when Graph offers no way to read the file back', async () => {
    const content = new Uint8Array(2048);

    const { fetchFn } = createGraph((call) =>
      call.init.method === 'GET'
        ? jsonResponse(200, { id: 'unreadable-item', size: content.byteLength })
        : jsonResponse(409, { error: { code: 'nameAlreadyExists' } }),
    );

    await expect(
      uploadFileToSharePoint({
        target,
        credentials,
        folderPath: '',
        fileName: 'NoUrl.pdf',
        content,
        fetchFn,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/no download URL/);
  });

  it('fails rather than adopting when the file cannot be downloaded for comparison', async () => {
    const content = new Uint8Array(2048);

    const { fetchFn } = createGraph((call) => {
      if (call.url === DOWNLOAD_URL) {
        return new Response('', { status: 500 });
      }

      return call.init.method === 'GET'
        ? jsonResponse(200, {
            id: 'item',
            size: content.byteLength,
            '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
          })
        : jsonResponse(409, { error: { code: 'nameAlreadyExists' } });
    });

    await expect(
      uploadFileToSharePoint({
        target,
        credentials,
        folderPath: '',
        fileName: 'Unreadable.pdf',
        content,
        fetchFn,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/could not be downloaded for comparison/);
  });

  it('fails rather than guessing when the file holding the name cannot be read', async () => {
    const { fetchFn } = createGraph((call) =>
      call.init.method === 'GET'
        ? jsonResponse(403, { error: { code: 'accessDenied' } })
        : jsonResponse(409, { error: { code: 'nameAlreadyExists' } }),
    );

    await expect(
      uploadFileToSharePoint({
        target,
        credentials,
        folderPath: '',
        fileName: 'Opaque.pdf',
        content: new Uint8Array(2048),
        fetchFn,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/could not be read \(status 403, code: accessDenied\)/);
  });

  it('adopts an identical file when a resumable upload finds the name taken at commit', async () => {
    // A session evaluates conflictBehavior when it commits, so a large file
    // learns the name is taken on its last chunk rather than at the start.
    const total = 5_400_000;
    const content = new Uint8Array(total).fill(3);

    const { fetchFn } = createGraph((call) => {
      if (call.url === DOWNLOAD_URL) {
        return binaryResponse(content);
      }

      if (call.url.endsWith('/createUploadSession')) {
        return jsonResponse(200, {
          uploadUrl: 'https://upload.example/session-1',
        });
      }

      if (call.init.method === 'GET' && call.url.includes('/root:/')) {
        return jsonResponse(200, {
          id: 'existing-item-id',
          size: total,
          '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
        });
      }

      const range = headerOf(call.init, 'Content-Range') ?? '';
      const end = Number(range.split('-')[1]?.split('/')[0]);

      return end === total - 1
        ? jsonResponse(409, { error: { code: 'nameAlreadyExists' } })
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });

    const result = await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: '',
      fileName: 'Large.pdf',
      content,
      fetchFn,
      sleep: async () => {},
    });

    expect(result.itemId).toBe('existing-item-id');
    expect(result.path).toBe('Large.pdf');
  });

  it('percent-encodes path segments while leaving the separators alone', async () => {
    const { calls, fetchFn } = createGraph(() => jsonResponse(201, { id: 'item-id' }));

    await uploadFileToSharePoint({
      target,
      credentials,
      folderPath: 'Contracts/2026/09',
      fileName: 'Acme & Co - 2026-09-14 - envelope_a.pdf',
      content: new Uint8Array(8),
      fetchFn,
      sleep: async () => {},
    });

    expect(calls[0].url).toContain('/root:/Contracts/2026/09/Acme%20%26%20Co%20-%202026-09-14%20-%20envelope_a.pdf:');
  });
});

describe('parseRetryAfterMs', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfterMs('12', 0)).toBe(12_000);
  });

  it('reads an HTTP date as a delay from now', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');

    expect(parseRetryAfterMs('Mon, 14 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('falls back to a non-zero delay when the header is missing or unreadable', () => {
    expect(parseRetryAfterMs(null, 0)).toBeGreaterThan(0);
    expect(parseRetryAfterMs('soon', 0)).toBeGreaterThan(0);
  });

  it('caps an absurd delay so a worker cannot be pinned for hours', () => {
    expect(parseRetryAfterMs('86400', 0)).toBeLessThanOrEqual(60_000);
  });
});
