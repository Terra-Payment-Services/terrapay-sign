import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { GraphFetchFn, MicrosoftGraphCredentials } from './graph-auth';
import { GRAPH_BASE_URL, getGraphAccessToken, readGraphErrorCode } from './graph-auth';

/**
 * Upload a file into a SharePoint document library over Microsoft Graph.
 *
 * ## Why the application permission must be `Sites.Selected`
 *
 * This host holds executed commercial contracts, and the client secret that
 * drives this code sits in its environment. Granted `Sites.ReadWrite.All`, that
 * one secret would read and rewrite every SharePoint site and every
 * OneDrive-backed library in the tenant, so a leak of the secret, or of the
 * host, would become a route into HR, legal, finance and board material rather
 * than into one archive library. `Sites.Selected` confers nothing on its own:
 * an administrator grants the application `write` on the single target site
 * afterwards, and the blast radius of the secret stays exactly that site. Grant
 * `write` rather than `manage` or `fullcontrol`, because filing a copy never
 * needs to change who can see the library.
 *
 * ## Transfer
 *
 * Graph's simple `PUT .../content` upload is documented for files up to 4 MB.
 * Real contracts here exceed that, so anything above
 * {@link SIMPLE_UPLOAD_MAX_BYTES} goes through `createUploadSession` and is sent
 * as a sequence of `Content-Range` chunks. A chunk that fails is retried against
 * the offset the service says it still expects, rather than being assumed to
 * have landed.
 *
 * Neither the client secret nor the bearer token is ever logged or included in
 * a thrown error message. The upload session URL is also treated as a secret,
 * because it is pre-authenticated and anyone holding it can write the file.
 */

/**
 * Graph documents the simple upload as supporting files up to 4 MB.
 */
export const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Chunk size for a resumable upload. Graph requires a multiple of 320 KiB for
 * every chunk but the last, and recommends 5-10 MiB. This is exactly 16 x 320
 * KiB.
 */
export const UPLOAD_CHUNK_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Statuses Graph uses to say "come back later". 429 is ordinary throttling, 503
 * is the service shedding load, and 509 is a bandwidth-limit response the
 * SharePoint front end returns under sustained large transfers. All three carry
 * `Retry-After` and all three succeed on a later attempt.
 */
const RETRYABLE_STATUSES = new Set([429, 503, 509]);

/**
 * Attempts per individual HTTP request before giving up and letting the job
 * system retry the whole filing later.
 */
const MAX_ATTEMPTS_PER_REQUEST = 5;

/**
 * Used when a throttling response arrives without a usable `Retry-After`.
 */
const DEFAULT_RETRY_DELAY_MS = 5_000;

/**
 * Ceiling on any single wait, so an absurd `Retry-After` cannot pin a worker
 * for hours. The job retries later regardless.
 */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Failed chunks tolerated across one resumable upload before it is abandoned.
 * Counted across the whole transfer rather than per chunk so that a session
 * failing steadily cannot loop indefinitely.
 */
const MAX_CHUNK_FAILURES = 5;

/**
 * What Graph answers when `conflictBehavior=fail` finds the name taken.
 */
const NAME_ALREADY_EXISTS_CODE = 'nameAlreadyExists';

/**
 * Names tried for one file before the filing is abandoned. The first is the
 * name the caller asked for; the rest carry an ordinal, in the way a desktop
 * does it, and exist so that a name held by somebody else's file does not leave
 * a contract unfiled forever with nobody watching. Each candidate is still
 * written with `conflictBehavior=fail`, so nothing is destroyed to make room.
 *
 * Five is a bound rather than a tuning parameter. The wanted name already
 * carries the envelope item id, so one foreign file at that path is a surprise
 * and five is somebody working against us.
 */
const MAX_NAME_CANDIDATES = 5;

/**
 * Raised when the name is taken, so the caller can decide whether the file
 * holding it is this same upload arriving a second time. Internal to this
 * module: the outcome a caller sees is either a result or an `AppError`.
 */
