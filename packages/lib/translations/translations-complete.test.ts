import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_I18N_OPTIONS, SUPPORTED_LANGUAGE_CODES } from '../constants/locales';

/**
 * Reads a gettext catalog into each msgid and its translations: one for a singular entry, one
 * per form for a plural entry (`msgstr[n]`). Obsolete entries (`#~`) and the header (the empty
 * msgid) are skipped, continuation lines are joined, and CRLF line endings are accepted.
 */
const readCatalog = (text: string) => {
  const entries: { msgid: string; msgstrs: string[] }[] = [];
  let current: { msgid: string; msgstrs: string[] } | null = null;
  let append: ((text: string) => void) | null = null;

  const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
  const unquote = (value: string) => value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c);

  for (const line of text.split(/\r?\n/)) {
    const keyword = /^(msgid|msgid_plural|msgstr(?:\[(\d+)\])?) (".*")$/.exec(line);

    if (keyword) {
      const [, name, index, value] = keyword;
      const text = unquote(value);

      if (name === 'msgid') {
        const entry = { msgid: text, msgstrs: [] as string[] };

        current = entry;
        entries.push(entry);
        append = (more) => {
          entry.msgid += more;
        };
      } else if (current && name === 'msgid_plural') {
        append = null;
      } else if (current) {
        const forms = current.msgstrs;
        const slot = index === undefined ? 0 : Number(index);

        forms[slot] = text;
        append = (more) => {
          forms[slot] += more;
        };
      }

      continue;
    }

    if (append && line.startsWith('"')) {
      append(unquote(line));

      continue;
    }

    append = null;
  }

  return entries.filter((entry) => entry.msgid !== '');
};

const findUntranslated = (text: string) =>
  readCatalog(text)
    .filter(
      (entry) => entry.msgstrs.length === 0 || Array.from(entry.msgstrs).some((form) => !form || form.trim() === ''),
    )
    .map((entry) => entry.msgid);

describe('translation catalogs', () => {
  const offered = SUPPORTED_LANGUAGE_CODES.filter((code) => code !== APP_I18N_OPTIONS.sourceLang);

  it.each(offered)('every message has a %s translation', (code) => {
    const text = fs.readFileSync(path.join(__dirname, code, 'web.po'), 'utf8');

    expect(readCatalog(text).length).toBeGreaterThan(0);
    expect(findUntranslated(text)).toEqual([]);
  });
});

describe('the catalog reader', () => {
  const HEADER = 'msgid ""\nmsgstr ""\n"Language: de\\n"\n\n';

  it('finds an untranslated entry in a CRLF catalog', () => {
    const text = `${HEADER}msgid "Done"\nmsgstr "Fertig"\n\nmsgid "Open"\nmsgstr ""\n`.replace(/\n/g, '\r\n');

    expect(findUntranslated(text)).toEqual(['Open']);
  });

  it('accepts a plural entry with every form and refuses one with a form missing or empty', () => {
    const full = `${HEADER}msgid "file"\nmsgid_plural "files"\nmsgstr[0] "Datei"\nmsgstr[1] "Dateien"\n`;
    const gap = `${HEADER}msgid "file"\nmsgid_plural "files"\nmsgstr[1] "Dateien"\n`;
    const blank = `${HEADER}msgid "file"\nmsgid_plural "files"\nmsgstr[0] "Datei"\nmsgstr[1] ""\n`;

    expect(findUntranslated(full)).toEqual([]);
    expect(findUntranslated(gap)).toEqual(['file']);
    expect(findUntranslated(blank)).toEqual(['file']);
  });

  it('treats a translation of only escaped whitespace as missing', () => {
    expect(findUntranslated(`${HEADER}msgid "Next"\nmsgstr "\\r\\n\\t"\n`)).toEqual(['Next']);
  });

  it('joins continuation lines and skips obsolete entries', () => {
    const text = `${HEADER}msgid ""\n"Long "\n"text"\nmsgstr ""\n"Langer "\n"Text"\n\n#~ msgid "Old"\n#~ msgstr ""\n`;

    expect(findUntranslated(text)).toEqual([]);
  });
});
