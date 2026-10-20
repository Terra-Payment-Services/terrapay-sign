/**
 * Concurrency on signature values and the signature-method policy (G4 spec
 * sections 4.7 and 4.2, criteria C40, C41, C42, C44, C45, C94).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the sign, direct-template, profile or
 * settings handlers. Requests go to the running server through the routes a
 * recipient, direct-link signer or owner uses; assertions read the database.
 *
 * Forcing. Where both requests must take the same row lock, the test holds
 * that row `FOR UPDATE` in its own transaction (fixtures/lock-barrier.ts),
 * fires the first request, waits until the database shows it queued, fires
 * the second, waits for it too, and only then commits. Row-lock waiters are
 * granted in queue order, so the order the requests reach the database is the
 * order the test chose. Every trial records how many requests were seen
 * queued: a request that is refused before it reaches the lock (as a fixed
 * validator would refuse a blank image) is recorded with a count of 0, which
 * is a legitimate outcome, not a test failure.
 *
 * | Criterion | Test | Interleaving |
 * | --------- | ---- | ------------ |
 * | C40 | C40 V2: a blank and a valid image on one field together | Forced: Envelope row held; blank first in odd trials, valid first in even |
 * | C41 | C41 V1: a blank and a valid image on one field together, and the field is not left locked | Forced, as C40; plus a sequential blank-then-valid control (F02 lock-out) |
 * | C42 | C42 owner turns draw and upload off while the recipient signs an image | Forced where the update queues on the Envelope row: update first in odd trials (the update is uncommitted when the sign reads the policy), sign first in even. If the update never queues it is awaited before the sign is fired, which is the same serial order; the trial records which happened |
 * | C44 | C44 two direct-template submissions together | Sampled only: DT takes no envelope lock and the two submissions share no row, so `Promise.all` is the closest the test can come |
 * | C45 | C45 two profile updates together, one blank and one valid | Forced: User row held; blank first in odd trials, valid first in even |
 * | C94 | C94 envelope.update and team.settings.update splitting the three methods off | Forced: DocumentMeta (envelope) or TeamGlobalSettings (team) row held, both updates queued, both orders |
 *
 * Expected today (spec 4.8): the refusal halves of C40-C42, C44 and C45 are
 * red, and C94 is red.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import { type Tx, waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  isClientError,
  isSuccess,
  keepRecord,
  type Outcome,
  type Reply,
  rateLimited,
  runIterations,
  verdictOf,
} from '../fixtures/reject-seal';
import {
  auditValueOf,
  createG4Owner,
  errorOf,
  fieldAuditRowsOf,
  fieldState,
  type G4Seeded,
  imageDataUrl,
  normalisedPngProblems,
  seedG4DirectTemplate,
  seedG4Envelope,
  seedOneSigner,
  seedSessionCookie,
  signSignature,
  submitDirectTemplate,
  teamRowCounts,
  trpcAsUser,
  v2Api,
  validInkedDataUrl,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const BLANK = () => imageDataUrl('transparent-1000x438');
const VALID = () => validInkedDataUrl();
const VALID_DIMS = { width: 400, height: 175 };

const lockEnvelope = (envelopeId: string) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR UPDATE`;

const lockDocumentMeta = (documentMetaId: string) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "DocumentMeta" WHERE "id" = ${documentMetaId} FOR UPDATE`;

const lockUser = (userId: number) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;

const lockTeamSettings = (settingsId: string) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "TeamGlobalSettings" WHERE "id" = ${settingsId} FOR UPDATE`;

/**
 * Holds the row `lock` takes, fires `a` then `b`, each after the one before
 * it is seen queued, then releases. A request that never queues within the
 * wait (refused or finished before the lock) is recorded as such.
 */
const forcedPair = async (lock: (tx: Tx) => Promise<unknown>, a: () => Promise<Reply>, b: () => Promise<Reply>) => {
  let first: Promise<Reply> | undefined;
  let second: Promise<Reply> | undefined;

  const waiters = await withLock(lock, async (pid) => {
    first = a();

    const afterFirst = await waitForWaiters(pid, 1);

    second = b();

    const afterSecond = await waitForWaiters(pid, afterFirst + 1);

    return { afterFirst, afterSecond };
  });

  if (!first || !second) {
    throw new Error('A request was never fired');
  }

  const [firstReply, secondReply] = await Promise.all([first, second]);

  return { firstReply, secondReply, waiters };
};

const is500 = (reply: Reply, what: string) =>
  reply.status >= 500 ? `${what} answered ${reply.status}: ${reply.body.slice(0, 200)}` : null;

