import { describe, expect, it } from 'vitest';

import { buildArchiveFolderPath, buildArchivePath, sanitiseSharePointSegment } from './sharepoint-naming';

const completedAt = new Date('2026-09-14T09:30:00.000Z');

/**
 * Every character SharePoint refuses in a name, in one string.
 */
const ILLEGAL = '" * : < > ? / \\ |';

describe('sanitiseSharePointSegment', () => {
  it('removes every illegal character', () => {
    const sanitised = sanitiseSharePointSegment(`Acme${ILLEGAL}Widgets`);

    for (const character of ['"', '*', ':', '<', '>', '?', '/', '\\', '|']) {
      expect(sanitised).not.toContain(character);
    }

    expect(sanitised).toBe('Acme Widgets');
  });

  it('keeps words apart where an illegal character separated them', () => {
    expect(sanitiseSharePointSegment('Master Services Agreement: Schedule 2/3')).toBe(
      'Master Services Agreement Schedule 2 3',
    );
  });

  it('strips leading and trailing spaces', () => {
    expect(sanitiseSharePointSegment('   Padded Title   ')).toBe('Padded Title');
  });

  it('strips trailing full stops, which SharePoint rejects', () => {
    expect(sanitiseSharePointSegment('Amendment No. 3...')).toBe('Amendment No. 3');
  });

  it('strips a leading ~$, which Office treats as a lock file', () => {
    expect(sanitiseSharePointSegment('~$Contract')).toBe('Contract');
  });

  it('removes control characters pasted in from elsewhere', () => {
    // Built from char codes rather than written as escapes, because the
    // formatter rewrites an escape into the literal byte it stands for.
    const pasted = `Line${String.fromCharCode(0)}one${String.fromCharCode(31)}break`;

    expect(sanitiseSharePointSegment(pasted)).toBe('Line one break');
  });

  it('neutralises the reserved _vti_ substring', () => {
    expect(sanitiseSharePointSegment('report_vti_final')).toBe('reportvtifinal');
  });

  it('returns an empty string for a title made entirely of illegal characters', () => {
    expect(sanitiseSharePointSegment(ILLEGAL)).toBe('');
  });
});

describe('buildArchiveFolderPath', () => {
  it('expands the date tokens from the completion date in UTC', () => {
    expect(buildArchiveFolderPath('Contracts/{yyyy}/{MM}', completedAt)).toBe('Contracts/2026/09');
    expect(buildArchiveFolderPath('{yyyy}-{MM}-{dd}', completedAt)).toBe('2026-09-14');
  });

  it('drops empty segments from a sloppy template', () => {
    expect(buildArchiveFolderPath('/Contracts//{yyyy}/', completedAt)).toBe('Contracts/2026');
  });

  it('sanitises each segment independently, leaving the separators alone', () => {
    expect(buildArchiveFolderPath('Cont:racts/{yyyy}', completedAt)).toBe('Cont racts/2026');
  });
});

