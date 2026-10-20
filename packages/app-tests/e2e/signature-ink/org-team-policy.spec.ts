/**
 * The organisation side of the merged signature-method policy (G4 spec,
 * "Amendments after implementation area A", criterion C94b).
 *
 * Written from the specification without reading the settings handlers. An
 * organisation settings update that would leave an inheriting team's merged
 * methods all off is refused, including when it races a team settings update.
 * The spec fixes the lock order: the organisation's settings row, then the
 * team's, with the check on the locked rows.
 *
 * | Criterion | Test                                                                                   |
 * | --------- | -------------------------------------------------------------------------------------- |
 * | C94b (a)  | C94b (a) the organisation turns off the last method a team inherits: refused           |
 * | C94b (b)  | C94b (b) organisation and team updates interleaved: exactly one refused, never all off |
 *
 * (b) starts from team {typed:false, draw:null, upload:null} under an
 * organisation with all three on. The team update {upload:false} alone leaves
 * the team draw (inherited); the organisation update {draw:false} alone leaves
 * the team upload (inherited); both together leave the team with none. Each
 * forced trial holds the OrganisationGlobalSettings row FOR UPDATE (the row
 * both writers lock first, per the spec), fires one update, waits until the
 * database shows it queued, fires the other, waits again, then releases;
 * odd trials put the organisation first, even trials the team. A writer that
 * never queues is recorded (waiters in the record), not failed. Ten further
 * trials release both with Promise.all and no barrier.
 *
 * Refusals: 400 (spec 4.0, settings writers) with data.code INVALID_REQUEST, the
 * code for refusals G4 adds (amendments after the red run).
 *
 * Runs in the `ui` project.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';

import { type Tx, waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  isSuccess,
  keepRecord,
  type Outcome,
  type Reply,
  rateLimited,
  runIterations,
  verdictOf,
} from '../fixtures/reject-seal';
import { createG4Owner, describeReply, errorOf, seedSessionCookie, trpcAsUser } from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

type Flags = { typedSignatureEnabled: boolean; drawSignatureEnabled: boolean; uploadSignatureEnabled: boolean };
type NullableFlags = { [K in keyof Flags]: boolean | null };

const ALL_ON: Flags = { typedSignatureEnabled: true, drawSignatureEnabled: true, uploadSignatureEnabled: true };

type Owner = Awaited<ReturnType<typeof createG4Owner>>;

const settingsIdsOf = async (owner: Owner) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: owner.team.id }, include: { organisation: true } });

  return { teamSettingsId: team.teamGlobalSettingsId, orgSettingsId: team.organisation.organisationGlobalSettingsId };
};

const setSettings = async (owner: Owner, team: NullableFlags, organisation: Flags) => {
  const ids = await settingsIdsOf(owner);

  await prisma.teamGlobalSettings.update({ where: { id: ids.teamSettingsId }, data: team });
  await prisma.organisationGlobalSettings.update({ where: { id: ids.orgSettingsId }, data: organisation });

  return ids;
};

const readSettings = async (owner: Owner) => {
  const ids = await settingsIdsOf(owner);
  const team = await prisma.teamGlobalSettings.findUniqueOrThrow({ where: { id: ids.teamSettingsId } });
  const org = await prisma.organisationGlobalSettings.findUniqueOrThrow({ where: { id: ids.orgSettingsId } });

  const teamFlags: NullableFlags = {
    typedSignatureEnabled: team.typedSignatureEnabled,
    drawSignatureEnabled: team.drawSignatureEnabled,
    uploadSignatureEnabled: team.uploadSignatureEnabled,
  };
  const orgFlags: Flags = {
    typedSignatureEnabled: org.typedSignatureEnabled,
    drawSignatureEnabled: org.drawSignatureEnabled,
    uploadSignatureEnabled: org.uploadSignatureEnabled,
  };
  const merged: Flags = {
    typedSignatureEnabled: teamFlags.typedSignatureEnabled ?? orgFlags.typedSignatureEnabled,
    drawSignatureEnabled: teamFlags.drawSignatureEnabled ?? orgFlags.drawSignatureEnabled,
    uploadSignatureEnabled: teamFlags.uploadSignatureEnabled ?? orgFlags.uploadSignatureEnabled,
  };

  return { team: teamFlags, organisation: orgFlags, merged };
};

const allOff = (flags: Flags) =>
  !flags.typedSignatureEnabled && !flags.drawSignatureEnabled && !flags.uploadSignatureEnabled;

const isInvalidRequest400 = (reply: Reply) => reply.status === 400 && errorOf(reply).code === 'INVALID_REQUEST';

const writers = (request: APIRequestContext, owner: Owner, cookie: string) => {
  const auth = { cookie, teamId: owner.team.id };

  return {
    organisation: (data: Partial<Flags>) => () =>
      trpcAsUser(request, 'organisation.settings.update', { organisationId: owner.organisation.id, data }, auth, false),
    team: (data: Partial<NullableFlags>) => () =>
      trpcAsUser(request, 'team.settings.update', { teamId: owner.team.id, data }, auth, false),
  };
};

// ---------------------------------------------------------------------------
// C94b (a)
// ---------------------------------------------------------------------------

test('C94b (a) the organisation turns off the last method a team inherits: refused, nothing stored', async ({
  request,
}) => {
  const owner = await createG4Owner();
  const cookie = await seedSessionCookie(owner.user.id);
  const write = writers(request, owner, cookie);
  const record: Record<string, unknown> = {};

  // Control: a team that sets typed on itself keeps a method, so the organisation may turn draw off.
  await setSettings(
    owner,
    { typedSignatureEnabled: true, drawSignatureEnabled: false, uploadSignatureEnabled: false },
    ALL_ON,
  );

  const control = await write.organisation({ drawSignatureEnabled: false })();

  record.control = { status: control.status, after: await readSettings(owner) };
  expect(control.status, `control: organisation draw off over a team that keeps typed: ${describeReply(control)}`).toBe(
    200,
  );
  expect(
    (await readSettings(owner)).organisation.drawSignatureEnabled,
    'control: the organisation stores draw off',
  ).toBe(false);

  // The team turns typed and upload off itself and inherits draw; the organisation then turns draw off.
  await setSettings(
    owner,
    { typedSignatureEnabled: false, drawSignatureEnabled: null, uploadSignatureEnabled: false },
    ALL_ON,
  );

  const before = await readSettings(owner);

  expect(allOff(before.merged), 'premise: the team keeps draw through its organisation').toBe(false);

  const reply = await write.organisation({ drawSignatureEnabled: false })();
  const after = await readSettings(owner);

  record.refusal = { status: reply.status, code: errorOf(reply).code, before, after };
  await keepRecord('C94b-a.json', record);

  expect
    .soft(reply.status, `organisation draw off leaving the team none: refused with 400: ${describeReply(reply)}`)
    .toBe(400);
  expect.soft(errorOf(reply).code, 'organisation refusal: data.code').toBe('INVALID_REQUEST');
  expect.soft(after, 'every stored flag unchanged').toEqual(before);
  expect(allOff(after.merged), "the team's merged methods are never all off").toBe(false);
});

// ---------------------------------------------------------------------------
// C94b (b)
// ---------------------------------------------------------------------------

const lockOrgSettings = (orgSettingsId: string) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "OrganisationGlobalSettings" WHERE "id" = ${orgSettingsId} FOR UPDATE`;

const START_TEAM: NullableFlags = {
  typedSignatureEnabled: false,
  drawSignatureEnabled: null,
  uploadSignatureEnabled: null,
};
const ORG_DATA: Partial<Flags> = { drawSignatureEnabled: false };
const TEAM_DATA: Partial<NullableFlags> = { uploadSignatureEnabled: false };

type Mode = 'organisation first' | 'team first' | 'unforced';

const interleavedTrial = async (request: APIRequestContext, mode: Mode): Promise<Outcome> => {
  const owner = await createG4Owner();
  const cookie = await seedSessionCookie(owner.user.id);
  const write = writers(request, owner, cookie);
  const ids = await setSettings(owner, START_TEAM, ALL_ON);
  const before = await readSettings(owner);

  if (allOff(before.merged)) {
    throw new Error('premise: the starting team has a method');
  }

  let orgReply: Reply;
  let teamReply: Reply;
  let waiters: { afterFirst: number; afterSecond: number } | null = null;

  if (mode === 'unforced') {
    [orgReply, teamReply] = await Promise.all([write.organisation(ORG_DATA)(), write.team(TEAM_DATA)()]);
  } else {
    const a = mode === 'organisation first' ? write.organisation(ORG_DATA) : write.team(TEAM_DATA);
    const b = mode === 'organisation first' ? write.team(TEAM_DATA) : write.organisation(ORG_DATA);
    let first: Promise<Reply> | undefined;
    let second: Promise<Reply> | undefined;

    waiters = await withLock(lockOrgSettings(ids.orgSettingsId), async (pid) => {
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

    orgReply = mode === 'organisation first' ? firstReply : secondReply;
    teamReply = mode === 'organisation first' ? secondReply : firstReply;
  }

  const limited = rateLimited({ envelopeId: `team-${owner.team.id}` }, { orgReply, teamReply });

  if (limited) {
    return limited;
  }

  const after = await readSettings(owner);
  const orgLanded = after.organisation.drawSignatureEnabled === false;
  const teamLanded = after.team.uploadSignatureEnabled === false;
  const refusals = [orgReply, teamReply].filter((reply) => !isSuccess(reply));

  return {
    verdict: verdictOf(
      orgReply.status >= 500 ? `the organisation update answered ${orgReply.status}` : null,
      teamReply.status >= 500 ? `the team update answered ${teamReply.status}` : null,
      allOff(after.merged) ? "the team's merged methods are stored all off" : null,
      refusals.length === 1 ? null : `${refusals.length} of the two updates were refused, expected exactly one`,
      refusals.every(isInvalidRequest400)
        ? null
        : `a refusal answered ${refusals.map((reply) => `${reply.status} ${errorOf(reply).code ?? ''}`).join(', ')}, expected 400 INVALID_REQUEST`,
      isSuccess(orgReply) === orgLanded
        ? null
        : `the organisation update answered ${orgReply.status} but stores draw=${after.organisation.drawSignatureEnabled}`,
      isSuccess(teamReply) === teamLanded
        ? null
        : `the team update answered ${teamReply.status} but stores upload=${after.team.uploadSignatureEnabled}`,
    ),
    record: {
      teamId: owner.team.id,
      mode,
      waiters,
      orgReply: { status: orgReply.status, code: errorOf(orgReply).code },
      teamReply: { status: teamReply.status, code: errorOf(teamReply).code },
      before,
      after,
    },
  };
};

test('C94b (b) organisation and team updates interleaved: exactly one refused, never all off, never a 500', async ({
  request,
}) => {
  test.setTimeout(15 * 60_000);

  let trial = 0;

  // Twenty forced trials, alternating which writer reaches the organisation row first.
  await runIterations(
    'C94b-b-forced',
    async () => await interleavedTrial(request, trial++ % 2 === 0 ? 'organisation first' : 'team first'),
    20,
  );

  await runIterations('C94b-b-unforced', async () => await interleavedTrial(request, 'unforced'), 10);
});