const isInvalidRequest400 = (reply: Reply) => reply.status === 400 && errorOf(reply).code === 'INVALID_REQUEST';

/** A refused writer must answer 400 ("one request of each pair may be refused with 400"). */
const refusedWith400 = (reply: Reply, what: string) =>
  isSuccess(reply) || reply.status === 400 ? null : `${what} answered ${reply.status}, expected 200 or 400`;

// ---------------------------------------------------------------------------
// C40, C41: a blank and a valid image on one field
// ---------------------------------------------------------------------------

/** One trial on a fresh one-signer envelope; odd trials send the blank first. */
const blankVersusValid = async (request: APIRequestContext, version: 1 | 2, blankFirst: boolean): Promise<Outcome> => {
  const seeded = await seedOneSigner(version);
  const signer = seeded.r.s1;
  const field = signer.fields.sig;
  const before = await fieldState(field.id);

  if (before.inserted || before.signatureCount !== 0) {
    throw new Error('premise: the seeded SIGNATURE field starts uninserted with no Signature row');
  }

  const sign = (value: string) => () =>
    signSignature(request, seeded, signer.token, field.id, value, { isBase64: true, retry: false });

  const pair = await forcedPair(
    lockEnvelope(seeded.envelopeId),
    blankFirst ? sign(BLANK()) : sign(VALID()),
    blankFirst ? sign(VALID()) : sign(BLANK()),
  );

  const blankReply = blankFirst ? pair.firstReply : pair.secondReply;
  const validReply = blankFirst ? pair.secondReply : pair.firstReply;

  const limited = rateLimited(seeded, { blankReply, validReply });

  if (limited) {
    return limited;
  }

  const after = await fieldState(field.id);
  const inserts = await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId, ['DOCUMENT_FIELD_INSERTED']);
  const storedProblems = normalisedPngProblems(after.signature?.image, VALID_DIMS);

  // "Not left locked" (F02): a field that ended uninserted can still be signed by its recipient.
  let relockReply: Reply | null = null;

  if (!after.inserted) {
    relockReply = await signSignature(request, seeded, signer.token, field.id, VALID(), { isBase64: true });
  }

  return {
    verdict: verdictOf(
      is500(blankReply, 'the blank sign'),
      is500(validReply, 'the valid sign'),
      isInvalidRequest400(blankReply)
        ? null
        : `the blank sign answered ${blankReply.status} ${errorOf(blankReply).code ?? ''}, expected 400 INVALID_REQUEST`,
      isSuccess(validReply) ? null : `the valid sign answered ${validReply.status}, expected 200`,
      after.inserted ? null : 'the field ended uninserted',
      storedProblems.length === 0 ? null : `the stored row is not the valid image: ${storedProblems.join('; ')}`,
      after.signatureCount === 1 ? null : `${after.signatureCount} Signature rows, expected 1`,
      inserts.length === 1 ? null : `${inserts.length} DOCUMENT_FIELD_INSERTED rows, expected 1`,
      inserts.length === 1 && auditValueOf(inserts[0]) !== after.signature?.image
        ? 'the insert audit row does not record the stored value'
        : null,
      relockReply && !isSuccess(relockReply)
        ? `the field was left locked: a later valid sign answered ${relockReply.status}`
        : null,
    ),
    record: {
      envelopeId: seeded.envelopeId,
      internalVersion: version,
      order: blankFirst ? 'blank first' : 'valid first',
      waiters: pair.waiters,
      blankReply: { status: blankReply.status, code: errorOf(blankReply).code },
      validReply: { status: validReply.status, code: errorOf(validReply).code },
      inserted: after.inserted,
      signatureRows: after.signatureCount,
      storedProblems,
      insertAuditRows: inserts.length,
      relockReply: relockReply?.status ?? null,
    },
  };
};

test('C40 V2: a blank and a valid image on one field together: blank 400, valid 200, the valid row stored once', async ({
  request,
}) => {
  test.setTimeout(10 * 60_000);

  let trial = 0;

  await runIterations('C40', async () => await blankVersusValid(request, 2, trial++ % 2 === 0));
});

