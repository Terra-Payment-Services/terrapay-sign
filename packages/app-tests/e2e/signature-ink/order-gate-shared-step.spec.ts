/**
 * Shared signing positions sign in parallel; invitations follow the same rule
 * (decision D6).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * C88, C95, C96) before any fix, without reading the turn helper, the signing
 * loader, send-document or the completion handler. Fixture G: SEQUENTIAL; s1
 * and s2 both at signingOrder 1, s3 at 2, s4 with a null order created after s3;
 * one SIGNATURE field each, written through Prisma. The send goes through API v2
 * `/envelope/distribute` with the owner's token. Emails are counted in Inbucket
 * per recipient mailbox, and as EMAIL_SENT rows of type SIGNING_REQUEST.
 *
 * | Criterion | Test                                                                         |
 * | --------- | ---------------------------------------------------------------------------- |
 * | C88       | C88 the signing page lets s2 in while s1 is unsigned and sends s3 to waiting   |
 * | C88       | C88 V1/V2 s2 signs and completes in s1's step; s3 and s4 wait for their step   |
 * | C88       | C88 TSP copy (AES): s2 waits for s1, the lower id                               |
 * | C95       | C95 V1/V2 first invitation emails s1 and s2 only; TSP copy emails s1 only      |
 * | C96       | C96 next-step invitation after the last member of a step; dictation rule        |
 *
 * C95 and C96 run only through the send and completion routes; the turn rule
 * they test is the same one C88 tests on the sign routes.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, SendStatus, SigningStatus } from '@prisma/client';

import {
  completeWithToken,
  expect2xx,
  expectMailCatcher,
  expectOutOfTurn,
  type G4Seeded,
  readInbox,
  seedFixtureG,
  seedSigned,
  WEBAPP_BASE_URL,
} from '../fixtures/signature-ink';
import {
  distribute,
  inboxCount,
  recipientOf,
  settle,
  signAndComplete,
  signingEmailRows,
  signSig,
} from '../fixtures/signature-ink-order';

test.describe.configure({ mode: 'default' });

const VERSIONS = [1, 2] as const;

const cases = () => {
  const failures: string[] = [];

  return {
    run: async (what: string, body: () => Promise<unknown>) => {
      try {
        await body();
      } catch (error) {
        failures.push(`${what}: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
      }
    },
    assert: (name: string) => expect(failures, `${name}: cases that broke the criterion`).toEqual([]),
  };
};

const premiseFixtureG = async (g: G4Seeded) => {
  const rows = await prisma.recipient.findMany({ where: { envelopeId: g.envelopeId }, orderBy: { id: 'asc' } });

  expect(
    rows.map((row) => [
      row.id === g.r.s1.id ? 's1' : row.id === g.r.s2.id ? 's2' : row.id === g.r.s3.id ? 's3' : 's4',
      row.signingOrder,
    ]),
    'premise: fixture G orders, ids ascending s1 < s2 < s3 < s4',
  ).toEqual([
    ['s1', 1],
    ['s2', 1],
    ['s3', 2],
    ['s4', null],
  ]);
};

// ---------------------------------------------------------------------------
// C88
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`C88 V${version} signing page: s2 is let in while s1 is unsigned, s3 is sent to waiting`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const g = await seedFixtureG(version);
    const c = cases();

    await premiseFixtureG(g);

    await c.run('GET /sign/<s3> redirects to waiting (premise: the page gate is live)', async () => {
      const res = await request.get(`${WEBAPP_BASE_URL}/sign/${g.r.s3.token}`, { maxRedirects: 0 });

      expect(res.status(), 'GET /sign/<s3> answers 302').toBe(302);
      expect(res.headers().location ?? '', 'to /sign/<s3>/waiting').toContain(`/sign/${g.r.s3.token}/waiting`);
    });

    await c.run('GET /sign/<s2> answers 200', async () => {
      const res = await request.get(`${WEBAPP_BASE_URL}/sign/${g.r.s2.token}`, { maxRedirects: 0 });

      expect(res.status(), `GET /sign/<s2> answers 200, not a redirect to ${res.headers().location ?? ''}`).toBe(200);
    });

    // Today the gate orders equal positions without a tiebreak, so whichever of s1 and s2 sorts first is let in
    // and the other is sent to waiting; asking for both makes the red deterministic.
    await c.run('GET /sign/<s1> answers 200', async () => {
      const res = await request.get(`${WEBAPP_BASE_URL}/sign/${g.r.s1.token}`, { maxRedirects: 0 });

      expect(res.status(), `GET /sign/<s1> answers 200, not a redirect to ${res.headers().location ?? ''}`).toBe(200);
    });

    c.assert(`C88 V${version} page`);
  });

  test(`C88 V${version} s2 signs and completes in s1's step; s3 and s4 wait for theirs`, async ({ request }) => {
    test.setTimeout(240_000);

    const g = await seedFixtureG(version);
    const c = cases();

    await premiseFixtureG(g);

    await c.run('s2 signs and completes while s1 NOT_SIGNED', async () => {
      await signAndComplete(request, g, 's2');
    });

    // Let s2's completion land its audit rows and emails so they are not charged to s3's request below.
    await settle();

    await c.run('s3 signs while s1 NOT_SIGNED: out of turn', async () => {
      await expectOutOfTurn(request, g, async () => await signSig(request, g, 's3', 's3', 'S s3'), 's3 signs');
    });

    await c.run('s1 completes', async () => {
      await signAndComplete(request, g, 's1');
    });

    if ((await recipientOf(g, 's2')).signingStatus !== SigningStatus.SIGNED) {
      // s2 was kept out above; let it finish now so the rest of the criterion can run.
      await c.run('s2 completes after s1', async () => {
        expect2xx(await completeWithToken(request, g, g.r.s2.token), 's2 completes after s1');
      });
    }

    await settle();

    await c.run('s4 signs before s3 completed: out of turn', async () => {
      await expectOutOfTurn(request, g, async () => await signSig(request, g, 's4', 's4', 'S s4'), 's4 signs');
    });

    await c.run('s3 signs in turn', async () => {
      const inserted = (await prisma.field.findUniqueOrThrow({ where: { id: g.r.s3.fields.sig.id } })).inserted;

      if (!inserted) {
        expect2xx(await signSig(request, g, 's3', 's3', 'S s3'), 's3 signs in turn');
      }
    });

    // s3 has signed but not completed: s4's step has still not come.
    await c.run('s4 signs after s3 signed, before s3 completed: out of turn', async () => {
      if ((await prisma.field.findUniqueOrThrow({ where: { id: g.r.s4.fields.sig.id } })).inserted) {
        // Inserted by the earlier out-of-turn call, which is already recorded as broken.
        return;
      }

      await expectOutOfTurn(request, g, async () => await signSig(request, g, 's4', 's4', 'S s4'), 's4 signs');
    });

    await c.run('s3 completes', async () => {
      expect2xx(await completeWithToken(request, g, g.r.s3.token), 's3 completes in turn');
      expect((await recipientOf(g, 's3')).signingStatus, 's3 SIGNED').toBe(SigningStatus.SIGNED);
    });

    await c.run('s4 signs after s3 completed', async () => {
      const inserted = (await prisma.field.findUniqueOrThrow({ where: { id: g.r.s4.fields.sig.id } })).inserted;

      expect(inserted, 's4 field not already inserted by the out-of-turn call').toBe(false);
      expect2xx(await signSig(request, g, 's4', 's4', 'S s4'), 's4 signs in turn');
    });

    c.assert(`C88 V${version}`);
  });
}

test('C88 TSP copy (AES): s2 waits for s1, the lower id, in the shared step', async ({ request }) => {
  test.setTimeout(120_000);

  const g = await seedFixtureG(2, { signatureLevel: 'AES' });

  await premiseFixtureG(g);

  const c = cases();

  await c.run('s2 signs while s1 NOT_SIGNED on AES: out of turn', async () => {
    await expectOutOfTurn(request, g, async () => await signSig(request, g, 's2', 's2', 'S s2'), 's2 signs on AES');
  });

  // s1 is marked SIGNED through Prisma: an AES completion needs a signing credential this stack does not have.
  await seedSigned(g, 's1');

  await c.run('control: s2 signs once s1 is SIGNED', async () => {
    const inserted = (await prisma.field.findUniqueOrThrow({ where: { id: g.r.s2.fields.sig.id } })).inserted;

    expect(inserted, 's2 field not already inserted out of turn').toBe(false);
    expect2xx(await signSig(request, g, 's2', 's2', 'S s2'), 's2 signs after s1');
  });

  c.assert('C88 TSP');
});

// ---------------------------------------------------------------------------
// C95
// ---------------------------------------------------------------------------

/** Polls until `key` has `count` messages, or the window passes; returns the last count. */
const waitInbox = async (request: APIRequestContext, g: G4Seeded, key: string, count: number, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  while (Date.now() < deadline) {
    seen = await inboxCount(request, g, key);

    if (seen >= count) {
      return seen;
    }

    await settle(500);
  }

  return seen;
};

