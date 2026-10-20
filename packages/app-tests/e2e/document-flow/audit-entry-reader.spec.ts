/**
 * #178 A2: the audit-entry reader finds an entry whole when it is the last
 * entry on its page.
 *
 * Written from the specification (F178 spec.md, criterion A2) and the C26 flake
 * analysis, without reading the fix. No server is needed.
 *
 * pdftotext without -layout emits the right-hand column of the last entry on a
 * page (date, IP ADDRESS) after USER AGENT and after the page footer. The
 * fixture PDF is the sealed document from the failing C26 rerun, in which
 * DOCUMENT DELEGATED OWNER CREATED is the last entry on page 4.
 *
 * Contract for the fix, in e2e/fixtures/audit-pages.ts:
 * - `rawPdfText(bytes)` returns pdftotext output without -layout, whitespace
 *   untouched, so the form feed between pages survives.
 * - `auditEntry(raw, heading)` takes that text and returns `{ flat, joined }`:
 *   the entry from its heading to the end of the entry, whitespace collapsed
 *   (`flat`) and removed (`joined`). The entry ends at the next entry heading on
 *   the same page or at the page's end, whichever comes first, so it holds the
 *   deferred "date IP ADDRESS value" run and nothing from the next entry.
 * - It throws if the heading is absent or occurs more than once (the message
 *   names `exactly one "<heading>"`), and if the entry lacks a USER or an IP
 *   ADDRESS label. An IP ADDRESS of another entry, on the same page or the next,
 *   never counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { auditEntry, rawPdfText } from '../fixtures/audit-pages';

const FIXTURE = path.join(__dirname, '../fixtures/pdfs/c26-delegated-last-on-page.pdf');
const TEAM_EMAIL = 'zelq-team-mvfveyxzt1upvtm4@test.documenso.com';

const fixtureText = () => rawPdfText(new Uint8Array(fs.readFileSync(FIXTURE)));

test.describe('A2 the sealed C26 PDF', () => {
  test('A2 premise: the fixture has DOCUMENT DELEGATED OWNER CREATED last on its page', () => {
    const pages = fixtureText()
      .split('\f')
      .map((p) => p.replace(/\s+/g, ' '));
    const holding = pages.filter((p) => p.includes('DOCUMENT DELEGATED OWNER CREATED'));

    expect(holding, 'premise: one page holds the delegation entry').toHaveLength(1);

    const tail = holding[0].slice(holding[0].indexOf('DOCUMENT DELEGATED OWNER CREATED'));

    expect(tail, 'premise: the entry reads USER, USER AGENT, footer, then IP ADDRESS').toMatch(
      /^DOCUMENT DELEGATED OWNER CREATED .* USER .* USER AGENT .* Envelope ID: \S+ .* IP ADDRESS N\/A $/,
    );
  });

  test('A2 the delegation entry, last on its page, is read whole with IP ADDRESS N/A', () => {
    const entry = auditEntry(fixtureText(), 'DOCUMENT DELEGATED OWNER CREATED');

    expect(entry.flat.startsWith('DOCUMENT DELEGATED OWNER CREATED'), 'the entry starts at its heading').toBe(true);
    expect(entry.flat, 'the entry holds its description').toContain('The document ownership was delegated to');
    expect(entry.flat, 'the entry holds its USER row').toMatch(new RegExp(`USER ${TEAM_EMAIL.replace(/\./g, '\\.')}`));
    expect(entry.flat, 'the entry holds its IP ADDRESS row').toContain('IP ADDRESS N/A');
    expect(entry.flat, 'the entry holds its USER AGENT row').toContain('USER AGENT Chrome');
    expect(entry.joined).toBe(entry.flat.replace(/\s+/g, ''));
  });

  test('A2 an entry in the middle of a page stops before the next entry', () => {
    const created = auditEntry(fixtureText(), 'DOCUMENT CREATED');

    expect(created.flat).toContain('created the document');
    expect(created.flat).toContain('IP ADDRESS N/A');
    expect(created.flat, 'the slice does not run into the next entry').not.toContain(
      'DOCUMENT DELEGATED OWNER CREATED',
    );
    expect(created.flat, 'the slice does not borrow the next entry').not.toContain('ownership was delegated');

    const rejected = auditEntry(fixtureText(), 'DOCUMENT RECIPIENT REJECTED');

    expect(rejected.flat).toContain('rejected the document');
    expect(rejected.flat).toContain('IP ADDRESS N/A');
    expect(rejected.flat, 'the slice does not run into the next entry').not.toContain('EMAIL SENT');
  });

  test('A2 a heading that is absent throws', () => {
    expect(() => auditEntry(fixtureText(), 'DOCUMENT OPENED')).toThrow(/exactly one "DOCUMENT OPENED"/);
  });

  test('A2 a heading that occurs twice throws', () => {
    expect(() => auditEntry(fixtureText(), 'EMAIL SENT')).toThrow(/exactly one "EMAIL SENT"/);
  });
});

/*
 * Planted text in the shape pdftotext gives the audit pages: one entry per
 * heading, labels on their own lines, a footer, and a form feed between pages.
 */
