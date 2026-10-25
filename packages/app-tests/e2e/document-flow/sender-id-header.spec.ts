/**
 * #137: with "Send on Behalf of Team" off, recipient mail must not carry
 * `X-Documenso-Sender-User-Id`.
 *
 * Written from the specification alone, without reading the header builder or
 * the three mail handlers. Each criterion runs against the three recipient
 * mails that carry the headers:
 *
 *   M1 invitation on send (API v1 send)
 *   M2 owner's manual resend (API v1 resend)
 *   M3 automatic reminder (the signing reminder job)
 *
 * | Test                                                            | Criterion |
 * | --------------------------------------------------------------- | --------- |
 * | C1 setting off: no sender id header, envelope and team remain   | C1        |
 * | C2 setting on: sender id header equals the sending user's id    | C2        |
 * | C3 team inherits an organisation value of false                 | C3        |
 * | C3 team override false under organisation true                  | C3        |
 * | C3 team override true under organisation false (control)        | C3        |
 * | C4 two members sending with the setting off: same header shape  | C4        |
 * | C5 no header carries the user id or the user's email            | C5        |
 *
 * The raw message is read from Inbucket at
 * `GET /api/v1/mailbox/<name>/<id>/source`. Only the header block (everything
 * before the first blank line, with folded lines joined) is inspected. Every
 * negative check is paired with a positive anchor in the same test (the
 * envelope and team headers are present) so an empty or truncated message
 * cannot pass it.
 *
 * The user id in C5 is numeric, so it is matched as a whole token and only in
 * headers whose value could plausibly carry it: every X-* header except the
 * team id, plus Reply-To and the List-* headers. The sender's email is unique
 * and is searched for in every header.
 */
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType, Prisma } from '@prisma/client';
import {
  addressFor,
  assertMailCatcherReachable,
  INBUCKET_URL,
  readMailbox,
  runSigningReminder,
  uniqueLocalPart,
  v1Resend,
  v1Send,
  waitForMail,
} from '../fixtures/send-path';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test.beforeAll(async ({ request }) => {
  await assertMailCatcherReachable(request);
});

const SENDER_ID_HEADER = 'x-documenso-sender-user-id';
const ENVELOPE_ID_HEADER = 'x-documenso-envelope-id';
const TEAM_ID_HEADER = 'x-documenso-team-id';

const uniqueToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

type SettingSetup = { organisation: boolean; team: boolean | null };

type Sender = { id: number; name: string; email: string };

type Scenario = {
  sender: Sender;
  teamId: number;
  teamUrl: string;
};

const SETTING_FALSE: SettingSetup = { organisation: false, team: null };
const SETTING_TRUE: SettingSetup = { organisation: true, team: null };

/** A team owner with a unique name and email, with the setting applied at organisation and, optionally, team level. */
const seedScenario = async ({ organisation: orgValue, team: teamValue }: SettingSetup): Promise<Scenario> => {
  const id = uniqueToken();

  const { user, team, organisation } = await seedUser({
    name: `Hdrsender${id}`,
    email: `hdr-sender-${id}@test.documenso.com`,
    teamEmail: `hdr-team-${id}@test.documenso.com`,
    isPersonalOrganisation: false,
  });

  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { includeSenderDetails: orgValue },
  });

  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { includeSenderDetails: teamValue },
  });

  return { sender: { id: user.id, name: user.name ?? '', email: user.email }, teamId: team.id, teamUrl: team.url };
};

/** A further member of the scenario's team, who sends under the same setting. */
const seedMember = async (scenario: Scenario): Promise<Sender> => {
  const member = await seedTeamMember({ teamId: scenario.teamId, name: `Hdrmember${uniqueToken()}` });

  return { id: member.id, name: member.name ?? '', email: member.email };
};

const tokenFor = async (sender: Sender, teamId: number) => {
  const { token } = await createApiToken({
    userId: sender.id,
    teamId,
    tokenName: `sender-id-header-${uniqueToken()}`,
    expiresIn: null,
  });

  return token;
};

const ownerOf = async (sender: Sender) => await prisma.user.findUniqueOrThrow({ where: { id: sender.id } });

