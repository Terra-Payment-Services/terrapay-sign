import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import linguiConfig from '../../../lingui.config';
import { SUPPORTED_LANGUAGE_CODES } from '../constants/locales';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const catalogPath = (code: string) => path.join(__dirname, code, 'web.po');

/** The committed file of a configured catalog for one locale. */
const configuredCatalogPath = (template: string, code: string) =>
  `${path.resolve(REPO_ROOT, template.replace('<rootDir>', REPO_ROOT).replace('{locale}', code))}.po`;

const configuredCatalogs = linguiConfig.catalogs ?? [];

/**
 * Reads the message keys of a gettext catalog: the context (`msgctxt`, if any) and the msgid, with
 * continuation lines joined, encoded as a JSON pair so that no context and msgid can collide with another
 * msgid. A plural entry is keyed by its singular msgid. Obsolete entries (`#~`)
 * and the header (the empty msgid) are skipped.
 */
const readKeys = (text: string) => {
  const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
  const unquote = (value: string) => value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c);

  const keys = new Set<string>();
  let context: string | null = null;
  let msgid: string | null = null;
  let target: 'msgctxt' | 'msgid' | null = null;

  const flush = () => {
    if (msgid !== null && msgid !== '') {
      keys.add(JSON.stringify([context, msgid]));
    }

    context = null;
    msgid = null;
    target = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const keyword = /^(msgctxt|msgid|msgid_plural|msgstr(?:\[\d+\])?) (".*")$/.exec(line);

    if (keyword) {
      const [, name, value] = keyword;

      if (name === 'msgctxt') {
        flush();
        context = unquote(value);
        target = 'msgctxt';
      } else if (name === 'msgid') {
        if (msgid !== null) {
          flush();
        }

        msgid = unquote(value);
        target = 'msgid';
      } else {
        target = null;
      }

      continue;
    }

    if (target && line.startsWith('"')) {
      if (target === 'msgctxt') {
        context = (context ?? '') + unquote(line);
      } else {
        msgid = (msgid ?? '') + unquote(line);
      }

      continue;
    }

    if (line.trim() === '') {
      flush();
    }
  }

  flush();

  return keys;
};

describe('catalogs match the source (C1)', () => {
  let workDir = '';
  let extracted: Set<string>[] = [];

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingui-extract-'));

    // The temporary config spreads the repo's own lingui.config.ts, so the catalogs, their include and
    // exclude lists and the source locale cannot drift. It extracts only the source locale, and writes
    // catalog i to <workDir>/<i>/<sourceLocale>.po.
    const configPath = path.join(workDir, 'lingui.extract.config.ts');

    fs.writeFileSync(
      configPath,
      [
        `import base from ${JSON.stringify(path.join(REPO_ROOT, 'lingui.config'))};`,
        'export default {',
        '  ...base,',
        `  rootDir: ${JSON.stringify(REPO_ROOT)},`,
        '  locales: [base.sourceLocale],',
        `  catalogs: base.catalogs.map((catalog, i) => ({ ...catalog, path: ${JSON.stringify(workDir)} + '/' + i + '/{locale}' })),`,
        '};',
        '',
      ].join('\n'),
    );

    execFileSync('npx', ['lingui', 'extract', '--config', configPath], {
      cwd: REPO_ROOT,
      // Jiti, which loads the TypeScript config, would otherwise leave a cache outside workDir.
      env: { ...process.env, JITI_FS_CACHE: 'false' },
      stdio: 'pipe',
      timeout: 120_000,
    });

    extracted = configuredCatalogs.map((_, i) =>
      readKeys(fs.readFileSync(path.join(workDir, String(i), `${linguiConfig.sourceLocale}.po`), 'utf8')),
    );
  }, 150_000);

  afterAll(() => {
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('extracts a plausible number of messages from the source', () => {
    expect(configuredCatalogs.length).toBeGreaterThan(0);
    expect(extracted.reduce((total, keys) => total + keys.size, 0)).toBeGreaterThan(1000);
  });

  it.each(SUPPORTED_LANGUAGE_CODES)('%s has every message extracted from the source', (code) => {
    configuredCatalogs.forEach((catalog, i) => {
      const file = configuredCatalogPath(catalog.path, code);
      const present = readKeys(fs.readFileSync(file, 'utf8'));
      const missing = [...extracted[i]].filter((key) => !present.has(key)).sort();

      expect(missing, `${file}: ${missing.length} message(s) missing from the catalog`).toEqual([]);
    });
  });

  it('keys a context and msgid apart from a msgid that spells them out', () => {
    const withContext = readKeys('msgctxt "A"\nmsgid "B"\nmsgstr ""\n');
    const spelledOut = readKeys('msgid "[A] B"\nmsgstr ""\n');

    expect(withContext.size).toBe(1);
    expect(spelledOut.size).toBe(1);
    expect([...withContext].some((key) => spelledOut.has(key))).toBe(false);
  });
});

