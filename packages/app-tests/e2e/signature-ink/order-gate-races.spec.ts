/**
 * The sequential order gate under concurrency (G4 spec section 5.1).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the sign, completion or recipient handlers.
 * Fixtures S and G are seeded through Prisma (fixtures/signature-ink.ts); every
 * request under test goes to the running server through the route a recipient
 * or the owner uses; every assertion reads the database or Inbucket.
 *
 * Forcing the interleaving. The recipient routes and the owner reorders take a
 * lock on the Envelope row (lockEnvelopeForRecipientAction,
 * lockEnvelopeForOwnerEdit, spec 1.6). A forced trial holds that row FOR
 * UPDATE on a separate connection, fires request A, waits until the database
 * shows A queued behind the holder, fires B, waits for B, and releases. Row
 * lock waiters are granted in arrival order, so A runs before B. Trials
 * alternate the two orders. The waiter counts are recorded per trial: a request
 * that never queues (it answered while the row was held) is recorded with
 * `settledWhileHeld`, which is itself evidence that it decides the turn without
 * the lock.
 *
 * Sharpening, reported to the coordinator. As written, the allowed end states
 * of C90, C92 and C98 are reachable in both orders by today's code (the sign
 * answers 200 whatever the turn), so an end-state check alone passes. Under a
 * forced order the outcome is determined: with the sign queued ahead of the
 * completion that brings its turn, the sign must be refused, 400
 * RECIPIENT_OUT_OF_TURN, field untouched; with the completion queued first, the
 * sign must answer 200. Those are the order-specific assertions below. C91's
 * reorder is refused in every ordering since #157, so its sign always wins.
 *
 * | Criterion | Test                                                                  | Interleaving                     |
 * | --------- | --------------------------------------------------------------------- | -------------------------------- |
 * | C90       | C90 V1/V2: s1's completion and s2's TEXT sign                          | forced, both orders, 5 + 5       |
 * | C91       | C91 control, C91 setDocumentRecipients (V1) / updateMany (V2) reorder | forced, both orders, 5 + 5       |
 * | C92       | C92 V1/V2: s2's completion and s3's TEXT sign                          | forced, both orders, 5 + 5       |
 * | C97       | C97 V1/V2: s1 and s2 complete at once, s3 invited once                 | forced (both queued on the row)  |
 * | C98       | C98 V1/V2: s1's completion and s3's sign on fixture G                  | forced, both orders, 5 + 5       |
 * | C93       | C93 record only: createEnvelopeRecipients / updateEnvelope vs s2 sign  | sampled (those writers take no lock) |
 *
 * Expected today (spec 5.2): the refusal halves of C90, C91, C92 and C98 red
 * (the sign-first trials), C97 red, C93 green unless a trial answers 500.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentSigningOrder, FieldType, SendStatus, SigningStatus } from '@prisma/client';

import { type Tx, waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  emailRows,
  keepRecord,
  type Outcome,
  pause,
  type Reply,
  rateLimited,
  runIterations,
  verdictOf,
} from '../fixtures/reject-seal';
import {
  completeWithToken,
  errorOf,
  expectMailCatcher,
  type G4Seeded,
  readInbox,
  seedFixtureS,
  seedG4Envelope,
  seedInserted,
  seedSessionCookie,
  seedSigned,
  signV1,
  signV2,
  trpcAsUser,
  v2Api,
} from '../fixtures/signature-ink';
import { signingEmailRows } from '../fixtures/signature-ink-order';

test.describe.configure({ mode: 'default' });

const VERSIONS = [1, 2] as const;
const TRIAL_TIMEOUT = 20 * 60_000;
const OUT_OF_TURN = 'RECIPIENT_OUT_OF_TURN';

// ---------------------------------------------------------------------------
// Forcing
// ---------------------------------------------------------------------------

const lockEnvelopeRow = (envelopeId: string) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR UPDATE`;

type Forced = {
  first: Reply;
  second: Reply;
  waiters: { afterFirst: number; afterSecond: number };
  firstSettledWhileHeld: boolean;
  secondSettledWhileHeld: boolean;
};

/**
 * Holds the envelope row, queues `first` then `second` behind it, releases.
 * Records whether either answered while the row was still held.
 */