const sendStatuses = async (g: G4Seeded) =>
  Object.fromEntries(
    await Promise.all(Object.keys(g.r).map(async (key) => [key, (await recipientOf(g, key)).sendStatus] as const)),
  );

const inboxes = async (request: APIRequestContext, g: G4Seeded) =>
  Object.fromEntries(
    await Promise.all(Object.keys(g.r).map(async (key) => [key, await inboxCount(request, g, key)] as const)),
  );

/** A signing invitation's subject. The completer's "Waiting for others to complete signing" email is not one. */
const INVITATION_SUBJECT = /invited you to sign/i;

/** Every recipient's count of signing invitations in Inbucket (C96 counts invitations only). */
const invitations = async (request: APIRequestContext, g: G4Seeded) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(g.r).map(
        async ([key, recipient]) =>
          [
            key,
            (await readInbox(request, recipient.mailbox)).filter(({ subject }) => INVITATION_SUBJECT.test(subject))
              .length,
          ] as const,
      ),
    ),
  );

for (const version of VERSIONS) {
  test(`C95 V${version} sending fixture G emails s1 and s2 once each, nobody else`, async ({ request }) => {
    test.setTimeout(120_000);

    await expectMailCatcher(request);

    const g = await seedFixtureG(version, { status: DocumentStatus.DRAFT });

    await premiseFixtureG(g);
    expect(await sendStatuses(g), 'premise: nobody sent before distribute').toEqual({
      s1: SendStatus.NOT_SENT,
      s2: SendStatus.NOT_SENT,
      s3: SendStatus.NOT_SENT,
      s4: SendStatus.NOT_SENT,
    });

    expect2xx(await distribute(request, g), 'distribute fixture G');

    // Premise: the catcher sees the first invitation at all.
    expect(await waitInbox(request, g, 's1', 1), 's1 receives its signing email').toBeGreaterThanOrEqual(1);
    await waitInbox(request, g, 's2', 1);
    await settle();

    expect.soft(await inboxes(request, g), 'Inbucket: one signing email to s1 and s2, none to s3 or s4').toEqual({
      s1: 1,
      s2: 1,
      s3: 0,
      s4: 0,
    });
    expect.soft(await sendStatuses(g), 'sendStatus: s1 and s2 SENT, s3 and s4 NOT_SENT').toEqual({
      s1: SendStatus.SENT,
      s2: SendStatus.SENT,
      s3: SendStatus.NOT_SENT,
      s4: SendStatus.NOT_SENT,
    });
  });
}