test('C41 V1: a blank and a valid image on one field together: blank 400, valid 200, field not left locked', async ({
  request,
}) => {
  test.setTimeout(10 * 60_000);

  // The F02 lock-out, sequentially: a refused blank must leave the field signable.
  const seeded = await seedOneSigner(1);
  const signer = seeded.r.s1;
  const field = signer.fields.sig;

  const blank = await signSignature(request, seeded, signer.token, field.id, BLANK(), { isBase64: true });
  const valid = await signSignature(request, seeded, signer.token, field.id, VALID(), { isBase64: true });

  await keepRecord('C41-sequential.json', {
    envelopeId: seeded.envelopeId,
    blank: { status: blank.status, code: errorOf(blank).code },
    valid: { status: valid.status, code: errorOf(valid).code },
    field: await fieldState(field.id),
  });

  expect
    .soft(
      isInvalidRequest400(blank),
      `the blank alone is refused with 400 INVALID_REQUEST: ${blank.status} ${blank.body.slice(0, 200)}`,
    )
    .toBe(true);
  expect.soft(valid.status, `the valid sign afterwards answers 200: ${valid.body.slice(0, 200)}`).toBe(200);

  let trial = 0;

  await runIterations('C41', async () => await blankVersusValid(request, 1, trial++ % 2 === 0));
});

// ---------------------------------------------------------------------------
// C42: policy change racing a sign
// ---------------------------------------------------------------------------

test('C42 owner turns draw and upload off while the recipient signs an image: never an image after a refusal, never a 500', async ({
  request,
}) => {
  test.setTimeout(10 * 60_000);

  let trial = 0;

  await runIterations('C42', async (): Promise<Outcome> => {
    const updateFirst = trial++ % 2 === 0;
    const seeded = await seedOneSigner(2);
    const signer = seeded.r.s1;
    const field = signer.fields.sig;

    const meta = await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } });

    if (!meta.typedSignatureEnabled || !meta.drawSignatureEnabled || !meta.uploadSignatureEnabled) {
      throw new Error('premise: the envelope starts with all three methods on');
    }

    const update = () =>
      v2Api(
        request,
        seeded.owner.apiToken,
        '/envelope/update',
        { envelopeId: seeded.envelopeId, meta: { drawSignatureEnabled: false, uploadSignatureEnabled: false } },
        false,
      );
    const sign = () => signSignature(request, seeded, signer.token, field.id, VALID(), { retry: false });
    const auditBefore = (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length;

    let updateReply: Reply | undefined;
    let updatePromise: Promise<Reply> | undefined;
    let signPromise: Promise<Reply> | undefined;
    let updateQueued = false;

    const waiters = await withLock(lockEnvelope(seeded.envelopeId), async (pid) => {
      if (updateFirst) {
        updatePromise = update();

        const afterUpdate = await waitForWaiters(pid, 1);

        updateQueued = afterUpdate >= 1;

        if (!updateQueued) {
          // The update does not wait on the Envelope row: let it commit before the sign starts.
          updateReply = await updatePromise;
        }

        signPromise = sign();

        return { afterUpdate, afterSign: await waitForWaiters(pid, afterUpdate + 1) };
      }

      signPromise = sign();

      const afterSign = await waitForWaiters(pid, 1);

      updatePromise = update();

      return { afterSign, afterUpdate: await waitForWaiters(pid, afterSign + 1) };
    });

    updateReply = updateReply ?? (await updatePromise);
    const signReply = await signPromise;

    if (!updateReply || !signReply) {
      throw new Error('A request was never fired');
    }

    const limited = rateLimited(seeded, { updateReply, signReply });

    if (limited) {
      return limited;
    }

    const after = await fieldState(field.id);
    const auditAfter = (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length;
    const storedMeta = await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } });
    const signRefused = !isSuccess(signReply);

    // 4.0: after a refusal the same field can be signed with a value the policy allows (typed is still on).
    const control = signRefused
      ? await signSignature(request, seeded, signer.token, field.id, 'Control Signer', { retry: false })
      : null;
    const updateLanded = !storedMeta.drawSignatureEnabled && !storedMeta.uploadSignatureEnabled;

    // Update first (queued ahead of the sign, or committed before it was fired): the sign must be refused.
    const updateCommittedFirst = updateFirst && isSuccess(updateReply);

    return {
      verdict: verdictOf(
        is500(updateReply, 'the update'),
        is500(signReply, 'the sign'),
        isSuccess(updateReply) ? null : `premise: the owner's update answered ${updateReply.status}, expected 200`,
        isSuccess(updateReply) && !updateLanded ? 'the update answered 200 but the flags are unchanged' : null,
        isClientError(signReply) && after.inserted ? 'an image was inserted after a refusal response' : null,
        signRefused && !isInvalidRequest400(signReply)
          ? `the sign was refused with ${signReply.status} ${errorOf(signReply).code ?? ''}, expected 400 INVALID_REQUEST`
          : null,
        signRefused && after.signatureCount !== 0 ? 'a Signature row exists after the refusal' : null,
        signRefused && auditAfter !== auditBefore ? 'a field audit row was written for the refused sign' : null,
        control && !isSuccess(control)
          ? `after the refusal a typed sign of the same field answered ${control.status}, expected 200`
          : null,
        isSuccess(signReply) && !after.inserted ? 'the sign answered 200 but the field is not inserted' : null,
        updateCommittedFirst && !isClientError(signReply)
          ? `the update committed first but the sign answered ${signReply.status} and inserted the image under a typed-only policy`
          : null,
      ),
      record: {
        envelopeId: seeded.envelopeId,
        order: updateFirst ? 'update first' : 'sign first',
        updateQueuedOnEnvelopeRow: updateFirst ? updateQueued : null,
        waiters,
        updateReply: updateReply.status,
        signReply: { status: signReply.status, code: errorOf(signReply).code },
        controlReply: control?.status ?? null,
        inserted: after.inserted,
        storedFlags: {
          typed: storedMeta.typedSignatureEnabled,
          draw: storedMeta.drawSignatureEnabled,
          upload: storedMeta.uploadSignatureEnabled,
        },
      },
    };
  });
});