const forceOrder = async (
  envelopeId: string,
  first: () => Promise<Reply>,
  second: () => Promise<Reply>,
): Promise<Forced> => {
  let firstPromise: Promise<Reply> | undefined;
  let secondPromise: Promise<Reply> | undefined;
  let released = false;
  let firstSettledWhileHeld = false;
  let secondSettledWhileHeld = false;

  const waiters = await withLock(lockEnvelopeRow(envelopeId), async (pid) => {
    firstPromise = first().finally(() => {
      firstSettledWhileHeld = !released;
    });

    const afterFirst = await waitForWaiters(pid, 1);

    secondPromise = second().finally(() => {
      secondSettledWhileHeld = !released;
    });

    const afterSecond = await waitForWaiters(pid, 2);

    released = true;

    return { afterFirst, afterSecond };
  });

  if (!firstPromise || !secondPromise) {
    throw new Error('A request was never fired');
  }

  const [firstReply, secondReply] = await Promise.all([firstPromise, secondPromise]);

  return { first: firstReply, second: secondReply, waiters, firstSettledWhileHeld, secondSettledWhileHeld };
};

// ---------------------------------------------------------------------------
// Requests and reads
// ---------------------------------------------------------------------------

const TEXT_VALUE = 'OUT OF TURN';

/** A TEXT sign on the envelope's own route, never retried. */
const signText = async (request: APIRequestContext, seeded: G4Seeded, recipientKey: string) => {
  const recipient = seeded.r[recipientKey];
  const field = recipient.fields.text;

  return seeded.internalVersion === 1
    ? await signV1(request, recipient.token, field.id, TEXT_VALUE, false, false)
    : await signV2(request, recipient.token, field.id, { type: FieldType.TEXT, value: TEXT_VALUE }, false);
};

/** A SIGNATURE sign (typed) on the envelope's own route, never retried. */
const signTyped = async (request: APIRequestContext, seeded: G4Seeded, recipientKey: string, value: string) => {
  const recipient = seeded.r[recipientKey];
  const field = recipient.fields.sig;

  return seeded.internalVersion === 1
    ? await signV1(request, recipient.token, field.id, value, false, false)
    : await signV2(request, recipient.token, field.id, { type: FieldType.SIGNATURE, value }, false);
};

const complete = async (request: APIRequestContext, seeded: G4Seeded, recipientKey: string) =>
  await completeWithToken(request, seeded, seeded.r[recipientKey].token, { retry: false });

const status = async (seeded: G4Seeded, key: string) =>
  (await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.r[key].id } })).signingStatus;

const order = async (seeded: G4Seeded, key: string) =>
  (await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.r[key].id } })).signingOrder;

const fieldOf = async (fieldId: number) =>
  await prisma.field.findUniqueOrThrow({ where: { id: fieldId }, include: { signature: true } });

const fieldAudits = async (
  seeded: G4Seeded,
  secondaryId: string,
  types = ['DOCUMENT_FIELD_INSERTED', 'DOCUMENT_FIELD_UNINSERTED', 'DOCUMENT_FIELD_PREFILLED'],
) =>
  (
    await prisma.documentAuditLog.findMany({
      where: { envelopeId: seeded.envelopeId, type: { in: types } },
    })
  ).filter((row) => ((row.data ?? {}) as Record<string, unknown>).fieldId === secondaryId).length;

/** The recipient columns a refused (out-of-turn) request must leave alone. */
const recipientColumns = async (seeded: G4Seeded, key: string) =>
  await prisma.recipient.findUniqueOrThrow({
    where: { id: seeded.r[key].id },
    select: { signingStatus: true, readStatus: true, sendStatus: true, signedAt: true },
  });

/** Whether the lock holder saw both requests queue behind it, so the arrival order was the one chosen. */
const wasForced = (forced: Forced) => forced.waiters.afterFirst >= 1 && forced.waiters.afterSecond >= 2;

const isOk = (reply: Reply) => reply.status >= 200 && reply.status < 300;

const isOutOfTurn = (reply: Reply) => reply.status === 400 && errorOf(reply).code === OUT_OF_TURN;

const brief = (reply: Reply) => ({ status: reply.status, code: errorOf(reply).code, body: reply.body.slice(0, 200) });

