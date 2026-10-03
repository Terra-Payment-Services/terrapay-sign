import { DateTime } from 'luxon';

/**
 * Names and paths for contracts filed into SharePoint.
 *
 * A filed contract has to be findable by somebody browsing the library, not
 * only by something querying the database, so the name is built from the
 * envelope title, the completion date and the envelope id rather than from an
 * opaque storage key. The envelope id is kept last and never truncated: it is
 * what ties the copy in SharePoint back to the record of signature here, and it
 * is what makes two contracts of the same name in the same month distinct.
 */

/**
 * Characters SharePoint rejects outright in a file or folder name.
 */
const ILLEGAL_CHARACTERS = /["*:<>?/\\|]/g;

/**
 * Replace control characters with spaces.
 *
 * They survive a copy-paste into a document title and break the Graph path when
 * they do. This is written as a character-code test rather than a regular
 * expression because the escapes for these code points do not survive the
 * formatter, which rewrites them into the literal bytes they stand for.
 */
const isControlCharacter = (code: number): boolean => code < 0x20 || code === 0x7f;

const stripControlCharacters = (value: string): string =>
  value
    .split('')
    .map((character) => (isControlCharacter(character.charCodeAt(0)) ? ' ' : character))
    .join('');

/**
 * SharePoint reserves this substring anywhere in a name.
 */
const RESERVED_SUBSTRING = /_vti_/gi;

/**
 * SharePoint's limit for a full decoded URL path is 400 characters. The budget
 * below leaves room for the site and library prefix that SharePoint adds in
 * front of the drive-relative path this code controls.
 */
export const SHAREPOINT_MAX_PATH_LENGTH = 400;

const ARCHIVE_MAX_PATH_LENGTH = 380;

/**
 * Used when a title sanitises away to nothing, which a title made entirely of
 * illegal characters does.
 */
const FALLBACK_TITLE = 'Document';

/**
 * Strip everything SharePoint refuses from one path segment.
 *
 * Illegal characters become spaces rather than disappearing, so `Acme/Widgets`
 * reads as `Acme Widgets` instead of `AcmeWidgets`. Leading and trailing spaces
 * and trailing full stops are removed because SharePoint rejects a name with
 * either, and a leading `~$` is removed because Office treats such a name as a
 * lock file.
 */
export const sanitiseSharePointSegment = (value: string): string =>
  stripControlCharacters(value)
    .replace(ILLEGAL_CHARACTERS, ' ')
    .replace(RESERVED_SUBSTRING, 'vti')
    .replace(/\s+/g, ' ')
    .replace(/^~\$/, '')
    .replace(/\.+$/, '')
    .trim();

export type BuildArchivePathOptions = {
  /**
   * Folder path template relative to the drive root. Supports the tokens
   * `{yyyy}`, `{MM}` and `{dd}`, taken from the completion date in UTC.
   */
  folderPathTemplate: string;
  envelopeTitle: string;
  envelopeId: string;
  completedAt: Date;
  /**
   * Title of the individual document within the envelope. Included only when
   * an envelope holds more than one, where it helps a human tell them apart.
   */
  itemTitle?: string | null;
  /**
   * Identifier of the individual document within the envelope.
   *
   * This is what actually keeps two documents in one envelope from colliding.
   * The title cannot: two items may share one, or sanitise to the same string
   * ("Schedule/A" and "Schedule:A"), or differ only past the point where an
   * over-long title is truncated. All three produced one path for two
   * documents, and the upload replaces on conflict, so the second silently
   * overwrote the first while both rows recorded success.
   */
  envelopeItemId?: string | null;
};

export type ArchivePath = {
  folderPath: string;
  fileName: string;
  path: string;
};

/**
 * Expand the folder template against the completion date and sanitise every
 * segment it produces.
 */
export const buildArchiveFolderPath = (folderPathTemplate: string, completedAt: Date): string => {
  const completed = DateTime.fromJSDate(completedAt, { zone: 'utc' });

  const expanded = folderPathTemplate
    .replaceAll('{yyyy}', completed.toFormat('yyyy'))
    .replaceAll('{MM}', completed.toFormat('MM'))
    .replaceAll('{dd}', completed.toFormat('dd'));

  return expanded
    .split('/')
    .map((segment) => sanitiseSharePointSegment(segment))
    .filter((segment) => segment.length > 0)
    .join('/');
};

/**
 * Build the folder, file name and full drive-relative path for one archived
 * document.
 *
 * When the result would exceed the path budget it is the title that gives way,
 * trimmed from the right. The date and the envelope id are held back from the
 * trim so that an over-long title degrades into something still traceable
 * rather than into something ambiguous.
 */
export const buildArchivePath = ({
  folderPathTemplate,
  envelopeTitle,
  envelopeId,
  completedAt,
  itemTitle,
  envelopeItemId,
}: BuildArchivePathOptions): ArchivePath => {
  const folderPath = buildArchiveFolderPath(folderPathTemplate, completedAt);

  const dateStamp = DateTime.fromJSDate(completedAt, { zone: 'utc' }).toFormat('yyyy-MM-dd');

  // The item id joins the envelope id in the part held back from truncation,
  // so uniqueness never depends on the title surviving the trim.
  const identity = [envelopeId, envelopeItemId]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map((part) => sanitiseSharePointSegment(part))
    .join(' - ');

  const tail = ` - ${dateStamp} - ${identity}.pdf`;

  // Strip any extension the stored title carries, so a title of "Msa.pdf" does
  // not produce "Msa.pdf - 2026-09-14 - envelope_x.pdf".
  const itemName = itemTitle ? sanitiseSharePointSegment(itemTitle.replace(/\.pdf$/i, '')) : '';

  const head =
    [sanitiseSharePointSegment(envelopeTitle), itemName].filter((part) => part.length > 0).join(' - ') ||
    FALLBACK_TITLE;

  const budget = ARCHIVE_MAX_PATH_LENGTH - (folderPath ? folderPath.length + 1 : 0);

  const available = Math.max(0, budget - tail.length);

  const trimmedHead = head.length > available ? sanitiseSharePointSegment(head.slice(0, available)) : head;

  const fileName = `${trimmedHead}${tail}`.trim();

  return {
    folderPath,
    fileName,
    path: folderPath ? `${folderPath}/${fileName}` : fileName,
  };
};