/** A V1 draft owned by `sender` whose one signer has a signature field, ready for API v1 send. */
const seedDraftForSend = async (sender: Sender, teamId: number, label: string) => {
  const localPart = uniqueLocalPart(label);

  const document = await seedDraftDocument(await ownerOf(sender), teamId, [addressFor(localPart)], {
    internalVersion: 1,
    createDocumentOptions: { title: `Hdrdraft${label}${uniqueToken()}` },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  await prisma.field.create({
    data: {
      envelopeId: document.id,
      envelopeItemId: document.envelopeItems[0].id,
      recipientId: recipient.id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(60),
      width: new Prisma.Decimal(25),
      height: new Prisma.Decimal(8),
      customText: '',
      inserted: false,
    },
  });

  return { documentId: mapSecondaryIdToDocumentId(document.secondaryId), localPart };
};

/** A pending V1 document owned by `sender` with one recipient on a mailbox of its own. */
const seedPending = async (sender: Sender, teamId: number, label: string) => {
  const localPart = uniqueLocalPart(label);

  const document = await seedPendingDocument(await ownerOf(sender), teamId, [addressFor(localPart)], {
    internalVersion: 1,
    createDocumentOptions: { title: `Hdrpending${label}${uniqueToken()}` },
  });

  return {
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
    recipientId: document.recipients[0].id,
    localPart,
  };
};

type Headers = Map<string, string[]>;

/** Reads a message's raw source and returns its header block, folded lines joined, names lower-cased. */
const readHeaders = async (localPart: string, messageId: string): Promise<Headers> => {
  // Node fetch, untraced: a trace would record the sender address, which the artifact scan refuses (#176).
  const res = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${localPart}/${messageId}/source`);

  expect(res.ok, `reading source of ${messageId} in ${localPart}: ${res.status}`).toBe(true);

  const source = (await res.text()).replace(/\r\n/g, '\n');
  const block = source.split('\n\n')[0];
  const unfolded = block.replace(/\n[ \t]+/g, ' ');
  const headers: Headers = new Map();

  for (const line of unfolded.split('\n')) {
    const colon = line.indexOf(':');

    if (colon <= 0) {
      continue;
    }

    const name = line.slice(0, colon).trim().toLowerCase();
    const values = headers.get(name) ?? [];

    values.push(line.slice(colon + 1).trim());
    headers.set(name, values);
  }

  expect(headers.size, `the raw source of ${messageId} has a parsed header block`).toBeGreaterThan(3);

  return headers;
};

type Trigger = 'M1 invitation' | 'M2 resend' | 'M3 reminder';

const TRIGGERS: Trigger[] = ['M1 invitation', 'M2 resend', 'M3 reminder'];

/** Causes one recipient-facing mail of the given kind from `sender` and returns its headers. */
const triggerMail = async (
  request: APIRequestContext,
  trigger: Trigger,
  sender: Sender,
  teamId: number,
): Promise<Headers> => {
  const label = trigger.slice(0, 2).toLowerCase();
  const token = await tokenFor(sender, teamId);
  let localPart: string;

  if (trigger === 'M1 invitation') {
    const draft = await seedDraftForSend(sender, teamId, label);
    const res = await v1Send(request, token, draft.documentId);

    expect(res.ok(), `v1 send: ${res.status()} ${await res.text()}`).toBe(true);
    localPart = draft.localPart;
  } else if (trigger === 'M2 resend') {
    const pending = await seedPending(sender, teamId, label);
    const res = await v1Resend(request, token, pending.documentId, [pending.recipientId]);

    expect(res.ok(), `v1 resend: ${res.status()} ${await res.text()}`).toBe(true);
    localPart = pending.localPart;
  } else {
    const pending = await seedPending(sender, teamId, label);
    const res = await runSigningReminder(request, pending.recipientId);

    expect(res.status(), `reminder job: ${await res.text()}`).toBe(200);
    localPart = pending.localPart;
  }

  const messages = await waitForMail(request, localPart, 1);

  expect(messages, `${trigger}: the recipient holds exactly one email`).toHaveLength(1);

  return await readHeaders(localPart, (await readMailbox(request, localPart))[0].id);
};

/** The positive anchor: the mail carries the envelope and team headers. */
const expectAnchorHeaders = (headers: Headers, trigger: Trigger) => {
  expect(headers.get(ENVELOPE_ID_HEADER), `${trigger}: X-Documenso-Envelope-Id is present`).toHaveLength(1);
  expect(headers.get(TEAM_ID_HEADER), `${trigger}: X-Documenso-Team-Id is present`).toHaveLength(1);
};

const expectNoSenderIdHeader = (headers: Headers, trigger: Trigger) => {
  expectAnchorHeaders(headers, trigger);
  expect(headers.has(SENDER_ID_HEADER), `${trigger}: X-Documenso-Sender-User-Id is absent`).toBe(false);
};

const expectSenderIdHeader = (headers: Headers, sender: Sender, trigger: Trigger) => {
  expectAnchorHeaders(headers, trigger);
  expect(headers.get(SENDER_ID_HEADER), `${trigger}: X-Documenso-Sender-User-Id is the sending user's id`).toEqual([
    String(sender.id),
  ]);
};

