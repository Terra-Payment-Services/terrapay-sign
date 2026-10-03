import type { SharePointUploadResult } from '../microsoft-graph/sharepoint-upload';
import { buildArchivePath } from './sharepoint-naming';

/**
 * Core of the SharePoint contract archive.
 *
 * This files a copy. The sealed PDF in object storage stays the system of
 * record, and nothing here ever moves, rewrites or deletes it. SharePoint
 * receives the copy so that the retention, eDiscovery and sensitivity labelling
 * already configured on the library apply to executed contracts as well.
 *
 * Every dependency is injected so the decision logic can be exercised without
 * Graph, object storage, a database or a job runtime. The job handler supplies
 * the real implementations.
 *
 * The properties this holds, in order of how much damage getting them wrong
 * would do:
 *
 *  1. It never fails a signing or sealing flow. It runs after the envelope is
 *     already complete and its result is never consulted by either.
 *  2. Filing is idempotent per document. An item already recorded as filed is
 *     skipped, and every attempt has to win a claim on the item before it may
 *     upload, so the completion trigger and the sweep cannot both send the same
 *     contract to Graph.
 *  3. A failure is recorded against the item and reported to the caller, which
 *     leaves the item unfiled so that the sweep picks it up again. Nothing is
 *     swallowed.
 */

export type ArchivableEnvelopeItem = {
  id: string;
  title: string;
};

export type ArchivableEnvelope = {
  id: string;
  title: string;
  completedAt: Date | null;
  items: ArchivableEnvelopeItem[];
};

export type ExistingEnvelopeArchive = {
  archivedAt: Date | null;
  attempts: number;
  /**
   * Path a previous run committed to when it took the claim. Null only for a
   * row written before this was recorded.
   */
  path?: string | null;
};

export type EnvelopeArchiveLogger = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/**
 * Attempts after which a repeatedly failing item is logged at warning level, so
 * a document that cannot be filed becomes visible without anybody watching for
 * it. Retrying is never abandoned.
 */
const NOISY_ATTEMPT_THRESHOLD = 5;

/**
 * Longest error message kept against an item. A Graph failure carries a status
 * and a code, so anything far beyond this is a stack trace that belongs in the
 * log rather than in a column.
 */
const MAX_RECORDED_ERROR_LENGTH = 500;

export type FileEnvelopeToSharePointOptions = {
  envelope: ArchivableEnvelope;

  /**
   * Folder path template relative to the drive root, supporting `{yyyy}`,
   * `{MM}` and `{dd}`.
   */
  folderPathTemplate: string;

  logger: EnvelopeArchiveLogger;

  /**
   * Read the archive record for one document, or null if it has never been
   * attempted.
   */
  findExistingArchive: (envelopeItemId: string) => Promise<ExistingEnvelopeArchive | null>;

  /**
   * Read the sealed bytes for one document.
   */
  readItemContent: (item: ArchivableEnvelopeItem) => Promise<Uint8Array>;

  /**
   * Write one document into the library.
   */
  uploadFile: (options: {
    folderPath: string;
    fileName: string;
    content: Uint8Array;
  }) => Promise<SharePointUploadResult>;

  /**
   * Take exclusive charge of filing one document, returning false when another
   * run holds it.
   *
   * This is written before the attempt is made, which is what stops a crash
   * mid-upload from leaving no trace, and it is what keeps the completion
   * trigger and the sweep off each other. A losing caller does nothing: the
   * holder is filing the document, and if the holder dies the claim lapses and
   * a later sweep takes it.
   */
  claimForArchive: (options: { envelopeItemId: string; path: string }) => Promise<boolean>;

  /**
   * Record where the document was filed. An item carrying this is never filed
   * again.
   */
  recordSuccess: (options: { envelopeItemId: string; upload: SharePointUploadResult }) => Promise<void>;

  /**
   * Record why filing failed, leaving the item unfiled.
   */
  recordFailure: (options: { envelopeItemId: string; message: string }) => Promise<void>;

  now?: () => Date;
};

export type FileEnvelopeToSharePointResult = {
  /** Documents filed by this run. */
  filed: string[];
  /** Documents a previous run had already filed. */
  alreadyFiled: string[];
  /** Documents another run is filing right now, left for it to finish. */
  claimedElsewhere: string[];
  /** Documents this run could not file, which stay unfiled for the sweep. */
  failed: Array<{ envelopeItemId: string; message: string }>;
};