const no5xx = (replies: Record<string, Reply>) =>
  Object.entries(replies)
    .filter(([, reply]) => reply.status >= 500)
    .map(([name, reply]) => `${name} answered ${reply.status}: ${reply.body.slice(0, 150)}`);

/** Alternates the two orders across iterations: odd iterations A first, even B first. */
const alternate = () => {
  let n = 0;

  return () => (n++ % 2 === 0 ? 'sign-first' : 'other-first') as 'sign-first' | 'other-first';
};

// ---------------------------------------------------------------------------
// A completion that brings the signer's turn, racing that signer's TEXT sign
// (C90, C92, C98 share this shape)
// ---------------------------------------------------------------------------

type TurnRace = {
  name: string;
  seed: () => Promise<G4Seeded>;
  completer: string;
  signer: string;
  /** Premises on the seed: the signer is out of turn until the completion. */
  premise: (seeded: G4Seeded) => Promise<void>;
  sign: (request: APIRequestContext, seeded: G4Seeded) => Promise<Reply>;
  signedFieldKey: 'text' | 'sig';
  /** The value the sign sends: customText for TEXT, typedSignature for a typed SIGNATURE. */
  value: string;
  /**
   * The completion legitimately invites the signer's step (C98). A refused sign may then see the signer's sendStatus
   * move from NOT_SENT to SENT, provided this iteration's SIGNING_REQUEST row for the signer proves the invitation.
   */
  completionInvitesSigner?: boolean;
};

/** How long a race waits for the invitation row behind a NOT_SENT to SENT move. */
const INVITATION_ROW_WAIT_MS = 10_000;

/**
 * Whether the only change to the signer's columns is NOT_SENT to SENT and the signer has exactly one SIGNING_REQUEST
 * row on this freshly seeded envelope, which only the completion in this iteration can have written.
 */
const isProvenInvitation = async (
  seeded: G4Seeded,
  key: string,
  before: Awaited<ReturnType<typeof recipientColumns>>,
  after: Awaited<ReturnType<typeof recipientColumns>>,
) => {
  const { sendStatus: sendBefore, ...restBefore } = before;
  const { sendStatus: sendAfter, ...restAfter } = after;

  if (sendBefore !== SendStatus.NOT_SENT || sendAfter !== SendStatus.SENT) {
    return false;
  }

  if (JSON.stringify(restBefore) !== JSON.stringify(restAfter)) {
    return false;
  }

  const deadline = Date.now() + INVITATION_ROW_WAIT_MS;

  while (Date.now() < deadline) {
    const rows = (await signingEmailRows(seeded, key)).length;

    if (rows >= 1) {
      return rows === 1;
    }

    await pause(250);
  }

  return false;
};

