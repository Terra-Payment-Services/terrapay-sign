/**
 * Branding saved before the check, or by two racing saves, still renders readable.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md alone. Rows are
 * written straight to the database with Prisma, bypassing the save routes, and the
 * signing page and an email are then observed (spec 2.7). The stored row must be left
 * untouched by rendering.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 29        | C29 stored equal pair dropped on render, row unchanged                |
 * | 30        | C30 stored token pairs dropped on render, light and dark              |
 * | 31        | C31 the same token drop applies to email                              |
 * | 31        | C31 control: a readable tenant foreground reaches the email           |
 * | 32, 43    | C32 C43 two saves forced to interleave still render readable text     |
 *
 * C31 stores `{ foreground: '#fefefe' }` rather than 30(a)'s `#ffffff`: white is also the
 * default background in the email, so its absence could not be asserted, while
 * `#fefefe` fails against the light default background the same way (1.01:1) and
 * appears nowhere else. The control proves tenant tokens reach the email at all.
 *
 * C32 as written races `p { color: #000 }` against `{ background: '#111111' }`, but each
 * of those is refused on its own (lone black text fails on the dark default; #111111
 * fails against the default foreground), so the race is never reached. The test keeps
 * that pair and adds one where each half passes alone and only the combination fails:
 * `p { color: #707070 }` (4.7:1 on white, 3.6:1 on the dark default) against
 * a grey palette (since round 22, `{ background: '#9a9a9a', foreground: '#000000', ... }`; it was
 * `#5a5a5a` with white text until the fixed gray-50 surface pairs refused light text),
 * (with dark `card`, `widget`, `popover` and `secondary`, and a light `primary` and `destructive`,
 * since round 22),
 * 1.77:1 together. The black `input` keeps the round 21 background and input pair readable
 * (the default #6e7586 reads 1.7:1 on #9a9a9a and would drop the background on its own).
 *
 * C43 (added after Codex round 1) makes C32 deterministic for the isolating variant (the
 * literal halves are each refused and never write): the test holds a row lock on the
 * organisation's settings while both saves are in flight, and asserts that both were
 * blocked on it before releasing, so neither could see the other's write.
 */
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { type APIRequestContext, expect, test } from '@playwright/test';