/**
 * Split a drive-relative path back into the folder and the file name the upload
 * interface asks for.
 */
const splitDrivePath = (path: string): { folderPath: string; fileName: string } => {
  const lastSeparator = path.lastIndexOf('/');

  return lastSeparator === -1
    ? { folderPath: '', fileName: path }
    : { folderPath: path.slice(0, lastSeparator), fileName: path.slice(lastSeparator + 1) };
};

const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);

  return message.slice(0, MAX_RECORDED_ERROR_LENGTH);
};

/**
 * File every document in a completed envelope into SharePoint, skipping those
 * already filed.
 *
 * Documents are handled one at a time rather than in parallel. A contract is
 * several megabytes, and holding a whole multi-document envelope in memory to
 * save a few seconds on a job that nobody is waiting for is a poor trade.
 */
export const fileEnvelopeToSharePoint = async ({
  envelope,
  folderPathTemplate,
  logger,
  findExistingArchive,
  readItemContent,
  uploadFile,
  claimForArchive,
  recordSuccess,
  recordFailure,
  now = () => new Date(),
}: FileEnvelopeToSharePointOptions): Promise<FileEnvelopeToSharePointResult> => {
  const result: FileEnvelopeToSharePointResult = {
    filed: [],
    alreadyFiled: [],
    claimedElsewhere: [],
    failed: [],
  };

  // An envelope that completed before `completedAt` was recorded, or one being
  // filed the moment it completes, still needs a date in its name.
  const completedAt = envelope.completedAt ?? now();

  const isMultiDocument = envelope.items.length > 1;

  for (const item of envelope.items) {
    const existing = await findExistingArchive(item.id);

    if (existing?.archivedAt) {
      result.alreadyFiled.push(item.id);

      continue;
    }

    // A run that already claimed this document recorded the path it committed
    // to, and that path is reused rather than worked out a second time.
    //
    // Two runs can hold one document in sequence: the first takes the claim,
    // takes longer to upload than the lease lasts, and the second takes the
    // claim while the first is still sending bytes. Working the path out again
    // in the second run can give a different answer, because an envelope with
    // no completedAt dates its folder from the clock, so two runs either side
    // of midnight UTC pick two folders. Two paths mean two files, and a name
    // conflict is the only thing that can arbitrate between two runs filing one
    // contract, so two paths means nothing arbitrates. Inheriting the recorded
    // path puts both runs on one name, which the conflict check knows how to
    // settle.
    const { folderPath, fileName, path } = existing?.path
      ? { ...splitDrivePath(existing.path), path: existing.path }
      : buildArchivePath({
          folderPathTemplate,
          envelopeTitle: envelope.title,
          envelopeId: envelope.id,
          completedAt,
          itemTitle: isMultiDocument ? item.title : null,
          // Always, not only for multi-document envelopes. It costs a few
          // characters and it is the only part of the name that cannot collide.
          envelopeItemId: item.id,
        });

    if (existing && existing.attempts >= NOISY_ATTEMPT_THRESHOLD) {
      logger.warn(
        `[sharepoint-archive] Document ${item.id} of envelope ${envelope.id} has failed to file ` +
          `${existing.attempts} times and is still unfiled.`,
      );
    }

    const claimed = await claimForArchive({ envelopeItemId: item.id, path });

    if (!claimed) {
      result.claimedElsewhere.push(item.id);

      logger.info(
        `[sharepoint-archive] Document ${item.id} of envelope ${envelope.id} is being filed by another run, ` +
          'leaving it to finish.',
      );

      continue;
    }

    try {
      const content = await readItemContent(item);

      const upload = await uploadFile({ folderPath, fileName, content });

      await recordSuccess({ envelopeItemId: item.id, upload });

      result.filed.push(item.id);

      logger.info(`[sharepoint-archive] Filed document ${item.id} of envelope ${envelope.id} at ${upload.path}`);
    } catch (error) {
      const message = describeError(error);

      await recordFailure({ envelopeItemId: item.id, message });

      result.failed.push({ envelopeItemId: item.id, message });

      logger.error(`[sharepoint-archive] Failed to file document ${item.id} of envelope ${envelope.id}: ${message}`);
    }
  }

  return result;
};