const runTurnRace = async (request: APIRequestContext, race: TurnRace) => {
  const next = alternate();

  await runIterations(race.name, async (): Promise<Outcome> => {
    const which = next();
    const seeded = await race.seed();

    await race.premise(seeded);

    const field = seeded.r[race.signer].fields[race.signedFieldKey];
    const signerBefore = await recipientColumns(seeded, race.signer);
    const signCall = async () => await race.sign(request, seeded);
    const completeCall = async () => await complete(request, seeded, race.completer);

    const forced =
      which === 'sign-first'
        ? await forceOrder(seeded.envelopeId, signCall, completeCall)
        : await forceOrder(seeded.envelopeId, completeCall, signCall);

    const signReply = which === 'sign-first' ? forced.first : forced.second;
    const completeReply = which === 'sign-first' ? forced.second : forced.first;
    const limited = rateLimited(seeded, { signReply, completeReply });

    if (limited) {
      return limited;
    }

    const row = await fieldOf(field.id);
    const completerStatus = await status(seeded, race.completer);
    const audits = await fieldAudits(seeded, field.secondaryId);
    const insertedRows = await fieldAudits(seeded, field.secondaryId, ['DOCUMENT_FIELD_INSERTED']);
    const signerAfter = await recipientColumns(seeded, race.signer);
    const inserted = row.inserted;
    const isForced = wasForced(forced);
    const signerInvited =
      race.completionInvitesSigner === true &&
      (await isProvenInvitation(seeded, race.signer, signerBefore, signerAfter));
    const storedValue = race.signedFieldKey === 'text' ? row.customText : (row.signature?.typedSignature ?? null);

    const record = {
      envelopeId: seeded.envelopeId,
      version: seeded.internalVersion,
      order: which === 'sign-first' ? 'sign queued first' : 'completion queued first',
      forced: isForced,
      waiters: forced.waiters,
      signSettledWhileHeld: which === 'sign-first' ? forced.firstSettledWhileHeld : forced.secondSettledWhileHeld,
      completionSettledWhileHeld: which === 'sign-first' ? forced.secondSettledWhileHeld : forced.firstSettledWhileHeld,
      sign: brief(signReply),
      completion: brief(completeReply),
      completerStatus,
      fieldInserted: inserted,
      storedValue,
      fieldAuditRows: audits,
      insertedRows,
      signerBefore,
      signerAfter,
      signerInvited,
    };

    /** 4.0 out-of-turn refusal, as far as one request's effects can be told apart in a race. */
    const refusedState = () => [
      inserted ? 'the out-of-turn field was inserted' : null,
      row.customText === '' ? null : `the refused field's customText is ${JSON.stringify(row.customText)}`,
      row.signature === null ? null : 'a Signature row exists for the refused field',
      audits === 0 ? null : `${audits} field audit rows for the refused sign`,
      JSON.stringify(signerAfter) === JSON.stringify(signerBefore) || signerInvited
        ? null
        : `${race.signer}'s recipient columns changed: ${JSON.stringify(signerBefore)} to ${JSON.stringify(signerAfter)}`,
    ];

    /** 4.0 accepted: inserted with the sent value and exactly one insert audit row. */
    const acceptedState = () => [
      inserted ? null : 'the in-turn sign answered but the field is not inserted',
      storedValue === race.value ? null : `stored ${JSON.stringify(storedValue)}, sent ${JSON.stringify(race.value)}`,
      insertedRows === 1 ? null : `${insertedRows} DOCUMENT_FIELD_INSERTED rows, expected exactly 1`,
    ];

    const problems: Array<string | null> = [
      ...no5xx({ sign: signReply, completion: completeReply }),
      isOk(completeReply) ? null : `the completion answered ${completeReply.status}, expected 200`,
      completerStatus === SigningStatus.SIGNED ? null : `${race.completer} ended ${completerStatus}, expected SIGNED`,
    ];

    if (!isForced) {
      // The lock holder did not see both requests queue, so the order is unknown: the spec's either-state check.
      if (isOk(signReply)) {
        problems.push(...acceptedState());
      } else if (isOutOfTurn(signReply)) {
        problems.push(...refusedState());
      } else {
        problems.push(`unforced trial: the sign answered ${signReply.status}, expected 200 or 400 ${OUT_OF_TURN}`);
      }
    } else if (which === 'sign-first') {
      problems.push(
        isOutOfTurn(signReply)
          ? null
          : `sign queued ahead of the completion answered ${signReply.status} ${errorOf(signReply).code ?? ''}, expected 400 ${OUT_OF_TURN}`,
        ...refusedState(),
      );
    } else {
      problems.push(
        isOk(signReply) ? null : `sign queued after the completion answered ${signReply.status}, expected 200`,
        ...acceptedState(),
      );
    }

    // The allowed end states of the spec, whatever the order.
    if (inserted && !isOk(signReply)) {
      problems.push('the field is inserted but the sign answered an error');
    }

    return { verdict: verdictOf(...problems), record };
  });
};

// ---------------------------------------------------------------------------
// C90
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`C90 V${version}: s1's completion and s2's TEXT sign released together end in one of the two serial states`, async ({
    request,
  }) => {
    test.setTimeout(TRIAL_TIMEOUT);

    await runTurnRace(request, {
      name: `C90-v${version}`,
      seed: async () => {
        const seeded = await seedFixtureS(version);

        await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });

        return seeded;
      },
      completer: 's1',
      signer: 's2',
      premise: async (seeded) => {
        expect(await status(seeded, 's1'), 'premise: s1 has not completed').toBe(SigningStatus.NOT_SIGNED);
        expect((await fieldOf(seeded.r.s1.fields.sig.id)).inserted, "premise: s1's SIGNATURE is inserted").toBe(true);
        expect((await fieldOf(seeded.r.s2.fields.text.id)).inserted, "premise: s2's TEXT is not inserted").toBe(false);
      },
      sign: async (req, seeded) => await signText(req, seeded, 's2'),
      signedFieldKey: 'text',
      value: TEXT_VALUE,
    });
  });
}

