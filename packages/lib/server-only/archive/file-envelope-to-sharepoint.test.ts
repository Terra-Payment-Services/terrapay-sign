import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SharePointUploadResult } from '../microsoft-graph/sharepoint-upload';
import type {
  ArchivableEnvelope,
  ExistingEnvelopeArchive,
  FileEnvelopeToSharePointOptions,
} from './file-envelope-to-sharepoint';
import { fileEnvelopeToSharePoint } from './file-envelope-to-sharepoint';
import { getSharePointArchiveConfig, SHAREPOINT_ARCHIVE_UNCONFIGURED_MESSAGE } from './sharepoint-archive-config';

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createEnvelope = (overrides: Partial<ArchivableEnvelope> = {}): ArchivableEnvelope => ({
  id: 'envelope_abc123',
  title: 'Master Services Agreement',
  completedAt: new Date('2026-09-14T09:30:00.000Z'),
  items: [{ id: 'envelope_item_1', title: 'Agreement.pdf' }],
  ...overrides,
});

const uploadResult = (path: string): SharePointUploadResult => ({
  itemId: 'drive-item-id',
  webUrl: 'https://contoso.sharepoint.com/item',
  path,
});

/**
 * Runs the archive against an in-memory store, so that "was it recorded as
 * filed" is answered by the same state the real store would hold rather than by
 * a call count.
 */
const run = async (
  overrides: Partial<FileEnvelopeToSharePointOptions> & {
    envelope?: ArchivableEnvelope;
    existing?: Record<string, ExistingEnvelopeArchive>;
  } = {},
) => {
  const { envelope = createEnvelope(), existing = {}, ...rest } = overrides;

  const store: Record<string, ExistingEnvelopeArchive & { lastError?: string }> = { ...existing };

  const logger = createLogger();

  const readItemContent = vi.fn(async () => new Uint8Array(1024));

  const uploadFile = vi.fn(async ({ folderPath, fileName }: { folderPath: string; fileName: string }) =>
    uploadResult(`${folderPath}/${fileName}`),
  );

  const result = await fileEnvelopeToSharePoint({
    envelope,
    folderPathTemplate: 'Contracts/{yyyy}/{MM}',
    logger,
    findExistingArchive: async (envelopeItemId) => store[envelopeItemId] ?? null,
    readItemContent,
    uploadFile,
    claimForArchive: async ({ envelopeItemId, path }) => {
      const current = store[envelopeItemId];

      store[envelopeItemId] = {
        archivedAt: current?.archivedAt ?? null,
        attempts: (current?.attempts ?? 0) + 1,
        path,
      };

      return true;
    },
    recordSuccess: async ({ envelopeItemId, upload }) => {
      store[envelopeItemId] = {
        ...store[envelopeItemId],
        archivedAt: new Date('2026-09-14T09:31:00.000Z'),
        path: upload.path,
        lastError: undefined,
      };
    },
    recordFailure: async ({ envelopeItemId, message }) => {
      store[envelopeItemId] = { ...store[envelopeItemId], lastError: message };
    },
    ...rest,
  });

  return { result, store, logger, readItemContent, uploadFile };
};

