import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExistingEnvelopeArchive } from '../archive/file-envelope-to-sharepoint';
import { fileEnvelopeToSharePoint } from '../archive/file-envelope-to-sharepoint';
import type { ArchiveFailures } from './archive-filing';
import { checkArchive } from './archive-filing';

/**
 * The check exists because a configured archive answered ok for two days while
 * every upload failed with a Graph 403. So these tests drive the real filing
 * code against an in-memory store and ask the check what that store says,
 * rather than feeding the check a verdict.
 */

const SETTINGS = {
  NEXT_PRIVATE_SHAREPOINT_TENANT_ID: 'tenant',
  NEXT_PRIVATE_SHAREPOINT_CLIENT_ID: 'client',
  NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET: 'secret',
  NEXT_PRIVATE_SHAREPOINT_SITE_ID: 'site',
  NEXT_PRIVATE_SHAREPOINT_DRIVE_ID: 'drive',
};

const configure = (values: Partial<typeof SETTINGS>) => {
  for (const variable of Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>) {
    const value = values[variable];

    if (value === undefined) {
      delete process.env[variable];
    } else {
      process.env[variable] = value;
    }
  }
};

type Row = ExistingEnvelopeArchive & { lastError?: string; updatedAt: Date };

const GRAPH_403 = 'Microsoft Graph upload failed with status 403 (code: accessDenied)';

/**
 * A store with the archive's semantics, and a reader over it that honours the
 * reader's contract: unfiled documents whose last attempt failed and which
 * have been tried at least `minAttempts` times.
 */
const createArchive = () => {
  const store: Record<string, Row> = {};

  let clock = Date.parse('2026-09-23T09:00:00.000Z');

  const file = async (itemId: string, upload: () => Promise<void>) =>
    await fileEnvelopeToSharePoint({
      envelope: {
        id: `envelope_${itemId}`,
        title: 'Master Services Agreement',
        completedAt: new Date('2026-09-23T08:59:00.000Z'),
        items: [{ id: itemId, title: 'Agreement.pdf' }],
      },
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      findExistingArchive: async (id) => store[id] ?? null,
      readItemContent: async () => new Uint8Array(16),
      uploadFile: async ({ folderPath, fileName }) => {
        await upload();

        return {
          itemId: 'drive-item',
          webUrl: 'https://contoso.sharepoint.com/item',
          path: `${folderPath}/${fileName}`,
        };
      },
      claimForArchive: async ({ envelopeItemId, path }) => {
        clock += 20 * 60_000;

        const current = store[envelopeItemId];

        store[envelopeItemId] = {
          ...current,
          archivedAt: current?.archivedAt ?? null,
          attempts: (current?.attempts ?? 0) + 1,
          path,
          updatedAt: new Date(clock),
        };

        return true;
      },
      recordSuccess: async ({ envelopeItemId }) => {
        store[envelopeItemId] = { ...store[envelopeItemId], archivedAt: new Date(clock), lastError: undefined };
      },
      recordFailure: async ({ envelopeItemId, message }) => {
        store[envelopeItemId] = { ...store[envelopeItemId], lastError: message };
      },
    });

  const readFailures = async (minAttempts: number): Promise<ArchiveFailures> => {
    const rows = Object.values(store)
      .filter((row) => !row.archivedAt && row.lastError && row.attempts >= minAttempts)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const [latest] = rows;

    return {
      failing: rows.length,
      latest: latest ? { lastError: latest.lastError ?? '', attempts: latest.attempts, at: latest.updatedAt } : null,
    };
  };

  return { file, readFailures };
};

const succeed = async () => {};

const forbid = async () => {
  throw new Error(GRAPH_403);
};

describe('checkArchive', () => {
  beforeEach(() => {
    configure(SETTINGS);
  });

  afterEach(() => {
    configure({});
  });

  it('warns and names the Graph error when a configured archive keeps being refused', async () => {
    const archive = createArchive();

    await archive.file('item_1', forbid);
    await archive.file('item_1', forbid);

    const check = await checkArchive(archive.readFailures);

    expect(check.status).toBe('warning');
    expect(check.detail).toContain(GRAPH_403);
    expect(check.detail).toMatch(/^1 completed document/);
  });

  it('counts every document that is failing, and reports the most recent failure', async () => {
    const archive = createArchive();

    for (const item of ['item_1', 'item_2', 'item_3']) {
      await archive.file(item, forbid);
      await archive.file(item, forbid);
    }

    await archive.file('item_3', async () => {
      throw new Error('Microsoft Graph upload failed with status 429 (code: tooManyRequests)');
    });

    const check = await checkArchive(archive.readFailures);

    expect(check.detail).toMatch(/^3 completed document/);
    expect(check.detail).toContain('429');
    expect(check.detail).toContain('after 3 attempts');
  });

  it('is ok after a single failure, which the next sweep normally files', async () => {
    const archive = createArchive();

    await archive.file('item_1', forbid);

    expect((await checkArchive(archive.readFailures)).status).toBe('ok');
  });

  it('returns to ok once a failing document is filed', async () => {
    const archive = createArchive();

    await archive.file('item_1', forbid);
    await archive.file('item_1', forbid);
    await archive.file('item_1', succeed);

    expect((await checkArchive(archive.readFailures)).status).toBe('ok');
  });

  it('is ok when documents are being filed', async () => {
    const archive = createArchive();

    await archive.file('item_1', succeed);
    await archive.file('item_2', succeed);

    expect(await checkArchive(archive.readFailures)).toEqual({
      status: 'ok',
      detail: 'the contract archive is configured and no document is failing to file',
    });
  });

  it('warns without reading any records when the archive is not configured', async () => {
    configure({});

    const readFailures = vi.fn();

    const check = await checkArchive(readFailures);

    expect(check.status).toBe('warning');
    expect(check.detail).toMatch(/not configured/);
    expect(readFailures).not.toHaveBeenCalled();
  });

  it('warns rather than rejects when the records cannot be read, so health never answers 500 for it', async () => {
    const check = await checkArchive(async () => {
      throw new Error('connection refused');
    });

    expect(check.status).toBe('warning');
    expect(check.detail).toContain('connection refused');
  });
});