class SharePointNameConflictError extends Error {
  constructor(path: string) {
    super(`Microsoft Graph refused to write ${path} because the name is already taken`);

    this.name = 'SharePointNameConflictError';
  }
}

/**
 * Raised when the name is held by a file whose content has been proved
 * different from the document being filed.
 *
 * Kept apart from {@link SharePointNameConflictError} because the two ask
 * different questions. A conflict asks whether the file sitting there is this
 * upload arriving twice. This one is the answer "no", and the caller responds
 * by writing under a different name rather than by failing, which is what stops
 * the same collision repeating on every sweep until somebody notices.
 */
class SharePointForeignFileError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} is held by a different file: ${reason}`);

    this.name = 'SharePointForeignFileError';
  }
}

export type SharePointTarget = {
  /** Graph site id, in the `hostname,siteCollectionId,siteId` form. */
  siteId: string;
  /** Drive (document library) id within that site. */
  driveId: string;
};

export type SharePointUploadResult = {
  /** DriveItem id of the file as stored. */
  itemId: string;
  /** Browser URL for the file, when Graph returned one. */
  webUrl: string | null;
  /** Drive-relative path the file was written to. */
  path: string;
};

export type UploadFileToSharePointOptions = {
  target: SharePointTarget;
  credentials: MicrosoftGraphCredentials;
  /** Folder path relative to the drive root. May be empty for the root itself. */
  folderPath: string;
  fileName: string;
  content: Uint8Array;
  contentType?: string;
  fetchFn?: GraphFetchFn;
  now?: () => number;
  /** Injected so tests do not spend real time waiting out a throttle. */
  sleep?: (ms: number) => Promise<void>;
};

const ZDriveItemSchema = z.object({
  id: z.string(),
  webUrl: z.string().nullish(),
});

/**
 * The item already sitting at a path, read back when a name conflict has to be
 * settled.
 *
 * `size` is a cheap first test that can only reject. The download URL is what
 * settles it: Graph hands back a pre-authenticated link on the item itself, so
 * the bytes can be compared without a second round trip through the redirect
 * that `/content` answers with.
 */
const ZExistingDriveItemSchema = z.object({
  id: z.string(),
  webUrl: z.string().nullish(),
  size: z.number().nullish(),
  '@microsoft.graph.downloadUrl': z.string().nullish(),
});

const ZUploadSessionSchema = z.object({
  uploadUrl: z.string().min(1),
});

const ZUploadSessionStatusSchema = z.object({
  nextExpectedRanges: z.array(z.string()).nullish(),
});

const defaultSleep = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Join a folder path and a file name into the drive-relative path Graph
 * addresses items by.
 */
export const joinDrivePath = (folderPath: string, fileName: string): string => {
  const folder = folderPath.replace(/^\/+|\/+$/g, '');

  return folder ? `${folder}/${fileName}` : fileName;
};

/**
 * Percent-encode each path segment while leaving the separators intact, so a
 * title containing a space or an ampersand addresses the item Graph actually
 * stored rather than a different one.
 */
const encodeDrivePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/**
 * Translate a `Retry-After` header into a wait in milliseconds.
 *
 * The header is either a count of seconds or an HTTP date. An absent or
 * unreadable value falls back to {@link DEFAULT_RETRY_DELAY_MS} rather than to
 * zero, because retrying a throttled request immediately is what earned the
 * throttle.
 */
export const parseRetryAfterMs = (header: string | null, nowMs: number): number => {
  if (!header) {
    return DEFAULT_RETRY_DELAY_MS;
  }

  const seconds = Number(header.trim());

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }

  const dateMs = Date.parse(header);

  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - nowMs, 0), MAX_RETRY_DELAY_MS);
  }

  return DEFAULT_RETRY_DELAY_MS;
};

type GraphRequestOptions = {
  url: string;
  init: RequestInit;
  fetchFn: GraphFetchFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Issue one Graph request, honouring `Retry-After` on the throttling statuses.
 *
 * Returns the final response whatever its status. Deciding what a non-throttling
 * failure means is left to the caller, because a 404 on an upload session and a
 * 404 on a drive mean different things.
 */
const graphRequestWithRetry = async ({ url, init, fetchFn, now, sleep }: GraphRequestOptions): Promise<Response> => {
  let attempt = 0;

  while (true) {
    const response = await fetchFn(url, init);

    if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_ATTEMPTS_PER_REQUEST - 1) {
      return response;
    }

    const delayMs = parseRetryAfterMs(response.headers.get('Retry-After'), now());

    attempt += 1;

    await sleep(delayMs);
  }
};

const readDriveItem = async (response: Response, context: string, path: string): Promise<SharePointUploadResult> => {
  const parsed = ZDriveItemSchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new AppError(AppErrorCode.SCHEMA_FAILED, {
      message: `Microsoft Graph ${context} response did not match the expected DriveItem shape`,
    });
  }

  return {
    itemId: parsed.data.id,
    webUrl: parsed.data.webUrl ?? null,
    path,
  };
};

type TransferOptions = {
  itemUrl: string;
  path: string;
  content: Uint8Array;
  contentType: string;
  accessToken: string;
  fetchFn: GraphFetchFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Single-request upload, valid for content up to {@link SIMPLE_UPLOAD_MAX_BYTES}.
 */
const uploadSmallFile = async ({
  itemUrl,
  path,
  content,
  contentType,
  accessToken,
  fetchFn,
  now,
  sleep,
}: TransferOptions): Promise<SharePointUploadResult> => {
  const response = await graphRequestWithRetry({
    // fail, not replace. The archive is a write-once record: a name that is
    // already taken means either a collision we did not expect or a file
    // somebody else put there, and destroying it to make room is the one
    // outcome worth preventing at any cost. Graph answers nameAlreadyExists,
    // which the caller reports as a failed filing and the sweep retries, so a
    // genuine duplicate surfaces as an unfiled document rather than as a lost
    // one.
    url: `${itemUrl}/content?%40microsoft.graph.conflictBehavior=fail`,
    init: {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentType,
      },
      body: content,
    },
    fetchFn,
    now,
    sleep,
  });

  if (!response.ok) {
    const code = await readGraphErrorCode(response);

    if (code === NAME_ALREADY_EXISTS_CODE) {
      throw new SharePointNameConflictError(path);
    }

    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: `Microsoft Graph upload failed with status ${response.status} (code: ${code})`,
    });
  }

  return await readDriveItem(response, 'upload', path);
};

/**
 * Read the offset an upload session is still waiting for.
 *
 * Returns null when the session no longer exists, which means the transfer has
 * to start again from a fresh session rather than be resumed.
 */
const readNextExpectedOffset = async (
  uploadUrl: string,
  fetchFn: GraphFetchFn,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<number | null> => {
  const response = await graphRequestWithRetry({
    url: uploadUrl,
    init: { method: 'GET' },
    fetchFn,
    now,
    sleep,
  });

  if (!response.ok) {
    return null;
  }

  const parsed = ZUploadSessionStatusSchema.safeParse(await response.json());

  if (!parsed.success) {
    return null;
  }

  return parseNextExpectedOffset(parsed.data.nextExpectedRanges ?? null);
};

/**
 * Pull the first offset out of a `nextExpectedRanges` collection, which Graph
 * formats as `"start-end"` or `"start-"`.
 */
export const parseNextExpectedOffset = (ranges: string[] | null): number | null => {
  const first = ranges?.[0];

  if (!first) {
    return null;
  }

  const start = Number(first.split('-')[0]);

  return Number.isFinite(start) && start >= 0 ? start : null;
};

/**
 * Abandon an upload session so a half-written file does not sit in the library
 * holding a name. Best effort: a failure here changes nothing that matters and
 * the session expires on its own.
 */
const cancelUploadSession = async (uploadUrl: string, fetchFn: GraphFetchFn): Promise<void> => {
  try {
    await fetchFn(uploadUrl, { method: 'DELETE' });
  } catch {
    // Deliberately ignored.
  }
};

/**
 * Resumable upload for content above {@link SIMPLE_UPLOAD_MAX_BYTES}.
 *
 * Each chunk carries a `Content-Range` of `bytes {start}-{end}/{total}` with
 * inclusive bounds. A 202 means the chunk landed and the service names the next
 * offset it wants; the named offset is believed in preference to the local
 * cursor, because that is how a partially accepted chunk is detected. A failed
 * chunk asks the session where it got to and resumes from there rather than
 * blindly resending.
 *
 * The upload URL is pre-authenticated, so the bearer token is deliberately not
 * sent on these requests.
 */
const uploadLargeFile = async ({
  itemUrl,
  path,
  content,
  contentType,
  accessToken,
  fetchFn,
  now,
  sleep,
}: TransferOptions): Promise<SharePointUploadResult> => {
  const sessionResponse = await graphRequestWithRetry({
    url: `${itemUrl}/createUploadSession`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Same reasoning as the small-file path above: never overwrite.
        item: { '@microsoft.graph.conflictBehavior': 'fail' },
      }),
    },
    fetchFn,
    now,
    sleep,
  });

  if (!sessionResponse.ok) {
    const code = await readGraphErrorCode(sessionResponse);

    if (code === NAME_ALREADY_EXISTS_CODE) {
      throw new SharePointNameConflictError(path);
    }

    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: `Microsoft Graph createUploadSession failed with status ${sessionResponse.status} (code: ${code})`,
    });
  }

  const session = ZUploadSessionSchema.safeParse(await sessionResponse.json());

  if (!session.success) {
    throw new AppError(AppErrorCode.SCHEMA_FAILED, {
      message: 'Microsoft Graph createUploadSession response did not contain an upload URL',
    });
  }

  const { uploadUrl } = session.data;
  const total = content.byteLength;

  let offset = 0;
  let failures = 0;

  while (offset < total) {
    const end = Math.min(offset + UPLOAD_CHUNK_SIZE_BYTES, total) - 1;
    const chunk = content.subarray(offset, end + 1);

    const response = await graphRequestWithRetry({
      url: uploadUrl,
      init: {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.byteLength),
          'Content-Range': `bytes ${offset}-${end}/${total}`,
          'Content-Type': contentType,
        },
        body: chunk,
      },
      fetchFn,
      now,
      sleep,
    });

    if (response.status === 200 || response.status === 201) {
      return await readDriveItem(response, 'resumable upload', path);
    }

    if (response.status === 202) {
      const parsed = ZUploadSessionStatusSchema.safeParse(await response.json().catch(() => ({})));

      const nextOffset = parsed.success ? parseNextExpectedOffset(parsed.data.nextExpectedRanges ?? null) : null;

      offset = nextOffset ?? end + 1;

      continue;
    }

    const code = await readGraphErrorCode(response);

    // A resumable upload evaluates `conflictBehavior` when the session is
    // committed rather than when it is created, so this is where a taken name
    // surfaces on a large file. Retrying the chunk cannot help: the name will
    // still be taken.
    if (code === NAME_ALREADY_EXISTS_CODE) {
      await cancelUploadSession(uploadUrl, fetchFn);

      throw new SharePointNameConflictError(path);
    }

    failures += 1;

    if (failures >= MAX_CHUNK_FAILURES) {
      await cancelUploadSession(uploadUrl, fetchFn);

      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message:
          `Microsoft Graph resumable upload failed ${failures} times, last with status ${response.status} ` +
          `(code: ${code})`,
      });
    }

    const resumeOffset = await readNextExpectedOffset(uploadUrl, fetchFn, now, sleep);

    if (resumeOffset === null) {
      await cancelUploadSession(uploadUrl, fetchFn);

      // The session is gone, so there is nothing left to resume. Throwing hands
      // the retry to the job system, which starts a fresh session later.
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message:
          `Microsoft Graph resumable upload could not be resumed after a chunk failed with status ` +
          `${response.status}`,
      });
    }

    offset = resumeOffset;
  }

  // Every byte was accepted but no final DriveItem came back, so there is no
  // proof the file exists. Treating that as success is the one outcome that
  // would lose a contract quietly.
  throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
    message: 'Microsoft Graph resumable upload sent every chunk without returning the stored item',
  });
};

/**
 * Compare two byte sequences.
 *
 * Written out rather than reached for from a library because the comparison has
 * to be exact and has to stay exact: this is the test that decides whether a
 * file already in the library is recorded as an executed contract.
 */
const contentsAreIdentical = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
};

/**
 * Pull the stored bytes of an item down through its pre-authenticated download
 * URL.
 *
 * The URL Graph hands back is already authorised, so the bearer token is
 * deliberately not sent with it, the same discipline the upload session URL
 * gets a few functions up.
 */
const downloadItemContent = async (
  downloadUrl: string,
  path: string,
  fetchFn: GraphFetchFn,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<Uint8Array> => {
  // The URL arrives from Graph over TLS, so it is trusted, but it is still a
  // host this code did not choose. Refusing anything but https keeps a mangled
  // or downgraded value from turning a comparison into a plaintext fetch.
  if (!downloadUrl.startsWith('https://')) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: `Microsoft Graph returned a non-https download URL for the file already at ${path}`,
    });
  }

  const response = await graphRequestWithRetry({
    url: downloadUrl,
    init: { method: 'GET' },
    fetchFn,
    now,
    sleep,
  });

  if (!response.ok) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message:
        `The file already at ${path} could not be downloaded for comparison (status ${response.status}), ` +
        `so there is no proof of what is stored there`,
    });
  }

  return new Uint8Array(await response.arrayBuffer());
};

/**
 * Read the item already holding a path and decide whether it is this same
 * upload arriving twice.
 *
 * A job that uploads, then dies before recording where the file went, comes
 * back to a name that is taken by its own earlier attempt. With
 * `conflictBehavior=fail` that second attempt is refused, and refusing it
 * forever would leave the document permanently unfiled while the library holds
 * a perfectly good copy. So the file is adopted, but only on proof that its
 * bytes are the bytes being filed.
 *
 * ## Why the bytes, and not a hash
 *
 * Graph publishes `file.hashes` on a DriveItem, and it is tempting. Microsoft
 * documents `sha256Hash` as unsupported, and `sha1Hash` and `crc32Hash` as
 * present only "if available", leaving `quickXorHash` as the one value
 * guaranteed on OneDrive for work or school, which is what backs a SharePoint
 * document library. QuickXorHash is a shift-and-XOR checksum over a 160-bit
 * buffer. It detects accidental corruption and nothing else: constructing a
 * second file with the same value is linear algebra, so a file placed there
 * deliberately would pass. This archive is the legal record of executed
 * contracts, so the test has to hold against somebody who wants it to fail, and
 * only the bytes do that.
 *
 * Size is still read first, because it rejects the ordinary mismatch without
 * moving several megabytes, and a size that matches proves nothing on its own.
 *
 * Content that cannot be compared is a failure and never an adoption. An
 * unreadable item, a missing download URL and a download that will not complete
 * all leave the caller with an error, because recording a contract as archived
 * on the strength of a file nobody has read is the outcome this whole function
 * exists to prevent.
 */
const adoptExistingUpload = async ({
  itemUrl,
  path,
  content,
  accessToken,
  fetchFn,
  now,
  sleep,
}: TransferOptions): Promise<SharePointUploadResult> => {
  // The trailing colon belongs to the `root:/path:/action` form. Reading the
  // item itself addresses it as `root:/path` with nothing after it.
  const metadataUrl = itemUrl.replace(/:$/, '');

  const response = await graphRequestWithRetry({
    url: `${metadataUrl}?$select=id,webUrl,size,@microsoft.graph.downloadUrl`,
    init: {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    fetchFn,
    now,
    sleep,
  });

  if (!response.ok) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message:
        `Microsoft Graph refused to write ${path} because the name is taken, and the item holding it ` +
        `could not be read (status ${response.status}, code: ${await readGraphErrorCode(response)})`,
    });
  }

  const parsed = ZExistingDriveItemSchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new AppError(AppErrorCode.SCHEMA_FAILED, {
      message: `Microsoft Graph returned an unreadable DriveItem for the file already at ${path}`,
    });
  }

  if (parsed.data.size !== content.byteLength) {
    throw new SharePointForeignFileError(
      path,
      `it holds ${parsed.data.size ?? 'an unknown number of'} bytes against the ${content.byteLength} being filed`,
    );
  }

  const downloadUrl = parsed.data['@microsoft.graph.downloadUrl'];

  if (!downloadUrl) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message:
        `Microsoft Graph gave no download URL for the file already at ${path}, so its content could not be ` +
        `compared with the document being filed`,
    });
  }

  const existingContent = await downloadItemContent(downloadUrl, path, fetchFn, now, sleep);

  if (!contentsAreIdentical(existingContent, content)) {
    throw new SharePointForeignFileError(path, 'its content differs from the document being filed');
  }

  return {
    itemId: parsed.data.id,
    webUrl: parsed.data.webUrl ?? null,
    path,
  };
};

/**
 * Add an ordinal to a file name, before the extension, the way a desktop does
 * when a name is taken.
 *
 * The archive path budget stops 20 characters short of SharePoint's own limit,
 * and the longest ordinal this can produce is four characters, so a name that
 * fitted before still fits.
 */
const withNameOrdinal = (fileName: string, ordinal: number): string => {
  const extensionAt = fileName.lastIndexOf('.');

  return extensionAt > 0
    ? `${fileName.slice(0, extensionAt)} (${ordinal})${fileName.slice(extensionAt)}`
    : `${fileName} (${ordinal})`;
};

/**
 * Write a file into a SharePoint document library, choosing the simple or the
 * resumable transfer by size.
 *
 * A name that is already taken is never overwritten. Where the file holding it
 * is byte-for-byte this document, it is adopted as the result, so an upload
 * that landed and then lost its record converges on the one file instead of
 * failing forever. Where it is proved to be a different file, the next
 * candidate name is tried, because a foreign file sitting on the wanted name
 * would otherwise keep the contract unfiled through every retry and every sweep
 * until a person noticed.
 */
export const uploadFileToSharePoint = async ({
  target,
  credentials,
  folderPath,
  fileName,
  content,
  contentType = 'application/pdf',
  fetchFn = fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
}: UploadFileToSharePointOptions): Promise<SharePointUploadResult> => {
  const accessToken = await getGraphAccessToken({ credentials, fetchFn, now });

  const blockedBy: string[] = [];

  for (let candidate = 0; candidate < MAX_NAME_CANDIDATES; candidate += 1) {
    const path = joinDrivePath(folderPath, candidate === 0 ? fileName : withNameOrdinal(fileName, candidate + 1));

    const itemUrl =
      `${GRAPH_BASE_URL}/sites/${encodeURIComponent(target.siteId)}` +
      `/drives/${encodeURIComponent(target.driveId)}/root:/${encodeDrivePath(path)}:`;

    const transfer: TransferOptions = {
      itemUrl,
      path,
      content,
      contentType,
      accessToken,
      fetchFn,
      now,
      sleep,
    };

    try {
      return content.byteLength <= SIMPLE_UPLOAD_MAX_BYTES
        ? await uploadSmallFile(transfer)
        : await uploadLargeFile(transfer);
    } catch (error) {
      if (!(error instanceof SharePointNameConflictError)) {
        throw error;
      }
    }

    try {
      return await adoptExistingUpload(transfer);
    } catch (error) {
      if (!(error instanceof SharePointForeignFileError)) {
        throw error;
      }

      blockedBy.push(error.message);
    }
  }

  throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
    message:
      `Every one of the ${MAX_NAME_CANDIDATES} candidate names for ` +
      `${joinDrivePath(folderPath, fileName)} is held by a different file: ${blockedBy.join('; ')}`,
  });
};