// ---------------------------------------------------------------------------
// C44: two direct-template submissions
// ---------------------------------------------------------------------------

test('C44 two direct-template submissions together: two blanks create nothing; blank and valid create exactly one envelope', async ({
  request,
}) => {
  test.setTimeout(15 * 60_000);

  for (const pair of ['blank+blank', 'blank+valid'] as const) {
    await runIterations(`C44-${pair}`, async (): Promise<Outcome> => {
      // A fresh owner per trial, so no organisation document quota is reached by the test itself.
      const template = await seedG4DirectTemplate(2);
      const before = await teamRowCounts(template.owner.team.id);

      if (before.envelopes !== 0) {
        throw new Error('premise: the fresh team owns no documents');
      }

      const [blankReply, otherReply] = await Promise.all([
        submitDirectTemplate(request, template, { value: BLANK(), isBase64: true }, { retry: false }),
        submitDirectTemplate(
          request,
          template,
          { value: pair === 'blank+blank' ? BLANK() : VALID(), isBase64: true },
          { retry: false },
        ),
      ]);

      const limited = rateLimited({ envelopeId: template.envelopeId }, { blankReply, otherReply });

      if (limited) {
        return limited;
      }

      const after = await teamRowCounts(template.owner.team.id);
      const created = after.envelopes - before.envelopes;

      const problems =
        pair === 'blank+blank'
          ? [
              isInvalidRequest400(blankReply) ? null : `the first blank answered ${blankReply.status}, expected 400`,
              isInvalidRequest400(otherReply) ? null : `the second blank answered ${otherReply.status}, expected 400`,
              created === 0 ? null : `${created} new Envelope rows, expected 0`,
            ]
          : [
              isInvalidRequest400(blankReply) ? null : `the blank answered ${blankReply.status}, expected 400`,
              isSuccess(otherReply) ? null : `the valid submission answered ${otherReply.status}, expected 200`,
              created === 1 ? null : `${created} new Envelope rows, expected 1`,
            ];

      return {
        verdict: verdictOf(is500(blankReply, 'a submission'), is500(otherReply, 'a submission'), ...problems),
        record: {
          templateId: template.envelopeId,
          pair,
          blankReply: { status: blankReply.status, code: errorOf(blankReply).code },
          otherReply: { status: otherReply.status, code: errorOf(otherReply).code },
          rowsBefore: before,
          rowsAfter: after,
        },
      };
    });
  }
});

// ---------------------------------------------------------------------------
// C45: two profile updates
// ---------------------------------------------------------------------------

