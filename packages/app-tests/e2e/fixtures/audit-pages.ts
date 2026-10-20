import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';

/** pdftotext output without -layout, whitespace untouched, so the form feed between pages survives. */
export const rawPdfText = (bytes: Uint8Array) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pages-'));
  let result: SpawnSyncReturns<string>;

  try {
    const file = path.join(dir, 'audit.pdf');

    fs.writeFileSync(file, bytes);
    result = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (result.status !== 0) {
    throw new Error(`pdftotext failed: ${result.stderr}`);
  }

  return result.stdout;
};

/** The event headings the audit pages print: each audit log type, with spaces for underscores. */
const HEADINGS = new Set(Object.values(DOCUMENT_AUDIT_LOG_TYPE).map((type) => type.replace(/_/g, ' ')));

/** The event headings on one page, each with its first line and the number of lines it wraps over (up to 3). */
const headingsOf = (lines: string[]) => {
  const found: { name: string; at: number; span: number }[] = [];

  for (let at = 0; at < lines.length; at++) {
    const span = [3, 2, 1].find((count) => HEADINGS.has(lines.slice(at, at + count).join(' ')));

    if (span !== undefined) {
      found.push({ name: lines.slice(at, at + span).join(' '), at, span });
      at += span - 1;
    }
  }

  return found;
};

/**
 * One entry of the English audit pages: from its heading to the next event heading on the same
 * page, or to the page's end. Without -layout, pdftotext prints the right-hand column (date, IP
 * ADDRESS) of a page's last entry after USER AGENT and the footer, so the entry cannot end at USER
 * AGENT (#178). Only a real audit event heading, which may wrap, ends an entry; other capitals do
 * not. The match is lexical: a description line that is exactly an event name would also end the
 * entry; descriptions are sentences ("X sent the document"), so the pages do not print one. Throws unless the heading occurs exactly once and the entry has its own USER and IP ADDRESS
 * rows, so a changed layout fails loudly rather than letting negative checks pass on a wrong slice.
 */
export const auditEntry = (raw: string, heading: string) => {
  const pages = raw.split('\f').map((page) => page.split('\n').map((line) => line.trim()));
  const found = pages.flatMap((lines) =>
    headingsOf(lines).flatMap((entry, index, all) =>
      entry.name === heading ? [{ lines, from: entry.at, to: all[index + 1]?.at ?? lines.length }] : [],
    ),
  );

  if (found.length !== 1) {
    throw new Error(`audit pages: expected exactly one "${heading}" entry`);
  }

  const entry = found[0].lines.slice(found[0].from, found[0].to);
  const flat = entry.join(' ').replace(/\s+/g, ' ').trim();

  if (!entry.includes('USER') || !entry.includes('IP ADDRESS')) {
    throw new Error(`audit pages: the "${heading}" entry has no USER or IP ADDRESS row: ${flat}`);
  }

  return { flat, joined: flat.replace(/\s+/g, '') };
};
