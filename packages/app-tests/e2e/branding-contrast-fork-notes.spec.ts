/**
 * FORK.md states what the branding contrast check covers and what it leaves open.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md alone. Criterion 34
 * is about prose, so this reads deployment/public-export/overlay/FORK.md and checks that
 * the paragraph describing the branding stylesheet carries each required statement. The
 * phrase patterns are deliberately loose; each names the fact, not the wording.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 34        | C34 the branding paragraph states the check and its limits            |
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const FORK_MD = path.join(__dirname, '../../../deployment/public-export/overlay/FORK.md');

// biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
test('[BRANDING_CONTRAST]: C34 the branding paragraph states the check and its limits', async ({}, testInfo) => {
  const text = await fs.readFile(FORK_MD, 'utf8');

  // The paragraph (blank-line delimited) that describes the branding stylesheet.
  const paragraph = text.split(/\n\s*\n/).find((p) => /branding stylesheet/i.test(p)) ?? '';
  const prose = paragraph.replace(/\s+/g, ' ');

  await fs.mkdir(testInfo.outputDir, { recursive: true });
  await fs.writeFile(testInfo.outputPath('c34-paragraph.txt'), prose);

  expect(prose, 'premise: FORK.md has a branding stylesheet paragraph').not.toBe('');

  const statements: [string, RegExp][] = [
    ['pairs are checked at 3:1', /3\s*:\s*1/],
    ['in both themes', /(both|light and dark|dark and light) (colour )?(themes|modes)|dark mode/i],
    ['when saved', /sav(ed|es|ing)/i],
    ['and when a page loads', /(page|it) loads|each time .* loads|when .* (rendered|loads)/i],
    ['which token pairs are checked', /muted|primary|foreground/i],
    ['cross-rule combinations remain possible', /(another|other|second|separate) rule|across rules|cross-rule|child/i],
    ['borders, outlines and decorations are not checked', /decoration/i],
    ['a team or organisation admin can do this', /admin/i],
    ['host-supplied embed CSS is not covered', /embed[^.]*(css|stylesheet|styles)|(css|stylesheet|styles)[^.]*embed/i],
  ];

  for (const [fact, pattern] of statements) {
    expect.soft(pattern.test(prose), `FORK.md branding paragraph states: ${fact}`).toBe(true);
  }
});