test('C45 two profile updates together, one blank and one valid: the saved signature ends valid', async ({
  request,
}) => {
  test.setTimeout(10 * 60_000);

  const owner = await createG4Owner();
  const cookie = await seedSessionCookie(owner.user.id);

  const control = await trpcAsUser(request, 'profile.updateProfile', { name: 'G4 Owner', signature: '' }, { cookie });

  expect(control.status, `premise: the seeded session can update the profile: ${control.body.slice(0, 200)}`).toBe(200);

  let trial = 0;

  await runIterations('C45', async (): Promise<Outcome> => {
    const blankFirst = trial++ % 2 === 0;

    await prisma.user.update({ where: { id: owner.user.id }, data: { signature: null } });

    const update = (signature: string) => () =>
      trpcAsUser(request, 'profile.updateProfile', { name: 'G4 Owner', signature }, { cookie }, false);

    const pair = await forcedPair(
      lockUser(owner.user.id),
      blankFirst ? update(BLANK()) : update(VALID()),
      blankFirst ? update(VALID()) : update(BLANK()),
    );

    const blankReply = blankFirst ? pair.firstReply : pair.secondReply;
    const validReply = blankFirst ? pair.secondReply : pair.firstReply;

    const limited = rateLimited({ envelopeId: `user-${owner.user.id}` }, { blankReply, validReply });

    if (limited) {
      return limited;
    }

    const stored = (await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).signature;
    const storedProblems = normalisedPngProblems(stored, VALID_DIMS);

    return {
      verdict: verdictOf(
        is500(blankReply, 'the blank update'),
        is500(validReply, 'the valid update'),
        isSuccess(validReply) ? null : `the valid update answered ${validReply.status}, expected 200`,
        isInvalidRequest400(blankReply)
          ? null
          : `the blank update answered ${blankReply.status} ${errorOf(blankReply).code ?? ''}, expected 400 INVALID_REQUEST`,
        storedProblems.length === 0 ? null : `User.signature is not the valid image: ${storedProblems.join('; ')}`,
      ),
      record: {
        userId: owner.user.id,
        order: blankFirst ? 'blank first' : 'valid first',
        waiters: pair.waiters,
        blankReply: { status: blankReply.status, code: errorOf(blankReply).code },
        validReply: { status: validReply.status, code: errorOf(validReply).code },
        storedProblems,
      },
    };
  });
});

// ---------------------------------------------------------------------------
// C94: the policy writers' merged check is a conditional write
// ---------------------------------------------------------------------------

const TYPED_OFF = { typedSignatureEnabled: false };
const IMAGE_OFF = { drawSignatureEnabled: false, uploadSignatureEnabled: false };

test('C94 envelope.update twice, splitting the three methods off: never all three stored false, never a 500', async ({
  request,
}) => {
  test.setTimeout(10 * 60_000);

  let trial = 0;

  await runIterations('C94-envelope', async (): Promise<Outcome> => {
    const typedFirst = trial++ % 2 === 0;
    const seeded: G4Seeded = await seedG4Envelope({
      internalVersion: 2,
      status: DocumentStatus.DRAFT,
      recipients: [{ key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] }],
    });

    const meta = await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } });

    if (!meta.typedSignatureEnabled || !meta.drawSignatureEnabled || !meta.uploadSignatureEnabled) {
      throw new Error('premise: the envelope starts with all three methods on');
    }

    const update = (data: Record<string, boolean>) => () =>
      v2Api(request, seeded.owner.apiToken, '/envelope/update', { envelopeId: seeded.envelopeId, meta: data }, false);

    const pair = await forcedPair(
      lockDocumentMeta(seeded.documentMetaId),
      typedFirst ? update(TYPED_OFF) : update(IMAGE_OFF),
      typedFirst ? update(IMAGE_OFF) : update(TYPED_OFF),
    );

    const typedReply = typedFirst ? pair.firstReply : pair.secondReply;
    const imageReply = typedFirst ? pair.secondReply : pair.firstReply;

    const limited = rateLimited(seeded, { typedReply, imageReply });

    if (limited) {
      return limited;
    }

    const stored = await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } });
    const flags = {
      typed: stored.typedSignatureEnabled,
      draw: stored.drawSignatureEnabled,
      upload: stored.uploadSignatureEnabled,
    };

    return {
      verdict: verdictOf(
        is500(typedReply, 'the typed-off update'),
        is500(imageReply, 'the image-off update'),
        !flags.typed && !flags.draw && !flags.upload ? 'all three methods are stored false' : null,
        refusedWith400(typedReply, 'the typed-off update'),
        refusedWith400(imageReply, 'the image-off update'),
        isSuccess(typedReply) === !flags.typed
          ? null
          : `the typed-off update answered ${typedReply.status} but typed=${flags.typed}`,
        isSuccess(imageReply) === (!flags.draw && !flags.upload)
          ? null
          : `the image-off update answered ${imageReply.status} but draw=${flags.draw}, upload=${flags.upload}`,
        isSuccess(typedReply) || isSuccess(imageReply) ? null : 'both updates were refused; one of the pair must land',
      ),
      record: {
        envelopeId: seeded.envelopeId,
        order: typedFirst ? 'typed-off first' : 'image-off first',
        waiters: pair.waiters,
        typedReply: { status: typedReply.status, code: errorOf(typedReply).code },
        imageReply: { status: imageReply.status, code: errorOf(imageReply).code },
        flags,
      },
    };
  });
});