// ---------------------------------------------------------------------------
// C91
// ---------------------------------------------------------------------------

type ReorderRoute = 'recipient.setDocumentRecipients' | 'envelope.recipient.updateMany';

const ROUTE_FOR_VERSION: Record<1 | 2, ReorderRoute> = {
  1: 'recipient.setDocumentRecipients',
  2: 'envelope.recipient.updateMany',
};

/** Swaps s2 and s3: s3 to order 2, s2 to order 3. */
const reorder = async (request: APIRequestContext, seeded: G4Seeded, route: ReorderRoute, cookie: string) => {
  if (route === 'envelope.recipient.updateMany') {
    return await v2Api(
      request,
      seeded.owner.apiToken,
      '/envelope/recipient/update-many',
      {
        envelopeId: seeded.envelopeId,
        data: [
          { id: seeded.r.s2.id, signingOrder: 3 },
          { id: seeded.r.s3.id, signingOrder: 2 },
        ],
      },
      false,
    );
  }

  const orders: Record<string, number> = { s1: 1, s2: 3, s3: 2, cc: 4 };

  return await trpcAsUser(
    request,
    'recipient.setDocumentRecipients',
    {
      documentId: seeded.documentId,
      recipients: ['s1', 's2', 's3', 'cc'].map((key) => ({
        id: seeded.r[key].id,
        email: seeded.r[key].email,
        name: seeded.r[key].name,
        role: seeded.r[key].role,
        signingOrder: orders[key],
      })),
    },
    { cookie, teamId: seeded.owner.team.id },
    false,
  );
};

const seedC91 = async (version: 1 | 2) => {
  const seeded = await seedFixtureS(version);

  await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });
  await seedSigned(seeded, 's1');

  return seeded;
};

for (const version of VERSIONS) {
  const route = ROUTE_FOR_VERSION[version];

  // Superseded by #157 C2: the swap moves the current signer, so it is refused whatever the timing.
  test(`C91 control V${version}: ${route} alone cannot swap s2 and s3 on fixture S with s1 SIGNED`, async ({
    request,
  }) => {
    const seeded = await seedC91(version);
    const cookie = await seedSessionCookie(seeded.owner.user.id);
    const reply = await reorder(request, seeded, route, cookie);

    await keepRecord(`C91-control-v${version}.json`, { envelopeId: seeded.envelopeId, route, reply: brief(reply) });

    expect(reply.status >= 400 && reply.status < 500, `the reorder alone is refused: ${reply.status}`).toBe(true);
    expect(reply.body, 'refused by the signing-order rule (#157)').toContain(
      'A recipient cannot be placed at or ahead of the signer whose turn it is.',
    );
    expect(await order(seeded, 's2'), 's2 stays at order 2').toBe(2);
    expect(await order(seeded, 's3'), 's3 stays at order 3').toBe(3);
  });

  test(`C91 V${version}: s2's TEXT sign and a ${route} reorder swapping s2 behind s3, released together`, async ({
    request,
  }) => {
    test.setTimeout(TRIAL_TIMEOUT);

    const next = alternate();

    await runIterations(`C91-v${version}`, async (): Promise<Outcome> => {
      const which = next();
      const seeded = await seedC91(version);
      const cookie = await seedSessionCookie(seeded.owner.user.id);

      expect(await status(seeded, 's1'), 'premise: s1 SIGNED').toBe(SigningStatus.SIGNED);
      expect(await order(seeded, 's2'), 'premise: s2 at order 2').toBe(2);

      const signCall = async () => await signText(request, seeded, 's2');
      const reorderCall = async () => await reorder(request, seeded, route, cookie);

      const forced =
        which === 'sign-first'
          ? await forceOrder(seeded.envelopeId, signCall, reorderCall)
          : await forceOrder(seeded.envelopeId, reorderCall, signCall);

      const signReply = which === 'sign-first' ? forced.first : forced.second;
      const reorderReply = which === 'sign-first' ? forced.second : forced.first;
      const limited = rateLimited(seeded, { signReply, reorderReply });

      if (limited) {
        return limited;
      }

      const inserted = (await fieldOf(seeded.r.s2.fields.text.id)).inserted;
      const s2Order = await order(seeded, 's2');
      const s3Order = await order(seeded, 's3');
      const s3Status = await status(seeded, 's3');
      const isForced = wasForced(forced);

      const record = {
        envelopeId: seeded.envelopeId,
        route,
        order: which === 'sign-first' ? 'sign queued first' : 'reorder queued first',
        forced: isForced,
        waiters: forced.waiters,
        signSettledWhileHeld: which === 'sign-first' ? forced.firstSettledWhileHeld : forced.secondSettledWhileHeld,
        sign: brief(signReply),
        reorder: brief(reorderReply),
        s2FieldInserted: inserted,
        s2Order,
        s3Order,
      };

      const problems: Array<string | null> = [
        ...no5xx({ sign: signReply, reorder: reorderReply }),
        inserted && s2Order === 3 && s3Status !== SigningStatus.SIGNED
          ? "s2's field is inserted while s2 is stored at order 3 behind an unsigned s3"
          : null,
      ];

      /** Allowed state 1: s2's field inserted (200) and the reorder refused, orders unchanged. */
      const signWon = () => [
        isOk(signReply) ? null : `the sign answered ${signReply.status}, expected 200 (s2 was in turn)`,
        inserted ? null : "the sign answered but s2's field is not inserted",
        reorderReply.status >= 400 && reorderReply.status < 500
          ? null
          : `the reorder after s2 inserted a field answered ${reorderReply.status}, expected a 4xx`,
        s2Order === 2 && s3Order === 3 ? null : `orders changed to s2=${s2Order}, s3=${s3Order} after a refusal`,
      ];

      // Since #157 the reorder is refused in every ordering, so the sign winning is the only allowed state.
      problems.push(...signWon());

      return { verdict: verdictOf(...problems), record };
    });
  });
}