for (const trigger of TRIGGERS) {
  test(`C1 ${trigger}: setting off carries no sender id header and keeps envelope and team ids`, async ({
    request,
  }) => {
    const scenario = await seedScenario(SETTING_FALSE);

    expectNoSenderIdHeader(await triggerMail(request, trigger, scenario.sender, scenario.teamId), trigger);
  });

  test(`C2 ${trigger}: setting on carries the sender id header equal to the sending user's id`, async ({ request }) => {
    const scenario = await seedScenario(SETTING_TRUE);

    expectSenderIdHeader(
      await triggerMail(request, trigger, scenario.sender, scenario.teamId),
      scenario.sender,
      trigger,
    );
  });

  test(`C3 ${trigger}: a team inheriting an organisation value of false carries no sender id header`, async ({
    request,
  }) => {
    const scenario = await seedScenario({ organisation: false, team: null });

    expectNoSenderIdHeader(await triggerMail(request, trigger, scenario.sender, scenario.teamId), trigger);
  });

  test(`C3 ${trigger}: a team override of false under an organisation value of true carries no sender id header`, async ({
    request,
  }) => {
    const scenario = await seedScenario({ organisation: true, team: false });

    expectNoSenderIdHeader(await triggerMail(request, trigger, scenario.sender, scenario.teamId), trigger);
  });

  test(`C3 ${trigger}: a team override of true under an organisation value of false carries the sender id header`, async ({
    request,
  }) => {
    const scenario = await seedScenario({ organisation: false, team: true });

    expectSenderIdHeader(
      await triggerMail(request, trigger, scenario.sender, scenario.teamId),
      scenario.sender,
      trigger,
    );
  });

  test(`C4 ${trigger}: two members sending with the setting off produce headers that do not differ by sender`, async ({
    request,
  }) => {
    const scenario = await seedScenario(SETTING_FALSE);
    const member = await seedMember(scenario);

    expect(member.id, 'premise: the second sender is a different user').not.toBe(scenario.sender.id);

    const fromOwner = await triggerMail(request, trigger, scenario.sender, scenario.teamId);
    const fromMember = await triggerMail(request, trigger, member, scenario.teamId);

    expectNoSenderIdHeader(fromOwner, trigger);
    expectNoSenderIdHeader(fromMember, trigger);

    const xNames = (headers: Headers) => [...headers.keys()].filter((name) => name.startsWith('x-')).sort();

    expect(xNames(fromMember), `${trigger}: the same X-* header names for both senders`).toEqual(xNames(fromOwner));
    expect(fromMember.get(TEAM_ID_HEADER), `${trigger}: the same team id for both senders`).toEqual(
      fromOwner.get(TEAM_ID_HEADER),
    );

    for (const [who, headers, sender] of [
      ['owner', fromOwner, scenario.sender],
      ['member', fromMember, member],
    ] as const) {
      expectNoIdentityInHeaders(headers, sender, `${trigger} from the ${who}`);
    }
  });

  test(`C5 ${trigger}: no header carries the user id or the user's email`, async ({ request }) => {
    const scenario = await seedScenario(SETTING_FALSE);
    const headers = await triggerMail(request, trigger, scenario.sender, scenario.teamId);

    expectNoSenderIdHeader(headers, trigger);
    expectNoIdentityInHeaders(headers, scenario.sender, trigger);
  });
}

/** Headers that carry the user id as a number are limited to X-* (bar the team id), Reply-To and List-*. */
const expectNoIdentityInHeaders = (headers: Headers, sender: Sender, context: string) => {
  const idToken = new RegExp(`(^|[^0-9A-Za-z])${sender.id}([^0-9A-Za-z]|$)`);

  for (const [name, values] of headers) {
    for (const value of values) {
      expect(
        value.toLowerCase().includes(sender.email.toLowerCase()),
        `${context}: header ${name} does not contain the sender's email`,
      ).toBe(false);
      expect(value.includes(sender.name), `${context}: header ${name} does not contain the sender's name`).toBe(false);

      const mayCarryId =
        (name.startsWith('x-') && name !== TEAM_ID_HEADER) || name === 'reply-to' || name.startsWith('list-');

      if (mayCarryId) {
        expect(idToken.test(value), `${context}: header ${name} does not contain the sender's user id`).toBe(false);
      }
    }
  }
};