test('C94 team.settings.update twice, splitting the three methods off a team inheriting them: never all three off, never a 500', async ({
  request,
}) => {
  test.setTimeout(10 * 60_000);

  let trial = 0;

  await runIterations('C94-team', async (): Promise<Outcome> => {
    const typedFirst = trial++ % 2 === 0;
    const owner = await createG4Owner();
    const cookie = await seedSessionCookie(owner.user.id);

    const team = await prisma.team.findUniqueOrThrow({
      where: { id: owner.team.id },
      include: { teamGlobalSettings: true, organisation: { include: { organisationGlobalSettings: true } } },
    });
    const org = team.organisation.organisationGlobalSettings;

    if (
      team.teamGlobalSettings.typedSignatureEnabled !== null ||
      team.teamGlobalSettings.drawSignatureEnabled !== null ||
      team.teamGlobalSettings.uploadSignatureEnabled !== null ||
      !org.typedSignatureEnabled ||
      !org.drawSignatureEnabled ||
      !org.uploadSignatureEnabled
    ) {
      throw new Error('premise: the team inherits all three methods on from its organisation');
    }

    const update = (data: Record<string, boolean>) => () =>
      trpcAsUser(
        request,
        'team.settings.update',
        { teamId: owner.team.id, data },
        { cookie, teamId: owner.team.id },
        false,
      );

    const pair = await forcedPair(
      lockTeamSettings(team.teamGlobalSettingsId),
      typedFirst ? update(TYPED_OFF) : update(IMAGE_OFF),
      typedFirst ? update(IMAGE_OFF) : update(TYPED_OFF),
    );

    const typedReply = typedFirst ? pair.firstReply : pair.secondReply;
    const imageReply = typedFirst ? pair.secondReply : pair.firstReply;

    const limited = rateLimited({ envelopeId: `team-${owner.team.id}` }, { typedReply, imageReply });

    if (limited) {
      return limited;
    }

    const stored = await prisma.teamGlobalSettings.findUniqueOrThrow({ where: { id: team.teamGlobalSettingsId } });
    const merged = {
      typed: stored.typedSignatureEnabled ?? org.typedSignatureEnabled,
      draw: stored.drawSignatureEnabled ?? org.drawSignatureEnabled,
      upload: stored.uploadSignatureEnabled ?? org.uploadSignatureEnabled,
    };

    return {
      verdict: verdictOf(
        is500(typedReply, 'the typed-off update'),
        is500(imageReply, 'the image-off update'),
        !merged.typed && !merged.draw && !merged.upload ? 'the merged team settings have all three methods off' : null,
        refusedWith400(typedReply, 'the typed-off update'),
        refusedWith400(imageReply, 'the image-off update'),
        isSuccess(typedReply) === (stored.typedSignatureEnabled === false)
          ? null
          : `the typed-off update answered ${typedReply.status} but the team stores typed=${stored.typedSignatureEnabled}`,
        isSuccess(imageReply) === (stored.drawSignatureEnabled === false && stored.uploadSignatureEnabled === false)
          ? null
          : `the image-off update answered ${imageReply.status} but the team stores draw=${stored.drawSignatureEnabled}, upload=${stored.uploadSignatureEnabled}`,
        !isSuccess(imageReply) && (stored.drawSignatureEnabled !== null || stored.uploadSignatureEnabled !== null)
          ? 'the refused image-off update changed a stored team flag'
          : null,
        !isSuccess(typedReply) && stored.typedSignatureEnabled !== null
          ? 'the refused typed-off update changed the stored team flag'
          : null,
        isSuccess(typedReply) || isSuccess(imageReply) ? null : 'both updates were refused; one of the pair must land',
      ),
      record: {
        teamId: owner.team.id,
        order: typedFirst ? 'typed-off first' : 'image-off first',
        waiters: pair.waiters,
        typedReply: { status: typedReply.status, code: errorOf(typedReply).code },
        imageReply: { status: imageReply.status, code: errorOf(imageReply).code },
        stored: {
          typed: stored.typedSignatureEnabled,
          draw: stored.drawSignatureEnabled,
          upload: stored.uploadSignatureEnabled,
        },
        merged,
      },
    };
  });
});