test('C95 TSP copy (AES): sending fixture G emails s1 only', async ({ request }) => {
  test.setTimeout(120_000);

  await expectMailCatcher(request);

  const g = await seedFixtureG(2, { status: DocumentStatus.DRAFT, signatureLevel: 'AES' });

  await premiseFixtureG(g);
  expect(await sendStatuses(g), 'premise: nobody sent before distribute').toEqual({
    s1: SendStatus.NOT_SENT,
    s2: SendStatus.NOT_SENT,
    s3: SendStatus.NOT_SENT,
    s4: SendStatus.NOT_SENT,
  });

  const sent = await distribute(request, g);

  // This stack runs no signing-credential (CSC) provider, and refuses to send an AES envelope at all.
  test.skip(
    sent.status === 400 && sent.body.includes('CSC_INSTANCE_MODE_MISMATCH'),
    'this instance cannot send AES envelopes (CSC_INSTANCE_MODE_MISMATCH); the TSP half of C95 needs a CSC-mode stack',
  );
  expect2xx(sent, 'distribute the AES copy of fixture G');
  expect(await waitInbox(request, g, 's1', 1), 'premise: s1 receives its signing email').toBeGreaterThanOrEqual(1);
  await settle();

  expect.soft(await inboxes(request, g), 'Inbucket: only s1 emailed on the TSP copy').toEqual({
    s1: 1,
    s2: 0,
    s3: 0,
    s4: 0,
  });
  expect.soft(await sendStatuses(g), 'sendStatus on the TSP copy: s1 SENT, s2, s3 and s4 NOT_SENT').toEqual({
    s1: SendStatus.SENT,
    s2: SendStatus.NOT_SENT,
    s3: SendStatus.NOT_SENT,
    s4: SendStatus.NOT_SENT,
  });
});

// ---------------------------------------------------------------------------
// C96
// ---------------------------------------------------------------------------