const entryWithIp = (heading: string, description: string) =>
  `${heading}\n${description}\nUSER\nteam@test.documenso.com\n\n10/20/2026, 3:13 AM\n\nIP ADDRESS\nN/A\n\nUSER AGENT\nChrome 141 on Windows\n\n`;

const entryWithoutIp = (heading: string, description: string) =>
  `${heading}\n${description}\nUSER\nteam@test.documenso.com\n\n10/20/2026, 3:13 AM\n\nUSER AGENT\nChrome 141 on Windows\n\n`;

const FOOTER = 'Envelope ID: envelope_planted\n\n';

test.describe('A2 planted text', () => {
  test('A2 planted: the last entry on a page with its IP ADDRESS after the footer is read whole', () => {
    const raw = [
      `Audit Log\n${entryWithIp('EMAIL SENT', 'Team sent an email')}` +
        'DOCUMENT CREATED\nTeam created the document\nUSER\nteam@test.documenso.com\nUSER AGENT\nChrome 141 on Windows\n\n' +
        `${FOOTER}10/20/2026, 3:13 AM\n\nIP ADDRESS\n203.0.113.7\n\n`,
      `Audit Log\n${entryWithIp('DOCUMENT SENT', 'Team sent the document')}${FOOTER}`,
      '',
    ].join('\f');

    const entry = auditEntry(raw, 'DOCUMENT CREATED');

    expect(entry.flat).toContain('IP ADDRESS 203.0.113.7');
    expect(entry.flat).not.toContain('DOCUMENT SENT');
  });

  test('A2 planted: an entry with no IP ADDRESS in the middle of a page throws, though the next entry has one', () => {
    const raw = [
      `Audit Log\n${entryWithoutIp('DOCUMENT CREATED', 'Team created the document')}${entryWithIp('DOCUMENT SENT', 'Team sent the document')}${FOOTER}`,
      '',
    ].join('\f');

    expect(() => auditEntry(raw, 'DOCUMENT CREATED')).toThrow();
  });

  test('A2 planted: the last entry on a page with no IP ADDRESS throws, though the next page has one', () => {
    const raw = [
      `Audit Log\n${entryWithIp('EMAIL SENT', 'Team sent an email')}${entryWithoutIp('DOCUMENT CREATED', 'Team created the document')}${FOOTER}`,
      `Audit Log\n${entryWithIp('DOCUMENT SENT', 'Team sent the document')}${FOOTER}`,
      '',
    ].join('\f');

    expect(() => auditEntry(raw, 'DOCUMENT CREATED')).toThrow();
  });

  test('A2 planted: an entry with no USER row throws', () => {
    const raw = [
      `Audit Log\nDOCUMENT CREATED\nTeam created the document\n\n10/20/2026, 3:13 AM\n\nIP ADDRESS\nN/A\n\n${entryWithIp('DOCUMENT SENT', 'Team sent the document')}${FOOTER}`,
      '',
    ].join('\f');

    expect(() => auditEntry(raw, 'DOCUMENT CREATED')).toThrow();
  });
});