/** Offsets of every raw control character a catalog must not contain: C0 other than LF (so CR and TAB too), and DEL. */
const findControlBytes = (bytes: Uint8Array) => {
  const found: { offset: number; byte: string }[] = [];

  bytes.forEach((byte, offset) => {
    if ((byte < 0x20 && byte !== 0x0a) || byte === 0x7f) {
      found.push({ offset, byte: `0x${byte.toString(16).padStart(2, '0')}` });
    }
  });

  return found;
};

describe('catalogs hold no control characters (C3)', () => {
  it.each(SUPPORTED_LANGUAGE_CODES)('%s has no raw control character', (code) => {
    const found = findControlBytes(fs.readFileSync(catalogPath(code)));

    expect(found, `${code}/web.po: control bytes at offset`).toEqual([]);
  });

  it('allows LF and escaped sequences, and refuses NUL, CR, TAB and DEL', () => {
    const bytes = (text: string) => Buffer.from(text, 'utf8');

    expect(findControlBytes(bytes('msgid "a\\nb\\r\\0"\nmsgstr "c"\n'))).toEqual([]);
    expect(findControlBytes(bytes('a\u0000b')).map((f) => f.byte)).toEqual(['0x00']);
    expect(findControlBytes(bytes('a\r\nb')).map((f) => f.byte)).toEqual(['0x0d']);
    expect(findControlBytes(bytes('a\tb')).map((f) => f.byte)).toEqual(['0x09']);
    expect(findControlBytes(bytes('a\u007fb')).map((f) => f.byte)).toEqual(['0x7f']);
  });
});

/** Line numbers (1-based) holding a git conflict-marker run: seven `<`, `=` or `>`, at line start or inside a string. */
const findConflictMarkers = (text: string) => {
  const lines: number[] = [];

  text.split(/\r?\n/).forEach((line, index) => {
    if (/<{7}|={7}|>{7}/.test(line)) {
      lines.push(index + 1);
    }
  });

  return lines;
};

/** The msgstr that directly follows the single-line msgid, or null when the msgid is absent. */
const readMsgstr = (text: string, msgid: string) => {
  const lines = text.split(/\r?\n/);
  const index = lines.indexOf(`msgid ${JSON.stringify(msgid)}`);

  if (index === -1) {
    return null;
  }

  const match = /^msgstr "(.*)"$/.exec(lines[index + 1] ?? '');

  return match ? match[1] : null;
};

describe('catalogs hold no conflict markers (C1, C2, C4)', () => {
  it.each(SUPPORTED_LANGUAGE_CODES)('%s has no conflict marker', (code) => {
    const found = findConflictMarkers(fs.readFileSync(catalogPath(code), 'utf8'));

    expect(found, `${code}/web.po: conflict marker at line`).toEqual([]);
  });

  it('refuses the line-start and inline marker forms, and accepts ordinary text', () => {
    expect(findConflictMarkers('a\n<<<<<<< HEAD\nb')).toEqual([2]);
    expect(findConflictMarkers('a\nb\n=======\n')).toEqual([3]);
    expect(findConflictMarkers('>>>>>>> abc\n')).toEqual([1]);
    expect(findConflictMarkers('msgid "x"\nmsgstr "<<<<<<< Updated upstream======="\n')).toEqual([2]);
    expect(findConflictMarkers('msgid "a ====== b < c"\nmsgstr "<"\n')).toEqual([]);
  });
});

describe('fr translates the removed attachment toast (C3)', () => {
  it('has Pièce jointe supprimée avec succès. for Attachment removed successfully.', () => {
    const text = fs.readFileSync(catalogPath('fr'), 'utf8');

    expect(readMsgstr(text, 'Attachment added successfully.')).toBe('Pièce jointe ajoutée avec succès.');
    expect(readMsgstr(text, 'Attachment removed successfully.')).toBe('Pièce jointe supprimée avec succès.');
  });
});