// ---------------------------------------------------------------------------
// C92
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`C92 V${version}: s2's completion and s3's TEXT sign released together`, async ({ request }) => {
    test.setTimeout(TRIAL_TIMEOUT);

    await runTurnRace(request, {
      name: `C92-v${version}`,
      seed: async () => {
        const seeded = await seedFixtureS(version);

        await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });
        await seedSigned(seeded, 's1');
        await seedInserted(seeded, 's2', 'sig', { typed: 'S Two' });

        return seeded;
      },
      completer: 's2',
      signer: 's3',
      premise: async (seeded) => {
        expect(await status(seeded, 's1'), 'premise: s1 SIGNED').toBe(SigningStatus.SIGNED);
        expect(await status(seeded, 's2'), 'premise: s2 NOT_SIGNED').toBe(SigningStatus.NOT_SIGNED);
        expect((await fieldOf(seeded.r.s3.fields.text.id)).inserted, "premise: s3's TEXT is not inserted").toBe(false);
      },
      sign: async (req, seeded) => await signText(req, seeded, 's3'),
      signedFieldKey: 'text',
      value: TEXT_VALUE,
    });
  });
}

// ---------------------------------------------------------------------------
// Fixture G after sending: s1 and s2 SENT, s3 and s4 NOT_SENT
// ---------------------------------------------------------------------------

const seedGSent = async (version: 1 | 2) =>
  await seedG4Envelope({
    internalVersion: version,
    signingOrder: DocumentSigningOrder.SEQUENTIAL,
    recipients: ['s1', 's2', 's3', 's4'].map((key, index) => ({
      key,
      signingOrder: [1, 1, 2, null][index],
      sendStatus: index < 2 ? SendStatus.SENT : SendStatus.NOT_SENT,
      fields: [{ key: 'sig', type: FieldType.SIGNATURE }],
    })),
  });

// ---------------------------------------------------------------------------
// C97
// ---------------------------------------------------------------------------

/** How long C97 waits for s3's first invitation, then how long it stays quiet for a second one. */
const INVITE_WAIT_MS = 30_000;
const INVITE_QUIET_MS = 6_000;