/*
 * r1 contract: an entry ends at the next line (or run of up to 3 lines joined by a space) that equals a
 * real audit event heading; headings may wrap across lines; other all-caps text is never a boundary.
 */
test.describe('A2 planted text: wrapped lines and headings (r1)', () => {
  test('A2 r1: an all-caps description line that is not an event heading does not end the entry', () => {
    const raw = [
      `Audit Log\n${entryWithIp('DOCUMENT CREATED', 'Team created the document for\nACME HOLDINGS\nin the portal')}${FOOTER}`,
      '',
    ].join('\f');

    const entry = auditEntry(raw, 'DOCUMENT CREATED');

    expect(entry.flat).toContain('ACME HOLDINGS in the portal');
    expect(entry.flat).toContain('USER team@test.documenso.com');
    expect(entry.flat).toContain('IP ADDRESS N/A');
  });

  test('A2 r1: a next heading wrapped over two lines ends an entry that lacks IP ADDRESS, so it throws', () => {
    const raw = [
      `Audit Log\n${entryWithoutIp('DOCUMENT CREATED', 'Team created the document')}${entryWithIp('DOCUMENT\nSENT', 'Team sent the document')}${FOOTER}`,
      '',
    ].join('\f');

    expect(() => auditEntry(raw, 'DOCUMENT CREATED')).toThrow();
  });

  test('A2 r1: a next heading wrapped over two lines ends an entry that has IP ADDRESS', () => {
    const raw = [
      `Audit Log\n${entryWithIp('DOCUMENT CREATED', 'Team created the document')}${entryWithIp('DOCUMENT\nSENT', 'Team sent the document')}${FOOTER}`,
      '',
    ].join('\f');

    const entry = auditEntry(raw, 'DOCUMENT CREATED');

    expect(entry.flat).toContain('IP ADDRESS N/A');
    expect(entry.flat, 'the slice does not run into the wrapped next entry').not.toContain('Team sent the document');
    expect(entry.flat).not.toContain('SENT');
  });

  test('A2 r1: a target heading wrapped over two lines is found and read whole', () => {
    const raw = [
      `Audit Log\n${entryWithIp('EMAIL SENT', 'Team sent an email')}${entryWithIp('DOCUMENT DELEGATED OWNER\nCREATED', 'Ownership was delegated to Team')}${FOOTER}`,
      '',
    ].join('\f');

    const entry = auditEntry(raw, 'DOCUMENT DELEGATED OWNER CREATED');

    expect(entry.flat.startsWith('DOCUMENT DELEGATED OWNER CREATED')).toBe(true);
    expect(entry.flat).toContain('Ownership was delegated to Team');
    expect(entry.flat).toContain('USER team@test.documenso.com');
    expect(entry.flat).toContain('IP ADDRESS N/A');
    expect(entry.flat).not.toContain('Team sent an email');
  });

  test('A2 r1: a wrapped target heading counts toward the exactly-one rule', () => {
    const raw = [
      `Audit Log\n${entryWithIp('DOCUMENT DELEGATED OWNER\nCREATED', 'Ownership was delegated to Team')}${entryWithIp('DOCUMENT DELEGATED OWNER CREATED', 'Ownership was delegated to Team B')}${FOOTER}`,
      '',
    ].join('\f');

    expect(() => auditEntry(raw, 'DOCUMENT DELEGATED OWNER CREATED')).toThrow(
      /exactly one "DOCUMENT DELEGATED OWNER CREATED"/,
    );
  });
});
