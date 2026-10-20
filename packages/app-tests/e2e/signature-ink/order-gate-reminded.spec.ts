/**
 * A recipient reminded before their turn is still invited when it comes, once (G4 C109b).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md, "C109 ruling and
 * C109b") before the fix. A reminder (API v2 /document/redistribute, which checks no turn) marks a later signer
 * SENT; the completion that opens their step must still queue their turn invitation. Invitations are counted as
 * send.signing.requested.email jobs for the recipient (a reminder is sent directly, without that job). Fixture G:
 * SEQUENTIAL, s1 and s2 at order 1, s3 at 2, s4 with no order; distributed through API v2.
 *
 * | Criterion | Test                                                                                     |
 * | --------- | ---------------------------------------------------------------------------------------- |
 * | C109b     | C109b reminded before their turn, s3 and then s4 are each invited once when their step comes |
 * | C109b     | C109b two concurrent completions of a shared step invite a reminded next signer once       |
 * | C109b     | dictation after a reminder renames and invites once: C109 in next-recipient-dictation.spec.ts |
 * | C109b     | C109b two concurrent completions of a shared step, each dictating: s3 is renamed and invited once |
 */

import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { DocumentStatus, SendStatus } from '@prisma/client';

import { JOB, jobsFor } from '../fixtures/reject-seal';
import { completeWithToken, expect2xx, type G4Seeded, seedFixtureG, v2Api } from '../fixtures/signature-ink';
import { distribute, recipientOf, settle, signAndComplete, signSig } from '../fixtures/signature-ink-order';

test.describe.configure({ mode: 'default' });

const invitationJobs = async (g: G4Seeded, key: string) =>
  (await jobsFor(JOB.SIGNING_EMAIL, 'recipientId', g.r[key].id)).length;

/** The owner reminds `keys` through API v2, whatever their turn. */
const remind = async (request: Parameters<typeof v2Api>[0], g: G4Seeded, keys: string[]) => {
  expect2xx(
    await v2Api(request, g.owner.apiToken, '/document/redistribute', {
      documentId: g.documentId,
      recipients: keys.map((key) => g.r[key].id),
    }),
    `remind ${keys.join(', ')}`,
  );

  for (const key of keys) {
    expect((await recipientOf(g, key)).sendStatus, `premise: the reminder marks ${key} SENT`).toBe(SendStatus.SENT);
  }
};

test('C109b reminded before their turn, s3 and then s4 are each invited once when their step comes', async ({
  request,
}) => {
  test.setTimeout(240_000);

  const g = await seedFixtureG(2, { status: DocumentStatus.DRAFT });

  expect2xx(await distribute(request, g), 'distribute fixture G');
  await remind(request, g, ['s3', 's4']);

  expect(await invitationJobs(g, 's3'), 'premise: no invitation job for s3 before its step').toBe(0);
  expect(await invitationJobs(g, 's4'), 'premise: no invitation job for s4 before its step').toBe(0);

  await signAndComplete(request, g, 's1');
  await settle();
  expect(await invitationJobs(g, 's3'), 's1 alone does not open s3 step').toBe(0);

  await signAndComplete(request, g, 's2');
  await settle();
  expect(await invitationJobs(g, 's3'), 'the step after s1 and s2 invites s3 once').toBe(1);
  expect(await invitationJobs(g, 's4'), 's4 is not invited yet').toBe(0);

  await signAndComplete(request, g, 's3');
  await settle();
  expect(await invitationJobs(g, 's3'), 's3 is not invited again').toBe(1);
  expect(await invitationJobs(g, 's4'), 's3 completing invites s4 once').toBe(1);
});

test('C109b two concurrent completions of a shared step invite a reminded next signer once', async ({ request }) => {
  test.setTimeout(300_000);

  const outcomes: { iteration: number; s3: number; s4: number }[] = [];

  for (let iteration = 0; iteration < 3; iteration++) {
    const g = await seedFixtureG(2, { status: DocumentStatus.DRAFT });

    expect2xx(await distribute(request, g), 'distribute fixture G');
    await remind(request, g, ['s3']);

    expect2xx(await signSig(request, g, 's1', 's1', 'S s1'), 's1 signs');
    expect2xx(await signSig(request, g, 's2', 's2', 'S s2'), 's2 signs');

    const [first, second] = await Promise.all([
      completeWithToken(request, g, g.r.s1.token),
      completeWithToken(request, g, g.r.s2.token),
    ]);

    expect2xx(first, 's1 completes');
    expect2xx(second, 's2 completes');
    await settle();

    outcomes.push({ iteration, s3: await invitationJobs(g, 's3'), s4: await invitationJobs(g, 's4') });
  }

  expect(outcomes, 'every iteration invites s3 exactly once and s4 not at all').toEqual(
    outcomes.map(({ iteration }) => ({ iteration, s3: 1, s4: 0 })),
  );
});

/**
 * Only the completion that finishes a step may dictate (security lead, G4/ci-55464/dictation-race.txt). s1 and s2
 * share a step and complete at once, each naming a different next signer: one dictation lands, once.
 */
test('C109b two concurrent completions of a shared step, each dictating: s3 is renamed and invited once', async ({
  request,
}) => {
  test.setTimeout(300_000);

  const outcomes: { iteration: number; renames: number; invitations: number; dictated: boolean }[] = [];

  for (let iteration = 0; iteration < 3; iteration++) {
    const g = await seedFixtureG(2, { status: DocumentStatus.DRAFT, allowDictateNextSigner: true });
    const stamp = `${Date.now()}-${iteration}`;
    const fromS1 = { email: `g4-race-s1-${stamp}@test.documenso.com`, name: 'Race From S1' };
    const fromS2 = { email: `g4-race-s2-${stamp}@test.documenso.com`, name: 'Race From S2' };

    expect2xx(await distribute(request, g), 'distribute fixture G');
    expect2xx(await signSig(request, g, 's1', 's1', 'S s1'), 's1 signs');
    expect2xx(await signSig(request, g, 's2', 's2', 'S s2'), 's2 signs');

    const [first, second] = await Promise.all([
      completeWithToken(request, g, g.r.s1.token, { nextSigner: fromS1 }),
      completeWithToken(request, g, g.r.s2.token, { nextSigner: fromS2 }),
    ]);

    expect2xx(first, 's1 completes');
    expect2xx(second, 's2 completes');
    await settle();

    const s3 = await recipientOf(g, 's3');
    const renames = await prisma.documentAuditLog.count({
      where: { envelopeId: g.envelopeId, type: 'RECIPIENT_UPDATED' },
    });

    outcomes.push({
      iteration,
      renames,
      invitations: await invitationJobs(g, 's3'),
      dictated: [fromS1.email, fromS2.email].includes(s3.email),
    });
  }

  expect(outcomes, 'each iteration: one RECIPIENT_UPDATED, one invitation, s3 holds one dictated address').toEqual(
    outcomes.map(({ iteration }) => ({ iteration, renames: 1, invitations: 1, dictated: true })),
  );
});