/** Polls `mailbox` until it holds at least one message or the wait ends, then waits a quiet window. */
const waitFirstMailThenQuiet = async (request: APIRequestContext, mailbox: string) => {
  const deadline = Date.now() + INVITE_WAIT_MS;

  while (Date.now() < deadline && (await readInbox(request, mailbox)).length === 0) {
    await pause(500);
  }

  await pause(INVITE_QUIET_MS);
};

for (const version of VERSIONS) {
  test(`C97 V${version}: both members of step 1 complete at once and s3 is invited exactly once`, async ({
    request,
  }) => {
    test.setTimeout(TRIAL_TIMEOUT);
    await expectMailCatcher(request);

    await runIterations(`C97-v${version}`, async (): Promise<Outcome> => {
      const seeded = await seedGSent(version);

      await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });
      await seedInserted(seeded, 's2', 'sig', { typed: 'S Two' });

      expect(await readInbox(request, seeded.r.s3.mailbox), 'premise: s3 has no email').toHaveLength(0);

      const s2MailBefore = (await readInbox(request, seeded.r.s2.mailbox)).length;
      expect(
        await emailRows(seeded.envelopeId, 'SIGNING_REQUEST', seeded.r.s3.id),
        'premise: no signing-request row for s3',
      ).toHaveLength(0);

      const forced = await forceOrder(
        seeded.envelopeId,
        async () => await complete(request, seeded, 's1'),
        async () => await complete(request, seeded, 's2'),
      );

      const limited = rateLimited(seeded, { s1: forced.first, s2: forced.second });

      if (limited) {
        return limited;
      }

      await waitFirstMailThenQuiet(request, seeded.r.s3.mailbox);

      const s3Mail = (await readInbox(request, seeded.r.s3.mailbox)).length;
      const s3Rows = (await emailRows(seeded.envelopeId, 'SIGNING_REQUEST', seeded.r.s3.id)).length;
      const s4Mail = (await readInbox(request, seeded.r.s4.mailbox)).length;
      // Recorded so today's "next single recipient" behaviour shows: s1's completion may invite s2 again.
      const s2NewMail = (await readInbox(request, seeded.r.s2.mailbox)).length - s2MailBefore;
      const s2Rows = (await emailRows(seeded.envelopeId, 'SIGNING_REQUEST', seeded.r.s2.id)).length;
      const s1Status = await status(seeded, 's1');
      const s2Status = await status(seeded, 's2');

      const record = {
        envelopeId: seeded.envelopeId,
        waiters: forced.waiters,
        s1: brief(forced.first),
        s2: brief(forced.second),
        s1Status,
        s2Status,
        s3Mail,
        s3SigningRequestRows: s3Rows,
        s4Mail,
        s2NewMail,
        s2SigningRequestRows: s2Rows,
      };

      return {
        verdict: verdictOf(
          ...no5xx({ s1: forced.first, s2: forced.second }),
          isOk(forced.first) ? null : `s1's completion answered ${forced.first.status}`,
          isOk(forced.second) ? null : `s2's completion answered ${forced.second.status}`,
          s1Status === SigningStatus.SIGNED ? null : `s1 ended ${s1Status}`,
          s2Status === SigningStatus.SIGNED ? null : `s2 ended ${s2Status}`,
          s3Mail === 1 ? null : `s3 received ${s3Mail} emails, expected exactly 1`,
          s3Rows === 1 ? null : `${s3Rows} SIGNING_REQUEST EMAIL_SENT rows for s3, expected exactly 1`,
          s4Mail === 0 ? null : `s4 received ${s4Mail} emails, expected none (its step has not come)`,
        ),
        record,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// C98
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`C98 V${version}: s1 completes (s2 already SIGNED) while s3 signs, released together`, async ({ request }) => {
    test.setTimeout(TRIAL_TIMEOUT);

    await runTurnRace(request, {
      name: `C98-v${version}`,
      seed: async () => {
        const seeded = await seedGSent(version);

        await seedInserted(seeded, 's2', 'sig', { typed: 'S Two' });
        await seedSigned(seeded, 's2');
        await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });

        return seeded;
      },
      completer: 's1',
      signer: 's3',
      premise: async (seeded) => {
        expect(await status(seeded, 's2'), 'premise: s2 SIGNED').toBe(SigningStatus.SIGNED);
        expect(await status(seeded, 's1'), 'premise: s1 NOT_SIGNED').toBe(SigningStatus.NOT_SIGNED);
        expect((await fieldOf(seeded.r.s3.fields.sig.id)).inserted, "premise: s3's field is not inserted").toBe(false);
      },
      sign: async (req, seeded) => await signTyped(req, seeded, 's3', 'S Three'),
      signedFieldKey: 'sig',
      value: 'S Three',
      completionInvitesSigner: true,
    });
  });
}