test('C96 next-step invitation goes out only when the last member of a step completes', async ({ request }) => {
  test.setTimeout(240_000);

  await expectMailCatcher(request);

  const g = await seedFixtureG(2, { status: DocumentStatus.DRAFT });
  const c = cases();

  expect2xx(await distribute(request, g), 'distribute fixture G');
  await waitInbox(request, g, 's1', 1);
  await waitInbox(request, g, 's2', 1);
  await settle();

  const afterSend = await invitations(request, g);

  await c.run('s1 completes: no new signing email, s3 NOT_SENT', async () => {
    await signAndComplete(request, g, 's1');
    await settle();
    expect(await invitations(request, g), 'no new signing invitation to anyone after s1').toEqual(afterSend);
    expect((await recipientOf(g, 's3')).sendStatus, 's3 still NOT_SENT').toBe(SendStatus.NOT_SENT);
  });

  const afterS1 = await invitations(request, g);

  await c.run('s2 completes: exactly one email to s3, s3 SENT, s4 NOT_SENT', async () => {
    await signAndComplete(request, g, 's2');
    await waitInbox(request, g, 's3', afterS1.s3 + 1);
    await settle();
    expect(await invitations(request, g), 'exactly one new invitation, to s3, and none to anyone else').toEqual({
      ...afterS1,
      s3: afterS1.s3 + 1,
    });
    expect(await signingEmailRows(g, 's3'), 'one SIGNING_REQUEST row for s3').toHaveLength(1);
    expect((await recipientOf(g, 's3')).sendStatus, 's3 SENT').toBe(SendStatus.SENT);
    expect((await recipientOf(g, 's4')).sendStatus, 's4 still NOT_SENT').toBe(SendStatus.NOT_SENT);
  });

  const afterS2 = await invitations(request, g);

  await c.run('s3 completes: exactly one email to s4', async () => {
    await signAndComplete(request, g, 's3');
    await waitInbox(request, g, 's4', afterS2.s4 + 1);
    await settle();
    expect(await invitations(request, g), 'exactly one new invitation, to s4, and none to anyone else').toEqual({
      ...afterS2,
      s4: afterS2.s4 + 1,
    });
    expect(await signingEmailRows(g, 's4'), 'one SIGNING_REQUEST row for s4').toHaveLength(1);
  });

  c.assert('C96 invitations');
});

const DICTATED = { email: 'g4-dictated-next@test.documenso.com', name: 'G4 Dictated' };

/** Every recipient's name and email, by key. */
const identities = async (g: G4Seeded) =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(g.r).map(async (key) => {
        const row = await recipientOf(g, key);

        return [key, { name: row.name, email: row.email }] as const;
      }),
    ),
  );

const recipientUpdatedRows = async (g: G4Seeded) =>
  await prisma.documentAuditLog.count({ where: { envelopeId: g.envelopeId, type: 'RECIPIENT_UPDATED' } });

test('C96 dictation: nextSigner from s1 (step-mate unsigned) is ignored, from s2 renames s3', async ({ request }) => {
  test.setTimeout(240_000);

  const g = await seedFixtureG(2, { status: DocumentStatus.DRAFT, allowDictateNextSigner: true });
  const c = cases();

  expect2xx(await distribute(request, g), 'distribute fixture G with dictation allowed');

  const namesBefore = await identities(g);
  const updatedBefore = await recipientUpdatedRows(g);

  await c.run('s1 dictates while s2 is NOT_SIGNED: ignored', async () => {
    await signAndComplete(request, g, 's1', { nextSigner: DICTATED });

    // Every recipient, not only s3: today's "next single recipient" after s1 is s2.
    expect(await identities(g), 'no recipient renamed').toEqual(namesBefore);
    expect(await recipientUpdatedRows(g), 'no new RECIPIENT_UPDATED row').toBe(updatedBefore);
  });

  await c.run('s2, last of the step, dictates: s3 renamed', async () => {
    const dictated = { email: `g4-dictated-${Date.now()}@test.documenso.com`, name: 'G4 Dictated Two' };
    const namesBeforeS2 = await identities(g);
    const updatedBeforeS2 = await recipientUpdatedRows(g);

    await signAndComplete(request, g, 's2', { nextSigner: dictated });

    expect(await identities(g), 's3 renamed to the dictated signer, nobody else renamed').toEqual({
      ...namesBeforeS2,
      s3: dictated,
    });
    expect(await recipientUpdatedRows(g), 'exactly one new RECIPIENT_UPDATED row').toBe(updatedBeforeS2 + 1);
  });

  c.assert('C96 dictation');
});