describe('fileEnvelopeToSharePoint', () => {
  it('files a completed document and records where it went', async () => {
    const { result, store, uploadFile } = await run();

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith({
      folderPath: 'Contracts/2026/09',
      // The item id sits beside the envelope id, outside the truncatable part,
      // because two documents in one envelope can otherwise resolve to one name.
      fileName: 'Master Services Agreement - 2026-09-14 - envelope_abc123 - envelope_item_1.pdf',
      content: expect.any(Uint8Array),
    });

    expect(result.filed).toEqual(['envelope_item_1']);
    expect(result.failed).toEqual([]);
    expect(store.envelope_item_1.archivedAt).not.toBeNull();
    expect(store.envelope_item_1.path).toBe(
      'Contracts/2026/09/Master Services Agreement - 2026-09-14 - envelope_abc123 - envelope_item_1.pdf',
    );
  });

  it('does not file a document twice', async () => {
    const { result, uploadFile, readItemContent } = await run({
      existing: {
        envelope_item_1: { archivedAt: new Date('2026-09-14T09:31:00.000Z'), attempts: 1 },
      },
    });

    expect(uploadFile).not.toHaveBeenCalled();
    expect(readItemContent).not.toHaveBeenCalled();
    expect(result.filed).toEqual([]);
    expect(result.alreadyFiled).toEqual(['envelope_item_1']);
  });

  it('files where the first run was filing when a lapsed claim is taken over', async () => {
    // An envelope with no completedAt dates its name from the clock. Two runs
    // either side of a month boundary worked the path out separately and got
    // two answers, so the two uploads could never collide and SharePoint's name
    // conflict, the only thing that can arbitrate between two runs filing one
    // contract, never saw them. One contract, filed twice, in two folders.
    const store: Record<string, ExistingEnvelopeArchive> = {};

    const uploads: string[] = [];

    const envelope = createEnvelope({ completedAt: null });

    const optionsAt = (nowIso: string, uploadFile: FileEnvelopeToSharePointOptions['uploadFile']) => ({
      envelope,
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      logger: createLogger(),
      now: () => new Date(nowIso),
      findExistingArchive: async (envelopeItemId: string) => store[envelopeItemId] ?? null,
      readItemContent: async () => new Uint8Array(8),
      uploadFile,
      claimForArchive: async ({ envelopeItemId, path }: { envelopeItemId: string; path: string }) => {
        store[envelopeItemId] = {
          archivedAt: null,
          attempts: (store[envelopeItemId]?.attempts ?? 0) + 1,
          path,
        };

        return true;
      },
      recordSuccess: async ({ envelopeItemId, upload }: { envelopeItemId: string; upload: SharePointUploadResult }) => {
        store[envelopeItemId] = { ...store[envelopeItemId], archivedAt: new Date(), path: upload.path };
      },
      recordFailure: async () => {},
    });

    // The first run takes the claim on the last evening of the month and then
    // dies inside Graph, leaving the claim to lapse.
    await fileEnvelopeToSharePoint(
      optionsAt('2026-09-30T23:59:30.000Z', async () => {
        throw new Error('connection reset');
      }),
    );

    // The second run takes the lapsed claim a minute later, in the next month.
    await fileEnvelopeToSharePoint(
      optionsAt('2026-10-01T00:00:30.000Z', async ({ folderPath, fileName }) => {
        uploads.push(`${folderPath}/${fileName}`);

        return uploadResult(`${folderPath}/${fileName}`);
      }),
    );

    expect(uploads).toEqual([
      'Contracts/2026/09/Master Services Agreement - 2026-09-30 - envelope_abc123 - envelope_item_1.pdf',
    ]);
  });

  it('works the path out when the existing record carries none', async () => {
    // Rows written before the path was recorded still have to file somewhere.
    const { uploadFile } = await run({
      existing: {
        envelope_item_1: { archivedAt: null, attempts: 2, path: null },
      },
    });

    expect(uploadFile).toHaveBeenCalledWith({
      folderPath: 'Contracts/2026/09',
      fileName: 'Master Services Agreement - 2026-09-14 - envelope_abc123 - envelope_item_1.pdf',
      content: expect.any(Uint8Array),
    });
  });

  it('is idempotent across repeated runs of the same envelope', async () => {
    const uploads: string[] = [];

    const store: Record<string, ExistingEnvelopeArchive> = {};

    const options = {
      envelope: createEnvelope(),
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      logger: createLogger(),
      findExistingArchive: async (envelopeItemId: string) => store[envelopeItemId] ?? null,
      readItemContent: async () => new Uint8Array(8),
      uploadFile: async ({ folderPath, fileName }: { folderPath: string; fileName: string }) => {
        uploads.push(`${folderPath}/${fileName}`);

        return uploadResult(`${folderPath}/${fileName}`);
      },
      claimForArchive: async ({ envelopeItemId }: { envelopeItemId: string }) => {
        store[envelopeItemId] = {
          archivedAt: store[envelopeItemId]?.archivedAt ?? null,
          attempts: (store[envelopeItemId]?.attempts ?? 0) + 1,
        };

        return true;
      },
      recordSuccess: async ({ envelopeItemId }: { envelopeItemId: string }) => {
        store[envelopeItemId] = { ...store[envelopeItemId], archivedAt: new Date() };
      },
      recordFailure: async () => {},
    };

    await fileEnvelopeToSharePoint(options);
    await fileEnvelopeToSharePoint(options);
    await fileEnvelopeToSharePoint(options);

    expect(uploads).toHaveLength(1);
  });

  it('leaves a document unfiled when Graph fails, so the sweep retries it', async () => {
    const { result, store, logger } = await run({
      uploadFile: async () => {
        throw new Error('Microsoft Graph upload failed with status 503 (code: serviceNotAvailable)');
      },
    });

    expect(result.filed).toEqual([]);
    expect(result.failed).toEqual([
      {
        envelopeItemId: 'envelope_item_1',
        message: 'Microsoft Graph upload failed with status 503 (code: serviceNotAvailable)',
      },
    ]);

    expect(store.envelope_item_1.archivedAt).toBeNull();
    expect(store.envelope_item_1.lastError).toContain('503');
    expect(logger.error).toHaveBeenCalled();
  });

  it('records the attempt before uploading, so a crash mid-upload leaves a trace', async () => {
    const seen: Array<number | null> = [];

    await run({
      uploadFile: async () => {
        throw new Error('connection reset');
      },
      claimForArchive: async ({ envelopeItemId }) => {
        seen.push(envelopeItemId === 'envelope_item_1' ? 1 : null);

        return true;
      },
    });

    expect(seen).toEqual([1]);
  });

  it('leaves a document alone when another run holds the claim', async () => {
    const { result, uploadFile, readItemContent } = await run({
      claimForArchive: async () => false,
    });

    expect(uploadFile).not.toHaveBeenCalled();
    expect(readItemContent).not.toHaveBeenCalled();
    expect(result.claimedElsewhere).toEqual(['envelope_item_1']);
    expect(result.filed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('does not upload twice when the sweep starts while a completion run is mid-upload', async () => {
    // The sweep looks for completed documents with no confirmed archive, and an
    // upload in flight is exactly that, so this is the overlap the claim
    // exists for. Both runs are started, the second while the first is still
    // inside Graph.
    const store: Record<string, ExistingEnvelopeArchive & { claimedAt: number | null }> = {};

    const uploads: string[] = [];

    let releaseUpload: (() => void) | null = null;

    const firstUploadStarted = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });

    const claimLeaseMs = 15 * 60 * 1000;

    const options = {
      envelope: createEnvelope(),
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      logger: createLogger(),
      findExistingArchive: async (envelopeItemId: string) => store[envelopeItemId] ?? null,
      readItemContent: async () => new Uint8Array(8),
      // No await before the write, which is what makes the claim atomic here in
      // the same way a conditional update is atomic in the database.
      claimForArchive: async ({ envelopeItemId }: { envelopeItemId: string }) => {
        const current = store[envelopeItemId];

        if (current?.archivedAt) {
          return false;
        }

        if (current?.claimedAt && Date.now() - current.claimedAt < claimLeaseMs) {
          return false;
        }

        store[envelopeItemId] = {
          archivedAt: null,
          attempts: (current?.attempts ?? 0) + 1,
          claimedAt: Date.now(),
        };

        return true;
      },
      uploadFile: async ({ folderPath, fileName }: { folderPath: string; fileName: string }) => {
        uploads.push(`${folderPath}/${fileName}`);

        return uploadResult(`${folderPath}/${fileName}`);
      },
      recordSuccess: async ({ envelopeItemId }: { envelopeItemId: string }) => {
        store[envelopeItemId] = { ...store[envelopeItemId], archivedAt: new Date() };
      },
      recordFailure: async () => {},
    };

    const completionRun = fileEnvelopeToSharePoint({
      ...options,
      uploadFile: async ({ folderPath, fileName }: { folderPath: string; fileName: string }) => {
        uploads.push(`${folderPath}/${fileName}`);

        releaseUpload?.();

        // Hold the upload open long enough for the sweep run to arrive.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        return uploadResult(`${folderPath}/${fileName}`);
      },
    });

    await firstUploadStarted;

    const sweepRun = await fileEnvelopeToSharePoint(options);

    const completion = await completionRun;

    expect(uploads).toHaveLength(1);
    expect(completion.filed).toEqual(['envelope_item_1']);
    expect(sweepRun.claimedElsewhere).toEqual(['envelope_item_1']);
    expect(sweepRun.filed).toEqual([]);
  });

  it('files the documents that succeed even when one of them fails', async () => {
    const envelope = createEnvelope({
      items: [
        { id: 'envelope_item_1', title: 'Schedule A.pdf' },
        { id: 'envelope_item_2', title: 'Schedule B.pdf' },
      ],
    });

    const { result, store } = await run({
      envelope,
      uploadFile: async ({ fileName }: { fileName: string }) => {
        if (fileName.includes('Schedule A')) {
          throw new Error('Microsoft Graph upload failed with status 500 (code: generalException)');
        }

        return uploadResult(fileName);
      },
    });

    expect(result.filed).toEqual(['envelope_item_2']);
    expect(result.failed.map((failure) => failure.envelopeItemId)).toEqual(['envelope_item_1']);
    expect(store.envelope_item_1.archivedAt).toBeNull();
    expect(store.envelope_item_2.archivedAt).not.toBeNull();
  });

  it('warns about a document that has failed repeatedly, and still retries it', async () => {
    const { result, logger } = await run({
      existing: {
        envelope_item_1: { archivedAt: null, attempts: 7 },
      },
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has failed to file 7 times'));
    expect(result.filed).toEqual(['envelope_item_1']);
  });

  it('still names a file when the envelope carries no completion date', async () => {
    const { uploadFile } = await run({
      envelope: createEnvelope({ completedAt: null }),
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        folderPath: 'Contracts/2026/01',
        fileName: 'Master Services Agreement - 2026-01-02 - envelope_abc123 - envelope_item_1.pdf',
      }),
    );
  });
});

describe('getSharePointArchiveConfig', () => {
  const variables = [
    'NEXT_PRIVATE_SHAREPOINT_TENANT_ID',
    'NEXT_PRIVATE_SHAREPOINT_CLIENT_ID',
    'NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET',
    'NEXT_PRIVATE_SHAREPOINT_SITE_ID',
    'NEXT_PRIVATE_SHAREPOINT_DRIVE_ID',
    'NEXT_PRIVATE_SHAREPOINT_FOLDER_TEMPLATE',
    'NEXT_PRIVATE_ENTRA_TENANT_ID',
    'NEXT_PRIVATE_ENTRA_CLIENT_ID',
    'NEXT_PRIVATE_ENTRA_CLIENT_SECRET',
  ] as const;

  const configure = (values: Partial<Record<(typeof variables)[number], string>>) => {
    for (const variable of variables) {
      const value = values[variable];

      if (value === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = value;
      }
    }
  };

  afterEach(() => {
    configure({});
  });

  it('is a no-op when nothing is configured', () => {
    configure({});

    expect(getSharePointArchiveConfig()).toBeNull();
  });

  it('is a no-op when only some of the variables are set', () => {
    configure({
      NEXT_PRIVATE_SHAREPOINT_TENANT_ID: 'tenant',
      NEXT_PRIVATE_SHAREPOINT_CLIENT_ID: 'client',
      NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET: 'secret',
    });

    expect(getSharePointArchiveConfig()).toBeNull();
  });

  it('names every variable an operator has to set', () => {
    for (const variable of [
      'NEXT_PRIVATE_SHAREPOINT_TENANT_ID',
      'NEXT_PRIVATE_SHAREPOINT_CLIENT_ID',
      'NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET',
      'NEXT_PRIVATE_SHAREPOINT_SITE_ID',
      'NEXT_PRIVATE_SHAREPOINT_DRIVE_ID',
    ]) {
      expect(SHAREPOINT_ARCHIVE_UNCONFIGURED_MESSAGE).toContain(variable);
    }
  });

  it('resolves once every variable is set, defaulting the folder template', () => {
    configure({
      NEXT_PRIVATE_SHAREPOINT_TENANT_ID: 'tenant',
      NEXT_PRIVATE_SHAREPOINT_CLIENT_ID: 'client',
      NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET: 'secret',
      NEXT_PRIVATE_SHAREPOINT_SITE_ID: 'site',
      NEXT_PRIVATE_SHAREPOINT_DRIVE_ID: 'drive',
    });

    expect(getSharePointArchiveConfig()).toEqual({
      credentials: { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret' },
      target: { siteId: 'site', driveId: 'drive' },
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
    });
  });

  it('falls back to the Entra app registration when no SharePoint one is named', () => {
    configure({
      NEXT_PRIVATE_ENTRA_TENANT_ID: 'entra-tenant',
      NEXT_PRIVATE_ENTRA_CLIENT_ID: 'entra-client',
      NEXT_PRIVATE_ENTRA_CLIENT_SECRET: 'entra-secret',
      NEXT_PRIVATE_SHAREPOINT_SITE_ID: 'site',
      NEXT_PRIVATE_SHAREPOINT_DRIVE_ID: 'drive',
    });

    expect(getSharePointArchiveConfig()?.credentials).toEqual({
      tenantId: 'entra-tenant',
      clientId: 'entra-client',
      clientSecret: 'entra-secret',
    });
  });

  it('never pairs its own client id with the directory job secret', () => {
    configure({
      NEXT_PRIVATE_ENTRA_TENANT_ID: 'entra-tenant',
      NEXT_PRIVATE_ENTRA_CLIENT_ID: 'entra-client',
      NEXT_PRIVATE_ENTRA_CLIENT_SECRET: 'entra-secret',
      NEXT_PRIVATE_SHAREPOINT_CLIENT_ID: 'sharepoint-client',
      NEXT_PRIVATE_SHAREPOINT_SITE_ID: 'site',
      NEXT_PRIVATE_SHAREPOINT_DRIVE_ID: 'drive',
    });

    expect(getSharePointArchiveConfig()).toBeNull();
  });
});