// ---------------------------------------------------------------------------
// C93 (record only)
// ---------------------------------------------------------------------------

type Serial = { a: 'ok' | 'refused' | 'out-of-turn' | 'any-4xx'; b: 'ok' | 'refused' | 'out-of-turn' | 'any-4xx' };

const classify = (reply: Reply) => {
  if (isOk(reply)) {
    return 'ok';
  }

  if (isOutOfTurn(reply)) {
    return 'out-of-turn';
  }

  return reply.status >= 400 && reply.status < 500 ? 'refused' : `status-${reply.status}`;
};

const matches = (actual: string, expected: Serial['a']) =>
  expected === 'any-4xx' ? actual === 'refused' || actual === 'out-of-turn' : actual === expected;

for (const writer of ['createEnvelopeRecipients', 'updateEnvelope'] as const) {
  test(`C93 record only: ${writer} racing an s2 sign (sampled, ten trials; fails only on a 500)`, async ({
    request,
  }) => {
    test.setTimeout(TRIAL_TIMEOUT);

    const outcomes: Array<Record<string, unknown>> = [];

    await runIterations(`C93-${writer}`, async (): Promise<Outcome> => {
      const seeded =
        writer === 'createEnvelopeRecipients'
          ? await seedFixtureS(2)
          : await seedFixtureS(2, { signingOrder: DocumentSigningOrder.PARALLEL });

      if (writer === 'createEnvelopeRecipients') {
        await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });
        await seedSigned(seeded, 's1');
      }

      const writerCall = async () =>
        writer === 'createEnvelopeRecipients'
          ? await v2Api(
              request,
              seeded.owner.apiToken,
              '/envelope/recipient/create-many',
              {
                envelopeId: seeded.envelopeId,
                data: [
                  {
                    email: `${seeded.r.s1.mailbox}-new@test.documenso.com`,
                    name: 'New first signer',
                    role: 'SIGNER',
                    signingOrder: 1,
                  },
                ],
              },
              false,
            )
          : await v2Api(
              request,
              seeded.owner.apiToken,
              '/envelope/update',
              { envelopeId: seeded.envelopeId, meta: { signingOrder: 'SEQUENTIAL' } },
              false,
            );

      // Sampled: neither writer takes an envelope lock, so there is nothing to hold.
      const [signReply, writerReply] = await Promise.all([signText(request, seeded, 's2'), writerCall()]);
      const limited = rateLimited(seeded, { signReply, writerReply });

      if (limited) {
        return limited;
      }

      // Serial outcomes under the spec's rule: sign then writer (both succeed, or the
      // writer refused), or writer then sign (the sign refused, out of turn).
      const serial: Serial[] = [
        { a: 'ok', b: 'ok' },
        { a: 'ok', b: 'any-4xx' },
        { a: 'out-of-turn', b: 'ok' },
      ];
      const sign = classify(signReply);
      const written = classify(writerReply);
      const serialisable = serial.some((option) => matches(sign, option.a) && matches(written, option.b));

      const record = {
        envelopeId: seeded.envelopeId,
        writer,
        sign: brief(signReply),
        writerReply: brief(writerReply),
        s2FieldInserted: (await fieldOf(seeded.r.s2.fields.text.id)).inserted,
        signingOrder: (await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } }))
          .signingOrder,
        recipientCount: await prisma.recipient.count({ where: { envelopeId: seeded.envelopeId } }),
        noSerialOrderProducesThis: !serialisable,
      };

      outcomes.push(record);

      return { verdict: verdictOf(...no5xx({ sign: signReply, writer: writerReply })), record };
    });

    await keepRecord(`C93-${writer}-summary.json`, {
      note: 'record only (#157 closes the window); pass condition: no 500',
      trials: outcomes.length,
      marked: outcomes.filter((outcome) => outcome.noSerialOrderProducesThis).length,
      outcomes,
    });
  });
}