describe('buildArchivePath', () => {
  it('names a contract from its title, completion date and envelope id', () => {
    const { folderPath, fileName, path } = buildArchivePath({
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      envelopeTitle: 'Master Services Agreement',
      envelopeId: 'envelope_abc123',
      completedAt,
    });

    expect(folderPath).toBe('Contracts/2026/09');
    expect(fileName).toBe('Master Services Agreement - 2026-09-14 - envelope_abc123.pdf');
    expect(path).toBe('Contracts/2026/09/Master Services Agreement - 2026-09-14 - envelope_abc123.pdf');
  });

  it('sanitises illegal characters out of the title', () => {
    const { fileName } = buildArchivePath({
      folderPathTemplate: 'Contracts',
      envelopeTitle: 'Acme/Widgets: "Phase 2" <final>?',
      envelopeId: 'envelope_abc123',
      completedAt,
    });

    expect(fileName).toBe('Acme Widgets Phase 2 final - 2026-09-14 - envelope_abc123.pdf');
  });

  it('distinguishes the documents of a multi-document envelope', () => {
    const first = buildArchivePath({
      folderPathTemplate: 'Contracts',
      envelopeTitle: 'Supply Agreement',
      envelopeId: 'envelope_abc123',
      completedAt,
      itemTitle: 'Schedule A.pdf',
    });

    const second = buildArchivePath({
      folderPathTemplate: 'Contracts',
      envelopeTitle: 'Supply Agreement',
      envelopeId: 'envelope_abc123',
      completedAt,
      itemTitle: 'Schedule B.pdf',
    });

    expect(first.fileName).toBe('Supply Agreement - Schedule A - 2026-09-14 - envelope_abc123.pdf');
    expect(second.fileName).toBe('Supply Agreement - Schedule B - 2026-09-14 - envelope_abc123.pdf');
    expect(first.path).not.toBe(second.path);
  });

  it('falls back to a usable name when the title sanitises away to nothing', () => {
    const { fileName } = buildArchivePath({
      folderPathTemplate: 'Contracts',
      envelopeTitle: ILLEGAL,
      envelopeId: 'envelope_abc123',
      completedAt,
    });

    expect(fileName).toBe('Document - 2026-09-14 - envelope_abc123.pdf');
  });

  it('keeps the path within SharePoint limits by trimming the title, never the envelope id', () => {
    const { path, fileName } = buildArchivePath({
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      envelopeTitle: 'A'.repeat(600),
      envelopeId: 'envelope_abc123',
      completedAt,
    });

    expect(path.length).toBeLessThanOrEqual(380);
    expect(fileName.endsWith(' - 2026-09-14 - envelope_abc123.pdf')).toBe(true);
    expect(fileName.startsWith('A')).toBe(true);
  });

  it('leaves no trailing space where a trimmed title ends on one', () => {
    const { fileName } = buildArchivePath({
      folderPathTemplate: 'Contracts',
      envelopeTitle: `${'A'.repeat(330)} tail`,
      envelopeId: 'envelope_abc123',
      completedAt,
    });

    expect(fileName).not.toContain('  ');
    expect(fileName).toBe(fileName.trim());
  });

  it('is deterministic, which is what stops a repeated filing creating a second file', () => {
    const options = {
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      envelopeTitle: 'Master Services Agreement',
      envelopeId: 'envelope_abc123',
      completedAt,
    };

    expect(buildArchivePath(options).path).toBe(buildArchivePath(options).path);
  });
});

describe('two documents in one envelope', () => {
  const forItem = (itemTitle: string, envelopeItemId: string) =>
    buildArchivePath({
      folderPathTemplate: 'Contracts/{yyyy}/{MM}',
      envelopeTitle: 'Master Services Agreement',
      envelopeId: 'envelope_abc123',
      completedAt: new Date('2026-09-14T10:00:00Z'),
      itemTitle,
      envelopeItemId,
    }).path;

  it('keeps identical titles apart', () => {
    // Nothing stops two documents in one envelope sharing a title, and the
    // upload used to replace on conflict, so the second silently overwrote the
    // first while both rows recorded success.
    expect(forItem('Schedule', 'envelope_item_1')).not.toBe(forItem('Schedule', 'envelope_item_2'));
  });

  it('keeps titles apart that sanitise to the same string', () => {
    expect(forItem('Schedule/A', 'envelope_item_1')).not.toBe(forItem('Schedule:A', 'envelope_item_2'));
  });

  it('keeps titles apart that differ only past the truncation point', () => {
    const long = 'A'.repeat(400);

    expect(forItem(`${long}-one`, 'envelope_item_1')).not.toBe(forItem(`${long}-two`, 'envelope_item_2'));
  });

  it('holds the identity back from the trim, so an over-long title cannot eat it', () => {
    const path = forItem('B'.repeat(500), 'envelope_item_9');

    expect(path).toContain('envelope_abc123');
    expect(path).toContain('envelope_item_9');
  });
});
