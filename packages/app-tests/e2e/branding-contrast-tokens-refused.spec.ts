/**
 * Unreadable branding colour tokens refuse the whole settings save.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md alone. Tokens are
 * saved through `organisation.settings.update`; a refusal is a tRPC error whose body
 * carries the application code `INVALID_BODY` (the code is asserted, not the status),
 * whose message names the failing token, and after which `organisation.get` shows the
 * row exactly as before, stylesheet and colours both (spec 2.5, flag F4).
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 22        | C22 each unreadable or unevaluable token set refused, row unchanged   |
 * | 23        | C23 tokens checked against the stored stylesheet's lone colours       |
 *
 * C23 as written saves `{ background: '#111111' }` alone, which the token rule refuses
 * by itself (1.7:1 against the default foreground), so it cannot show the combination
 * check. The test keeps that case and adds one that isolates it: tokens that pass among
 * themselves (`background: #111111`, `foreground` and `mutedForeground` white, `muted` #222222) are
 * accepted on a row with no stylesheet, and refused on a row whose stored
 * `p { color: #000 }` they would hide. The stored stylesheet is written with Prisma,
 * since a fixed save route would refuse it (lone black text fails on the dark default).
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';

import {
  type AdminSession,
  errorBodyHasCode,
  openAdminSession,
  readOrganisationBranding,
  resetBranding,
  saveOrganisationSettings,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'tokens-refused');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const STORED_CSS = 'p { color: #000; }';

const expectRefused = async (
  label: string,
  colours: Record<string, string>,
  namesToken: string,
  evidence: Record<string, unknown>,
) => {
  const before = await readOrganisationBranding(admin);
  const save = await saveOrganisationSettings(admin, { brandingColors: colours });
  const after = await readOrganisationBranding(admin);

  evidence[label] = { sent: colours, status: save.status, response: save.body, before, after };

  expect.soft(save.status, `${label}: refused, not saved with ${save.status}`).not.toBe(200);
  expect
    .soft(errorBodyHasCode(save.body, 'INVALID_BODY'), `${label}: error code INVALID_BODY: ${save.text.slice(0, 300)}`)
    .toBe(true);
  expect
    .soft(save.text.toLowerCase().includes(namesToken.toLowerCase()), `${label}: the message names ${namesToken}`)
    .toBe(true);
  expect.soft(after, `${label}: the row is unchanged`).toEqual(before);
};

test.describe('[BRANDING_CONTRAST]: unreadable colour tokens refuse the save', () => {
  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  test('C22 each unreadable or unevaluable token set refused, row unchanged', async ({}, testInfo) => {
    const cases: [string, Record<string, string>, string][] = [
      ['equal-pair', { background: '#ffffff', foreground: '#ffffff' }, 'foreground'],
      ['primary-alone', { primary: '#ffcc00' }, 'primary'],
      ['background-alone', { background: '#000000' }, 'background'],
      ['transparent', { foreground: 'transparent' }, 'foreground'],
      ['translucent', { foreground: 'rgba(0,0,0,0.5)' }, 'foreground'],
      ['named', { foreground: 'white' }, 'foreground'],
      ['nonsense', { foreground: 'nonsense' }, 'foreground'],
      ['accent-foreground-alone', { accentForeground: '#e8eefb' }, 'accent'],
    ];

    const evidence: Record<string, unknown> = {};

    for (const [label, colours, namesToken] of cases) {
      await resetBranding(admin);
      await expectRefused(label, colours, namesToken, evidence);
    }

    await writeEvidence(testInfo, 'c22', evidence);
  });

  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  test('C23 tokens checked against the stored stylesheet lone colours', async ({}, testInfo) => {
    // Round 22: dark card, widget, muted, popover and secondary, a light primary, and mid-grey text
    // tokens (#767676) that read on #111111 and on the fixed gray-50 surface (754b9eda4).
    const passing = {
      background: '#111111',
      foreground: '#767676',
      muted: '#222222',
      mutedForeground: '#767676',
      card: '#111111',
      cardForeground: '#ffffff',
      widget: '#111111',
      popover: '#111111',
      popoverForeground: '#ffffff',
      secondary: '#111111',
      secondaryForeground: '#ffffff',
      primary: '#8fb4ff',
      primaryForeground: '#0b1020',
    };
    const evidence: Record<string, unknown> = {};

    // Premise and control: the isolating tokens pass by themselves.
    const control = await saveOrganisationSettings(admin, { brandingColors: passing });

    evidence.control = { sent: passing, status: control.status, response: control.body };

    expect(control.status, `control: these tokens alone are readable and accepted: ${control.text.slice(0, 300)}`).toBe(
      200,
    );

    for (const [label, colours] of Object.entries({ literal: { background: '#111111' }, isolating: passing })) {
      await resetBranding(admin);
      await prisma.organisationGlobalSettings.update({
        where: { id: admin.organisationGlobalSettingsId },
        data: { brandingCss: STORED_CSS },
      });

      await expectRefused(label, colours, 'background', evidence);
    }

    await writeEvidence(testInfo, 'c23', evidence);
  });
});