import {
  type AdminSession,
  addProbes,
  CANARY_CSS,
  DARK_DEFAULT_TRIPLETS,
  expectCanary,
  hex,
  hslTriplet,
  LIGHT_DEFAULTS,
  type Mode,
  near,
  openAdminSession,
  openSigningPage,
  type Rgba,
  readability,
  readBodyVars,
  readComputed,
  resetBranding,
  type SaveResult,
  saveOrganisationSettings,
  screenshot,
  seedSigningToken,
  waitForLockWaiters,
  writeEvidence,
} from './fixtures/branding-contrast';
import {
  addressFor,
  assertMailCatcherReachable,
  INBUCKET_URL,
  uniqueLocalPart,
  v1Resend,
  waitForMail,
} from './fixtures/send-path';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser, request }, testInfo) => {
  await assertMailCatcherReachable(request);
  admin = await openAdminSession(browser, testInfo, 'render-time');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const storeBranding = async (data: { brandingCss?: string; brandingColors?: Record<string, string> | null }) =>
  await prisma.organisationGlobalSettings.update({
    where: { id: admin.organisationGlobalSettingsId },
    data: { brandingEnabled: true, ...data },
  });

const readRow = async () => {
  const row = await prisma.organisationGlobalSettings.findUniqueOrThrow({
    where: { id: admin.organisationGlobalSettingsId },
  });

  return { brandingCss: row.brandingCss, brandingColors: row.brandingColors };
};

const TOKEN_VARS = { background: '--background', foreground: '--foreground', mutedForeground: '--muted-foreground' };

type TokenName = keyof typeof TOKEN_VARS;

const defaultFor = (token: TokenName, mode: Mode): Rgba =>
  mode === 'light' ? hex(LIGHT_DEFAULTS[token]) : (hslTriplet(DARK_DEFAULT_TRIPLETS[token]) as Rgba);

test.describe('[BRANDING_CONTRAST]: stored branding is checked when a page renders', () => {
  test('C29 stored equal pair dropped on render, row unchanged', async ({ page }, testInfo) => {
    const css = `.g3-c29 { color: #fff; background-color: #fff; }\n${CANARY_CSS}`;

    await storeBranding({ brandingCss: css });

    const before = await readRow();
    const token = await seedSigningToken(admin, 'c29');

    await openSigningPage(page, token, 'light');
    await expectCanary(page);

    const selectors = await addProbes(page, [{ id: 'c29', selector: '.g3-c29', css, expected: 'refused' }]);
    const computed = await readComputed(page, selectors.c29);
    const measured = readability(computed);

    await screenshot(page, testInfo, 'c29');

    const after = await readRow();

    await writeEvidence(testInfo, 'c29', { stored: before, computed, measured, after });

    expect
      .soft(measured.ratio, `c29: computed ${measured.foreground} on ${measured.backgrounds}`)
      .toBeGreaterThanOrEqual(3);
    expect.soft(after, 'c29: rendering leaves the row unchanged').toEqual(before);
  });

  test('C30 stored token pairs dropped on render, light and dark', async ({ page }, testInfo) => {
    const cases: {
      id: string;
      colours: Record<TokenName, string> | Record<string, string>;
      expected: Partial<Record<TokenName, 'default' | string>>;
    }[] = [
      { id: 'a', colours: { foreground: '#ffffff' }, expected: { foreground: 'default' } },
      {
        id: 'b',
        colours: { background: '#111111', foreground: '#111111', mutedForeground: '#ffffff' },
        expected: { background: 'default', foreground: 'default', mutedForeground: 'default' },
      },
      {
        id: 'c',
        // Round 22: dark card, widget, muted, popover and secondary, a light primary, and mid-grey text
        // tokens (#767676, #757575) that read on black and on the fixed gray-50 surface (754b9eda4); round 23
        // moved mutedForeground off #808080, which reads 2.70:1 at the PDF label's 80% over gray-50.
        colours: {
          background: '#000000',
          foreground: '#767676',
          muted: '#222222',
          mutedForeground: '#757575',
          card: '#000000',
          cardForeground: '#ffffff',
          widget: '#000000',
          popover: '#000000',
          popoverForeground: '#ffffff',
          secondary: '#000000',
          secondaryForeground: '#ffffff',
          primary: '#8fb4ff',
          primaryForeground: '#0b1020',
        },
        expected: { background: '#000000', foreground: '#767676', mutedForeground: '#757575' },
      },
    ];

    const evidence: Record<string, unknown> = {};

    for (const c of cases) {
      await resetBranding(admin);
      await storeBranding({ brandingColors: c.colours });

      const before = await readRow();
      const token = await seedSigningToken(admin, `c30-${c.id}`);
      const observed: Record<string, Record<string, string>> = {};

      for (const mode of ['light', 'dark-media'] as Mode[]) {
        await openSigningPage(page, token, mode);

        const vars = await readBodyVars(page, Object.values(TOKEN_VARS));

        observed[mode] = vars;

        for (const [tokenName, want] of Object.entries(c.expected) as [TokenName, string][]) {
          const expectedColour = want === 'default' ? defaultFor(tokenName, mode) : hex(want);
          const actual = vars[TOKEN_VARS[tokenName]];

          expect
            .soft(
              near(hslTriplet(actual), expectedColour),
              `c30(${c.id}) [${mode}]: ${tokenName} is ${actual}, want ${want}`,
            )
            .toBe(true);
        }

        await screenshot(page, testInfo, `c30-${c.id}-${mode}`);
      }

      const after = await readRow();

      expect.soft(after, `c30(${c.id}): rendering leaves the row unchanged`).toEqual(before);

      evidence[c.id] = { stored: before, observed, after };
    }

    await writeEvidence(testInfo, 'c30', evidence);
  });

  const sendInvitationMail = async (request: APIRequestContext, label: string) => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    const localPart = uniqueLocalPart(`g3-${label}`);
    const document = await seedPendingDocument(owner, admin.teamId, [addressFor(localPart)], { internalVersion: 1 });
    const { token } = await createApiToken({
      userId: admin.userId,
      teamId: admin.teamId,
      tokenName: `g3-${label}-${Date.now()}`,
      expiresIn: null,
    });

    const res = await v1Resend(request, token, mapSecondaryIdToDocumentId(document.secondaryId), [
      document.recipients[0].id,
    ]);

    expect(res.ok(), `v1 resend: ${res.status()} ${await res.text()}`).toBe(true);

    const [entry] = await waitForMail(request, localPart, 1);
    // Node fetch, untraced: a trace would record the sender address, which the artifact scan refuses (#176).
    const message = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${localPart}/${entry.id}`);

    expect(message.ok).toBe(true);

    const html = ((await message.json()) as { body?: { html?: string } }).body?.html;

    if (html === undefined) {
      throw new Error('Inbucket message has no body.html');
    }

    return html;
  };

  /** The colour appears in the HTML as hex or as an rgb() triplet. */
  const mentionsColour = (html: string, colour: string) => {
    const { r, g, b } = hex(colour);
    const lowered = html.toLowerCase();

    return (
      lowered.includes(colour.toLowerCase()) || new RegExp(`rgba?\\(\\s*${r}[,\\s]+${g}[,\\s]+${b}\\b`).test(lowered)
    );
  };

  test('C31 control: a readable tenant foreground reaches the email', async ({ request }, testInfo) => {
    await storeBranding({ brandingColors: { background: '#ffffff', foreground: '#123456' } });

    const html = await sendInvitationMail(request, 'c31-control');

    await writeEvidence(testInfo, 'c31-control', { html });

    expect(mentionsColour(html, '#123456'), 'the tenant foreground reaches the email').toBe(true);
  });

  test('C31 the same token drop applies to email', async ({ request }, testInfo) => {
    await storeBranding({ brandingColors: { foreground: '#fefefe' } });

    const html = await sendInvitationMail(request, 'c31');

    await writeEvidence(testInfo, 'c31', { html });

    expect.soft(mentionsColour(html, '#fefefe'), 'the unreadable foreground is not in the email').toBe(false);
    expect.soft(mentionsColour(html, LIGHT_DEFAULTS.foreground), 'the default foreground is').toBe(true);
  });

  test('C32 C43 two saves forced to interleave still render readable text', async ({ page }, testInfo) => {
    const variants = {
      // Each half is refused on its own, so neither writes and there is no window to force.
      literal: { css: 'p { color: #000; }', colours: { background: '#111111' }, forced: false },
      isolating: {
        forced: true,
        css: 'p { color: #707070; }',
        colours: {
          // Round 22 (754b9eda4): light text cannot read on the fixed gray-50 signing surface, so the grey
          // background is lighter (#9a9a9a, on which `p { color: #707070 }` reads 1.77:1) under black text, with
          // light card, muted, widget, popover and secondary set in both themes and a dark destructive.
          background: '#9a9a9a',
          foreground: '#000000',
          mutedForeground: '#000000',
          input: '#000000',
          destructive: '#7a1f1a',
          card: '#ffffff',
          cardForeground: '#000000',
          muted: '#eeeff0',
          widget: '#f6f7f7',
          popover: '#ffffff',
          popoverForeground: '#000000',
          primary: '#213871',
          primaryForeground: '#ffffff',
          secondary: '#eeeff0',
          secondaryForeground: '#213871',
        },
      },
    };

    const evidence: Record<string, unknown> = {};

    for (const [label, variant] of Object.entries(variants)) {
      await resetBranding(admin);

      const fire = () =>
        Promise.all([
          saveOrganisationSettings(admin, { brandingCss: `${variant.css}\n${CANARY_CSS}` }),
          saveOrganisationSettings(admin, { brandingColors: variant.colours }),
        ]);

      let blocked: number | null = null;
      let saves: Promise<[SaveResult, SaveResult]> | undefined;

      if (variant.forced) {
        // Criterion 43: a forced interleaving. The test holds SELECT ... FOR UPDATE on the
        // organisation's settings row from its own connection, fires both saves, and waits
        // until both are blocked on a lock before releasing it, so each save has read the
        // row before either can write it. The number of blocked saves is the probe that
        // the window was hit.
        blocked = await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "OrganisationGlobalSettings" WHERE "id" = ${admin.organisationGlobalSettingsId} FOR UPDATE`;

            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

            saves = fire();

            return await waitForLockWaiters(pid, 2);
          },
          { timeout: 30_000, maxWait: 5_000 },
        );
      } else {
        saves = fire();
      }

      if (!saves) {
        throw new Error('the saves were never fired');
      }

      const [cssSave, tokenSave] = await saves;

      if (variant.forced) {
        expect(blocked, `c43(${label}): probe, both saves were held inside the window`).toBeGreaterThanOrEqual(2);
      }

      const row = await readRow();
      const token = await seedSigningToken(admin, `c32-${label}`);
      const measured: Record<string, unknown> = {};

      for (const mode of ['light', 'dark-media'] as Mode[]) {
        await openSigningPage(page, token, mode);

        const selectors = await addProbes(page, [
          { id: `c32-${label}`, selector: 'p', css: variant.css, expected: 'refused', probe: 'p' },
        ]);
        const computed = await readComputed(page, selectors[`c32-${label}`]);
        const result = readability(computed);

        measured[mode] = { computed, result };

        expect
          .soft(result.ratio, `c32(${label}) [${mode}]: p reads ${result.foreground} on ${result.backgrounds}`)
          .toBeGreaterThanOrEqual(3);

        await screenshot(page, testInfo, `c32-${label}-${mode}`);
      }

      evidence[label] = {
        blockedSaves: blocked,
        cssSave: { status: cssSave.status, body: cssSave.body },
        tokenSave: { status: tokenSave.status, body: tokenSave.body },
        row,
        measured,
      };
    }

    await writeEvidence(testInfo, 'c32', evidence);
  });
});
