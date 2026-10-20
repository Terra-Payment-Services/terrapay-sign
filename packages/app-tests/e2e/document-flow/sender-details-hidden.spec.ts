/**
 * "Send on Behalf of Team" off hides the individual sender from signers.
 *
 * Written from the specification alone,
 * without reading the resend, signing-page or signing-loader code.
 *
 * | Test                                                              | Criterion |
 * | ----------------------------------------------------------------- | --------- |
 * | C1 the first invitation contains no sender                        | C1        |
 * | C2 a manual reminder (UI Resend and API v1) contains no sender    | C2        |
 * | C3 a custom message survives the reminder unchanged               | C3        |
 * | C4 the V1 signing page shows the team and contains no sender      | C4        |
 * | C5 the V2 signing page contains no sender                         | C5        |
 * | C6 the completion page contains no sender                         | C6        |
 * | C7 the embedded signing page (V1 and V2) contains no sender       | C7        |
 * | C8 the V2 direct template page contains no sender                 | C8        |
 * | C9 setting true: invitation and reminder name the sender          | C9        |
 * | C10 setting true: the V1 signing page shows the sender            | C10       |
 * | C11 team false over organisation true behaves as false            | C11       |
 * | C12 the multisign embed contains no sender                        | C12       |
 * | C13 the direct template embed contains no sender                  | C13       |
 * | C14 a personal account still shows the sender                     | C14       |
 * | C15 the owner as a recipient can sign and gets the completed mail | C15       |
 * | C16 C17 rejection: confirmation and cancellation hide the sender  | C16, C17  |
 * | C16 C17 setting true: both name the sender                        | control   |
 * | C18 the owner cancels: the cancellation hides the sender          | C18       |
 * | C19 the owner deletes: the cancellation hides the sender          | C19       |
 * | C20 removal through the editor update hides the sender            | C20       |
 * | C20 removal through the single-recipient delete hides the sender  | C20       |
 * | C21 C22 sealed audit pages hide the sender; owner log keeps it    | C21, C22  |
 * | C21 setting true: the sealed audit pages name the sender          | control   |
 * | C23 owner as signer: owner entries in the audit pages show the team | C23      |
 * | C24 reject on behalf: audit pages name neither owner nor member   | C24       |
 * | C25 external rejection by the owner-signer: entry names no member | C25       |
 * | C25 external rejection electing a member: entry names no member   | C25       |
 * | C26 delegated owner: audit pages name neither delegate nor user   | C26       |
 *
 * C2 and C9 also check a reminder's heading, preview text and default message
 * one by one. The preview is the first display:none div of the HTML body; the
 * heading is the first paragraph that holds the document title; the default
 * message is the last such paragraph.
 *
 * "Contains no sender" means neither the sender's unique name nor unique email
 * appears in the email's subject, HTML body or text body, or in the full HTML
 * the browser receives (`page.content()`), which carries the serialised loader
 * data. Every negative check is paired with a positive anchor in the same test
 * so that an empty mail or an error page cannot pass it.
 *
 * Signing pages are opened in a page with no session, as a recipient would
 * open them, so nothing about the sender reaches the page through a login.
 *
 * Mail is read from Inbucket's web API. The message body fields are read from
 * `body.html` and `body.text` of `GET /api/v1/mailbox/<name>/<id>`; the reader
 * throws when both are absent, so a changed response shape fails loudly rather
 * than letting the negative checks pass on empty strings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import {
  seedDraftDocument,
  seedPendingDocument,
  seedPendingDocumentWithFullFields,
} from '@documenso/prisma/seed/documents';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FieldType, Prisma, RecipientRole, SigningStatus } from '@prisma/client';
import { auditEntry, rawPdfText } from '../fixtures/audit-pages';
import { apiSignin } from '../fixtures/authentication';
import { openDropdownMenu } from '../fixtures/generic';
import {
  addressFor,
  assertMailCatcherReachable,
  INBUCKET_URL,
  jsonHeaders,
  readMailbox,
  uniqueLocalPart,
  V2_URL,
  v1Resend,
  v1Send,
  waitForMail,
} from '../fixtures/send-path';
import { signSignaturePad } from '../fixtures/signature';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test.beforeAll(async ({ request }) => {
  await assertMailCatcherReachable(request);
});

const PDF_PAGE_SELECTOR = 'img[data-page-number]';

/** Letters and digits only, so no HTML or JSON escaping can alter them on the way to the browser. */
const uniqueToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

type Scenario = {
  senderName: string;
  senderEmail: string;
  teamName: string;
  teamEmail: string;
  user: Awaited<ReturnType<typeof seedUser>>['user'];
  team: Awaited<ReturnType<typeof seedUser>>['team'];
  organisation: Awaited<ReturnType<typeof seedUser>>['organisation'];
};

type SettingSetup = { organisation: boolean; team: boolean | null };

/**
 * A sender with a unique name and email, a team with a unique name and a team
 * email, and the setting applied at organisation level and, optionally, at
 * team level. The team name is read back from the database.
 */
const seedScenario = async (
  { organisation: orgValue, team: teamValue }: SettingSetup,
  options: { personal?: boolean } = {},
): Promise<Scenario> => {
  const id = uniqueToken();
  const senderName = `Zelqsender${id}`;
  const senderEmail = `zelq-sender-${id}@test.documenso.com`;
  const teamEmail = `zelq-team-${id}@test.documenso.com`;

  const { user, team, organisation } = await seedUser({
    name: senderName,
    email: senderEmail,
    teamEmail,
    isPersonalOrganisation: options.personal ?? false,
  });

  const renamed = await prisma.team.update({ where: { id: team.id }, data: { name: `Vortalteam${id}` } });

  if (!options.personal) {
    await prisma.organisationGlobalSettings.update({
      where: { id: organisation.organisationGlobalSettingsId },
      data: { includeSenderDetails: orgValue },
    });

    await prisma.teamGlobalSettings.update({
      where: { id: team.teamGlobalSettingsId },
      data: { includeSenderDetails: teamValue },
    });
  }

  const stored = await prisma.team.findUniqueOrThrow({ where: { id: renamed.id } });

  expect(user.name, 'premise: the sender is stored under the unique name').toBe(senderName);
  expect(user.email, 'premise: the sender is stored under the unique email').toBe(senderEmail);
  expect(stored.name.includes(senderName), 'premise: the team name does not contain the sender name').toBe(false);

  return { senderName, senderEmail, teamName: stored.name, teamEmail, user, team: stored, organisation };
};

const SETTING_FALSE: SettingSetup = { organisation: false, team: null };
const SETTING_TRUE: SettingSetup = { organisation: true, team: null };

const apiTokenFor = async (scenario: Scenario) => {
  const { token } = await createApiToken({
    userId: scenario.user.id,
    teamId: scenario.team.id,
    tokenName: `sender-details-${uniqueToken()}`,
    expiresIn: null,
  });

  return token;
};

type MailContent = { subject: string; html: string; text: string };

/** Fetches one message's subject and both bodies. Throws if Inbucket returns neither body field. */
const readMessage = async (localPart: string, entry: { id: string; subject: string }): Promise<MailContent> => {
  // Node fetch, untraced: a trace would record the sender address, which the artifact scan refuses (#176).
  const res = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${localPart}/${entry.id}`);

  expect(res.ok, `reading message ${entry.id} in ${localPart}: ${res.status}`).toBe(true);

  const message = (await res.json()) as {
    subject?: string;
    header?: { Subject?: string[] };
    body?: { html?: string; text?: string };
  };

  const html = message.body?.html;
  const text = message.body?.text;

  if (html === undefined && text === undefined) {
    throw new Error(
      `Inbucket message ${entry.id} in ${localPart} has neither body.html nor body.text; ` +
        `top-level keys: ${Object.keys(message).join(', ')}`,
    );
  }

  return {
    subject: message.header?.Subject?.[0] ?? message.subject ?? entry.subject,
    html: html ?? '',
    text: text ?? '',
  };
};

/** Waits for the mailbox to hold `count` messages and returns the content of the message at `count`. */
const readNthMail = async (request: APIRequestContext, localPart: string, count: number) => {
  const messages = await waitForMail(request, localPart, count);

  expect(messages, `${localPart} holds exactly ${count} email(s)`).toHaveLength(count);

  return await readMessage(localPart, messages[count - 1]);
};

const collapse = (value: string) => value.replace(/\s+/g, ' ');

const expectNoSenderIn = (haystack: string, scenario: Scenario, context: string) => {
  expect(haystack.includes(scenario.senderName), `${context} must not contain the sender's name`).toBe(false);
  expect(haystack.toLowerCase().includes(scenario.senderEmail), `${context} must not contain the sender's email`).toBe(
    false,
  );
};

const expectMailHasNoSender = (mail: MailContent, scenario: Scenario, context: string) => {
  expectNoSenderIn(mail.subject, scenario, `${context}: subject`);
  expectNoSenderIn(mail.html, scenario, `${context}: HTML body`);
  expectNoSenderIn(mail.text, scenario, `${context}: text body`);
};

/** Positive anchor for a mail: the team name appears in the subject or a body. */
const expectMailNamesTeam = (mail: MailContent, scenario: Scenario, context: string) => {
  const all = `${mail.subject}\n${mail.html}\n${mail.text}`;

  expect(all.includes(scenario.teamName), `${context}: the email names the team`).toBe(true);
};

const expectMailNamesSenderOnBehalfOfTeam = (mail: MailContent, scenario: Scenario, context: string) => {
  const text = collapse(mail.text);
  const html = collapse(mail.html);

  expect(
    text.includes(`${scenario.senderName} on behalf of`) || html.includes(`${scenario.senderName} on behalf of`),
    `${context}: the email reads "${scenario.senderName} on behalf of <team>"`,
  ).toBe(true);
  expectMailNamesTeam(mail, scenario, context);
};

const textOf = (html: string) =>
  collapse(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();

type ReminderParts = { heading: string; preview: string; message: string };

/** Splits a reminder's HTML into preview text, heading and default message. Throws when a part is missing. */
const readReminderParts = (mail: MailContent, title: string, context: string): ReminderParts => {
  const preview = /<div[^>]*display:\s*none[^>]*>([\s\S]*?)<\/div>/i.exec(mail.html);
  const paragraphs = [...mail.html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => textOf(match[1]))
    .filter((paragraph) => paragraph.includes(title));

  if (!preview) {
    throw new Error(`${context}: no display:none preview div in the HTML body`);
  }

  if (paragraphs.length < 2) {
    throw new Error(
      `${context}: expected a heading and a message paragraph holding "${title}", found ${paragraphs.length}`,
    );
  }

  return { preview: textOf(preview[1]), heading: paragraphs[0], message: paragraphs[paragraphs.length - 1] };
};

const expectReminderPartsHaveNoSender = (mail: MailContent, scenario: Scenario, title: string, context: string) => {
  const parts = readReminderParts(mail, title, context);

  for (const [name, value] of Object.entries(parts)) {
    expect(value.length, `${context}: the ${name} is not empty`).toBeGreaterThan(0);
    expectNoSenderIn(value, scenario, `${context}: ${name}`);
  }

  expect(parts.message.includes(scenario.teamName), `${context}: the default message names the team`).toBe(true);
};

const expectReminderPartsNameSenderOnBehalfOfTeam = (
  mail: MailContent,
  scenario: Scenario,
  title: string,
  context: string,
) => {
  const parts = readReminderParts(mail, title, context);

  for (const name of ['heading', 'preview'] as const) {
    expect(
      parts[name].includes(`${scenario.senderName} on behalf of`),
      `${context}: the ${name} names the sender on behalf of`,
    ).toBe(true);
    expect(parts[name].includes(scenario.teamName), `${context}: the ${name} names the team`).toBe(true);
  }
};

const expectPageHasNoSender = async (page: Page, scenario: Scenario, context: string) => {
  expectNoSenderIn(await page.content(), scenario, `${context}: page.content()`);
};

/**
 * A pending V1 or V2 document with one recipient on a mailbox of their own.
 *
 * V2 documents are seeded with a signature field carrying its default field
 * meta. The V2 signing renderer parses every field against the full field
 * schema, which requires field meta, and shows "Configuration Error" in place
 * of the PDF for a field without it, such as the NAME field seedPendingDocument
 * inserts.
 */
const seedPending = async (scenario: Scenario, label: string, internalVersion: 1 | 2 = 1) => {
  const localPart = uniqueLocalPart(label);
  const title = `Sdoc${label}${uniqueToken()}`;

  if (internalVersion === 2) {
    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: scenario.user,
      teamId: scenario.team.id,
      recipients: [addressFor(localPart)],
      fields: [FieldType.SIGNATURE],
      updateDocumentOptions: { internalVersion: 2, title },
    });

    return { document, recipient: recipients[0], localPart, title };
  }

  const document = await seedPendingDocument(scenario.user, scenario.team.id, [addressFor(localPart)], {
    internalVersion,
    createDocumentOptions: { title },
  });

  return { document, recipient: document.recipients[0], localPart, title };
};

/** A V1 draft whose one signer has a signature field, ready for API v1 send. */
const seedDraftForSend = async (scenario: Scenario, label: string) => {
  const localPart = uniqueLocalPart(label);
  const title = `Sdraft${label}${uniqueToken()}`;

  const document = await seedDraftDocument(scenario.user, scenario.team.id, [addressFor(localPart)], {
    internalVersion: 1,
    createDocumentOptions: { title },
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

  return { documentId: mapSecondaryIdToDocumentId(document.secondaryId), recipient, localPart, title };
};

/** Sends a manual reminder through the documents table's Resend action, signed in as the sender. */
const resendThroughUi = async (page: Page, scenario: Scenario, title: string) => {
  await apiSignin({
    page,
    email: scenario.senderEmail,
    redirectPath: `/t/${scenario.team.url}/documents?status=PENDING`,
  });

  const actionBtn = page.locator('tr', { hasText: title }).getByTestId('document-table-action-btn');

  await expect(actionBtn).toBeAttached();
  await openDropdownMenu(page, actionBtn);
  await page.getByRole('menuitem', { name: 'Resend' }).click();

  await page.getByLabel('test.documenso.com').first().click();
  await page.getByRole('button', { name: 'Send reminder' }).click();

  await expect(page.getByText('Document resent', { exact: true })).toBeVisible({ timeout: 10_000 });
};

const openV1SigningPage = async (page: Page, token: string) => {
  await page.goto(`/sign/${token}`);
  await expect(page.getByRole('heading', { name: 'Sign Document' })).toBeVisible({ timeout: 30_000 });
};

/** Signs a V1 document as a recipient through the signing page and waits for the SIGNED status. */
const signV1AsRecipient = async (page: Page, recipient: { id: number; token: string; fields: { id: number }[] }) => {
  await openV1SigningPage(page, recipient.token);
  await signSignaturePad(page);

  for (const field of recipient.fields) {
    await page.locator(`#field-${field.id}`).getByRole('button').click();
    await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
  }

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();

  // Signing ends in a client-side navigation to /complete. Returning before it
  // lands lets that navigation abort the caller's next page.goto (ERR_ABORTED).
  await page.waitForURL(`**/sign/${recipient.token}/complete`, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus, {
      timeout: 30_000,
    })
    .toBe(SigningStatus.SIGNED);
};

test('C1 the first invitation contains no sender and names the team', async ({ request }) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const token = await apiTokenFor(scenario);
  const { documentId, localPart } = await seedDraftForSend(scenario, 'c1');

  expect(await readMailbox(request, localPart), 'premise: the mailbox starts empty').toHaveLength(0);

  const res = await v1Send(request, token, documentId);

  expect(res.ok(), `v1 send: ${res.status()} ${await res.text()}`).toBe(true);

  const mail = await readNthMail(request, localPart, 1);

  expectMailNamesTeam(mail, scenario, 'invitation');
  expectMailHasNoSender(mail, scenario, 'invitation');
});

test('C2 a manual reminder through the UI Resend action and through API v1 contains no sender', async ({
  page,
  request,
}) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const token = await apiTokenFor(scenario);

  const viaUi = await seedPending(scenario, 'c2ui');

  await resendThroughUi(page, scenario, viaUi.title);

  const uiMail = await readNthMail(request, viaUi.localPart, 1);

  expectMailNamesTeam(uiMail, scenario, 'UI reminder');
  expectMailHasNoSender(uiMail, scenario, 'UI reminder');
  expectReminderPartsHaveNoSender(uiMail, scenario, viaUi.title, 'UI reminder');

  const viaApi = await seedPending(scenario, 'c2api');
  const res = await v1Resend(request, token, mapSecondaryIdToDocumentId(viaApi.document.secondaryId), [
    viaApi.recipient.id,
  ]);

  expect(res.ok(), `v1 resend: ${res.status()} ${await res.text()}`).toBe(true);

  const apiMail = await readNthMail(request, viaApi.localPart, 1);

  expectMailNamesTeam(apiMail, scenario, 'API v1 reminder');
  expectMailHasNoSender(apiMail, scenario, 'API v1 reminder');
  expectReminderPartsHaveNoSender(apiMail, scenario, viaApi.title, 'API v1 reminder');
});

test('C3 a reminder carries the document custom message unchanged and contains no sender', async ({ request }) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const token = await apiTokenFor(scenario);
  const customMessage = `Kindly review clause seven ${uniqueToken()} before signing`;

  const { document, recipient, localPart } = await seedPending(scenario, 'c3');

  await prisma.documentMeta.update({ where: { id: document.documentMetaId }, data: { message: customMessage } });

  const res = await v1Resend(request, token, mapSecondaryIdToDocumentId(document.secondaryId), [recipient.id]);

  expect(res.ok(), `v1 resend: ${res.status()} ${await res.text()}`).toBe(true);

  const mail = await readNthMail(request, localPart, 1);

  expect(
    collapse(mail.html).includes(customMessage) || collapse(mail.text).includes(customMessage),
    'the reminder carries the custom message unchanged',
  ).toBe(true);
  expectMailHasNoSender(mail, scenario, 'reminder with custom message');
});

test('C4 the V1 signing page shows the team name and contains no sender', async ({ page }) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const { recipient } = await seedPending(scenario, 'c4', 1);

  await openV1SigningPage(page, recipient.token);

  await expectPageHasNoSender(page, scenario, 'V1 /sign');
  await expect(page.getByText(scenario.teamName).first()).toBeVisible();
});

test('C5 the V2 signing page contains no sender', async ({ page }) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const { recipient, title } = await seedPending(scenario, 'c5', 2);

  await page.goto(`/sign/${recipient.token}`);

  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
  // The title is rendered more than once, in headers hidden at some widths; one copy must be visible.
  await expect(page.getByText(title).filter({ visible: true }).first()).toBeVisible();
  await expectPageHasNoSender(page, scenario, 'V2 /sign');
});

test('C6 the completion page after signing contains no sender', async ({ page }) => {
  const scenario = await seedScenario(SETTING_FALSE);

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: scenario.user,
    teamId: scenario.team.id,
    recipients: [addressFor(uniqueLocalPart('c6'))],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 1, title: `Sdocc6${uniqueToken()}` },
  });
  const recipient = recipients[0];

  await signV1AsRecipient(page, recipient);

  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible({ timeout: 30_000 });
  await expectPageHasNoSender(page, scenario, '/sign/<token>/complete');
});

test('C7 the embedded signing page for a V1 and a V2 document contains no sender', async ({ page }) => {
  const scenario = await seedScenario(SETTING_FALSE);

  for (const internalVersion of [1, 2] as const) {
    const { recipient } = await seedPending(scenario, `c7v${internalVersion}`, internalVersion);

    await page.goto(`/embed/sign/${recipient.token}`);

    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
    await expectPageHasNoSender(page, scenario, `V${internalVersion} /embed/sign`);
  }
});

test('C8 the V2 direct template page contains no sender', async ({ page }) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const title = `Stpl${uniqueToken()}`;

  const template = await seedDirectTemplate({
    title,
    userId: scenario.user.id,
    teamId: scenario.team.id,
    internalVersion: 2,
  });

  await page.goto(formatDirectTemplatePath(template.directLink?.token || ''));

  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
  // The title is rendered more than once, in headers hidden at some widths; one copy must be visible.
  await expect(page.getByText(title).filter({ visible: true }).first()).toBeVisible();
  await expectPageHasNoSender(page, scenario, 'V2 /d/<token>');
});

test('C9 with the setting true the invitation and the manual reminder name the sender on behalf of the team', async ({
  request,
}) => {
  const scenario = await seedScenario(SETTING_TRUE);
  const token = await apiTokenFor(scenario);
  const { documentId, recipient, localPart, title } = await seedDraftForSend(scenario, 'c9');

  const sent = await v1Send(request, token, documentId);

  expect(sent.ok(), `v1 send: ${sent.status()} ${await sent.text()}`).toBe(true);

  const invitation = await readNthMail(request, localPart, 1);

  expectMailNamesSenderOnBehalfOfTeam(invitation, scenario, 'invitation');

  const resent = await v1Resend(request, token, documentId, [recipient.id]);

  expect(resent.ok(), `v1 resend: ${resent.status()} ${await resent.text()}`).toBe(true);

  const reminder = await readNthMail(request, localPart, 2);

  expectMailNamesSenderOnBehalfOfTeam(reminder, scenario, 'reminder');
  expectReminderPartsNameSenderOnBehalfOfTeam(reminder, scenario, title, 'reminder');
});

test('C10 with the setting true the V1 signing page shows the sender name and email', async ({ page }) => {
  const scenario = await seedScenario(SETTING_TRUE);
  const { recipient } = await seedPending(scenario, 'c10', 1);

  await openV1SigningPage(page, recipient.token);

  await expect(page.getByText(scenario.senderName).first()).toBeVisible();
  await expect(page.getByText(scenario.senderEmail).first()).toBeVisible();
});

test('C11 team value false over organisation true hides the sender on the reminder and the V1 page', async ({
  page,
  request,
}) => {
  const scenario = await seedScenario({ organisation: true, team: false });
  const token = await apiTokenFor(scenario);

  const { document, recipient, localPart } = await seedPending(scenario, 'c11', 1);

  const res = await v1Resend(request, token, mapSecondaryIdToDocumentId(document.secondaryId), [recipient.id]);

  expect(res.ok(), `v1 resend: ${res.status()} ${await res.text()}`).toBe(true);

  const mail = await readNthMail(request, localPart, 1);

  expectMailNamesTeam(mail, scenario, 'reminder');
  expectMailHasNoSender(mail, scenario, 'reminder');

  await openV1SigningPage(page, recipient.token);

  await expectPageHasNoSender(page, scenario, 'V1 /sign');
  await expect(page.getByText(scenario.teamName).first()).toBeVisible();
});

test('C12 the multisign embed contains no sender', async ({ page }) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const first = await seedPending(scenario, 'c12a', 1);
  // Multi-sign offers V1 envelopes only since #142, so both envelopes are V1.
  const second = await seedPending(scenario, 'c12b', 1);

  await page.goto(`/embed/v1/multisign?token=${first.recipient.token}&token=${second.recipient.token}`);

  await expect(page.getByText(first.title)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(second.title)).toBeVisible();
  await expectPageHasNoSender(page, scenario, '/embed/v1/multisign list');

  for (const { title } of [first, second]) {
    // The innermost div holding both the title and its View button is the row. An unhydrated click is a no-op,
    // so retry until the signing view for this title opens.
    const viewButton = page
      .locator('div')
      .filter({ has: page.getByText(title, { exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'View', exact: true }) })
      .last()
      .getByRole('button', { name: 'View', exact: true });

    await expect(async () => {
      await viewButton.click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
    await expectPageHasNoSender(page, scenario, `/embed/v1/multisign document ${title}`);

    await page.goto(`/embed/v1/multisign?token=${first.recipient.token}&token=${second.recipient.token}`);
    await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 });
  }
});

test('C13 the V2 direct template embed contains no sender', async ({ page }) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const title = `Stplembed${uniqueToken()}`;

  const template = await seedDirectTemplate({
    title,
    userId: scenario.user.id,
    teamId: scenario.team.id,
    internalVersion: 2,
  });

  await page.goto(`/embed/direct/${template.directLink?.token || ''}`);

  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
  await expectPageHasNoSender(page, scenario, 'V2 /embed/direct/<token>');
});

test('C14 a personal account still shows the sender on the V1 signing page and in a reminder', async ({
  page,
  request,
}) => {
  // The personal organisation keeps its default settings: the form hides includeSenderDetails for it.
  const scenario = await seedScenario(SETTING_FALSE, { personal: true });
  const token = await apiTokenFor(scenario);

  const { document, recipient, localPart, title } = await seedPending(scenario, 'c14', 1);

  await openV1SigningPage(page, recipient.token);

  await expect(page.getByText(scenario.senderName).first()).toBeVisible();
  await expect(page.getByText(scenario.senderEmail).first()).toBeVisible();

  const res = await v1Resend(request, token, mapSecondaryIdToDocumentId(document.secondaryId), [recipient.id]);

  expect(res.ok(), `v1 resend: ${res.status()} ${await res.text()}`).toBe(true);

  const mail = await readNthMail(request, localPart, 1);

  expect(mail.html.includes(title) || mail.text.includes(title), 'the reminder is for this document').toBe(true);
  expect(
    mail.html.includes(scenario.senderName) || mail.text.includes(scenario.senderName),
    'the personal-account reminder names the sender',
  ).toBe(true);
});

test('C15 the owner added as a recipient can sign and receives the completed-document email', async ({
  page,
  request,
}) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const otherLocalPart = uniqueLocalPart('c15other');
  const ownerLocalPart = scenario.senderEmail.split('@')[0];
  const title = `Sdocc15${uniqueToken()}`;

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: scenario.user,
    teamId: scenario.team.id,
    recipients: [scenario.user, addressFor(otherLocalPart)],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 1, title },
  });

  const ownerRecipient = recipients.find((r) => r.email === scenario.senderEmail);
  const otherRecipient = recipients.find((r) => r.email === addressFor(otherLocalPart));

  if (!ownerRecipient || !otherRecipient) {
    throw new Error('premise: the owner and the other signer are both recipients');
  }

  expect(await readMailbox(request, ownerLocalPart), 'premise: the owner mailbox starts empty').toHaveLength(0);

  await signV1AsRecipient(page, ownerRecipient);
  await signV1AsRecipient(page, otherRecipient);

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: document.id } })).status, {
      timeout: 60_000,
    })
    .toBe('COMPLETED');

  let found: MailContent | null = null;

  await expect
    .poll(
      async () => {
        for (const entry of await readMailbox(request, ownerLocalPart)) {
          const mail = await readMessage(ownerLocalPart, entry);

          if (`${mail.subject}\n${mail.html}\n${mail.text}`.includes(title)) {
            found = mail;

            return true;
          }
        }

        return false;
      },
      { message: 'the owner receives an email about the completed document', timeout: 60_000 },
    )
    .toBe(true);

  expect(found, 'the completed-document email was read').not.toBeNull();
});

/*
 * C16 to C22: lifecycle emails and the sealed audit pages (Q21, Q22).
 *
 * Owner actions go through the tRPC procedures the document pages call, over
 * HTTP with the owner's session and the team header, as the browser sends
 * them. The rejection goes through the public recipient.rejectDocumentWithToken
 * procedure the signing page's Reject dialog calls.
 *
 * Mail is found by subject rather than by count, since one action can mail
 * several people and the order of arrival is not promised.
 */

const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();

/** Posts a tRPC mutation the way the web client does and returns the decoded `json` result. */
const trpcMutation = async (
  request: APIRequestContext,
  procedure: string,
  input: Record<string, unknown>,
  teamId?: number,
) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (teamId !== undefined) {
    headers['x-team-id'] = String(teamId);
  }

  const res = await request.post(`${WEBAPP_URL}/api/trpc/${procedure}`, {
    headers,
    data: JSON.stringify({ json: input }),
  });
  const text = await res.text();

  expect(res.ok(), `${procedure}: ${res.status()} ${text}`).toBe(true);

  return (JSON.parse(text) as { result?: { data?: { json?: unknown } } }).result?.data?.json;
};

/** Signs the sender in on `page` and returns the request context that carries the session. */
const signInAsSender = async (page: Page, scenario: Scenario) => {
  await apiSignin({ page, email: scenario.senderEmail, redirectPath: `/t/${scenario.team.url}/documents` });

  return page.context().request;
};

/** Waits for a message whose subject matches `subject` and returns its content. */
const waitForMailWithSubject = async (
  request: APIRequestContext,
  localPart: string,
  subject: RegExp,
  context: string,
): Promise<MailContent> => {
  await expect
    .poll(async () => (await readMailbox(request, localPart)).some((entry) => subject.test(entry.subject)), {
      message: `${context}: ${localPart} receives an email with a subject matching ${subject}`,
      timeout: 30_000,
    })
    .toBe(true);

  const entry = (await readMailbox(request, localPart)).find((message) => subject.test(message.subject));

  if (!entry) {
    throw new Error(`${context}: the email matching ${subject} is no longer in ${localPart}`);
  }

  return await readMessage(localPart, entry);
};

const expectMailIsAbout = (mail: MailContent, title: string, context: string) => {
  expect(`${mail.subject}\n${mail.html}\n${mail.text}`.includes(title), `${context}: the email is about ${title}`).toBe(
    true,
  );
};

const expectMailNamesSender = (mail: MailContent, scenario: Scenario, context: string) => {
  const all = `${mail.subject}\n${mail.html}\n${mail.text}`;

  expect(
    all.includes(scenario.senderName) || all.toLowerCase().includes(scenario.senderEmail),
    `${context}: the email names the sender`,
  ).toBe(true);
};

/** The preview text: the first display:none div of the HTML body. Throws when there is none. */
const readPreview = (mail: MailContent, context: string) => {
  const preview = /<div[^>]*display:\s*none[^>]*>([\s\S]*?)<\/div>/i.exec(mail.html);

  if (!preview) {
    throw new Error(`${context}: no display:none preview div in the HTML body`);
  }

  return textOf(preview[1]);
};

const REJECTION_CONFIRMED = /Rejection Confirmed/i;
const CANCELLED = /Cancell?ed/i;
const REMOVED = /removed from a document/i;

/** A pending V1 document with two signers, each on a mailbox of their own. */
const seedPendingPair = async (scenario: Scenario, label: string) => {
  const firstLocalPart = uniqueLocalPart(`${label}a`);
  const secondLocalPart = uniqueLocalPart(`${label}b`);
  const title = `Sdoc${label}${uniqueToken()}`;

  const document = await seedPendingDocument(
    scenario.user,
    scenario.team.id,
    [addressFor(firstLocalPart), addressFor(secondLocalPart)],
    { internalVersion: 1, createDocumentOptions: { title } },
  );

  const first = document.recipients.find((r) => r.email === addressFor(firstLocalPart));
  const second = document.recipients.find((r) => r.email === addressFor(secondLocalPart));

  if (!first || !second) {
    throw new Error('premise: both signers are recipients of the seeded document');
  }

  return { document, first, second, firstLocalPart, secondLocalPart, title };
};

/**
 * The seed inserts every recipient's fields, which counts as having interacted
 * with the document; the owner may then neither remove that recipient nor
 * resend the others unchanged through the editor update. Resets every field so
 * that no recipient has acted yet.
 */
const leaveRecipientsUntouched = async (pair: Awaited<ReturnType<typeof seedPendingPair>>) => {
  await prisma.field.updateMany({ where: { envelopeId: pair.document.id }, data: { inserted: false, customText: '' } });

  const recipients = await prisma.recipient.findMany({
    where: { envelopeId: pair.document.id },
    include: { fields: true },
  });

  for (const recipient of recipients) {
    expect(recipient.signingStatus, `premise: ${recipient.email} has not signed`).toBe(SigningStatus.NOT_SIGNED);
    expect(
      recipient.fields.some((field) => field.inserted),
      `premise: ${recipient.email} has inserted no field`,
    ).toBe(false);
  }
};

/** Rejects as the first signer through the procedure the signing page's Reject dialog calls. */
const rejectAsFirst = async (request: APIRequestContext, pair: Awaited<ReturnType<typeof seedPendingPair>>) => {
  await trpcMutation(request, 'recipient.rejectDocumentWithToken', {
    token: pair.first.token,
    documentId: mapSecondaryIdToDocumentId(pair.document.secondaryId),
    reason: 'The figures in schedule two are wrong',
  });
};

test('C16 C17 a rejection: the confirmation and the cancellation to the others contain no sender', async ({
  request,
}) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const pair = await seedPendingPair(scenario, 'c16');

  await rejectAsFirst(request, pair);

  const confirmation = await waitForMailWithSubject(request, pair.firstLocalPart, REJECTION_CONFIRMED, 'C16');

  expectMailIsAbout(confirmation, pair.title, 'C16 rejection confirmation');
  expectMailNamesTeam(confirmation, scenario, 'C16 rejection confirmation');
  expectMailHasNoSender(confirmation, scenario, 'C16 rejection confirmation');

  const cancellation = await waitForMailWithSubject(request, pair.secondLocalPart, CANCELLED, 'C17');
  const preview = readPreview(cancellation, 'C17 cancellation');

  expect(preview.length, 'C17 cancellation: the preview is not empty').toBeGreaterThan(0);
  expectNoSenderIn(preview, scenario, 'C17 cancellation: preview');
  expectMailIsAbout(cancellation, pair.title, 'C17 cancellation');
  expectMailNamesTeam(cancellation, scenario, 'C17 cancellation');
  expectMailHasNoSender(cancellation, scenario, 'C17 cancellation');
});

test('C16 C17 with the setting true the rejection confirmation and the cancellation name the sender', async ({
  request,
}) => {
  const scenario = await seedScenario(SETTING_TRUE);
  const pair = await seedPendingPair(scenario, 'c16t');

  await rejectAsFirst(request, pair);

  const confirmation = await waitForMailWithSubject(request, pair.firstLocalPart, REJECTION_CONFIRMED, 'C16 true');

  expectMailIsAbout(confirmation, pair.title, 'C16 true rejection confirmation');
  expectMailNamesSender(confirmation, scenario, 'C16 true rejection confirmation');

  const cancellation = await waitForMailWithSubject(request, pair.secondLocalPart, CANCELLED, 'C17 true');

  expectMailIsAbout(cancellation, pair.title, 'C17 true cancellation');
  expectMailNamesSender(cancellation, scenario, 'C17 true cancellation');
});

test('C18 the owner cancelling a pending document sends recipients a cancellation with no sender', async ({
  page,
  request,
}) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const { document, localPart, title } = await seedPending(scenario, 'c18', 1);
  const session = await signInAsSender(page, scenario);

  await trpcMutation(session, 'envelope.cancel', { envelopeId: document.id }, scenario.team.id);

  const mail = await waitForMailWithSubject(request, localPart, CANCELLED, 'C18');

  expectMailIsAbout(mail, title, 'C18 cancellation');
  expectMailHasNoSender(mail, scenario, 'C18 cancellation');
});

test('C19 the owner deleting a pending document sends recipients a cancellation with no sender', async ({
  page,
  request,
}) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const { document, localPart, title } = await seedPending(scenario, 'c19', 1);
  const session = await signInAsSender(page, scenario);

  // A pending document is hard-deleted, so nothing below reads it back.
  await trpcMutation(session, 'envelope.delete', { envelopeId: document.id }, scenario.team.id);

  const mail = await waitForMailWithSubject(request, localPart, CANCELLED, 'C19');

  expectMailIsAbout(mail, title, 'C19 cancellation');
  expectMailHasNoSender(mail, scenario, 'C19 cancellation');
});

test('C20 a recipient removed through the editor recipient update gets an email with no sender', async ({
  page,
  request,
}) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const pair = await seedPendingPair(scenario, 'c20set');

  await leaveRecipientsUntouched(pair);

  const session = await signInAsSender(page, scenario);

  await trpcMutation(
    session,
    'recipient.setDocumentRecipients',
    {
      documentId: mapSecondaryIdToDocumentId(pair.document.secondaryId),
      recipients: [{ id: pair.first.id, email: pair.first.email, name: pair.first.name, role: RecipientRole.SIGNER }],
    },
    scenario.team.id,
  );

  const mail = await waitForMailWithSubject(request, pair.secondLocalPart, REMOVED, 'C20 editor update');

  expectMailNamesTeam(mail, scenario, 'C20 editor update removal');
  expectMailHasNoSender(mail, scenario, 'C20 editor update removal');
});

test('C20 a recipient removed through the single-recipient delete gets an email with no sender', async ({
  page,
  request,
}) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const pair = await seedPendingPair(scenario, 'c20del');

  await leaveRecipientsUntouched(pair);

  const session = await signInAsSender(page, scenario);

  await trpcMutation(session, 'envelope.recipient.delete', { recipientId: pair.second.id }, scenario.team.id);

  const mail = await waitForMailWithSubject(request, pair.secondLocalPart, REMOVED, 'C20 single delete');

  expectMailNamesTeam(mail, scenario, 'C20 single delete removal');
  expectMailHasNoSender(mail, scenario, 'C20 single delete removal');
});

/**
 * Sends a V1 document to two named signers through API v1, so the audit log
 * holds events the sender performed, with the organisation printing the audit
 * log into the sealed PDF. With `ownerAsSigner` the owner is a third signer.
 */
const sendWithAuditLog = async (
  request: APIRequestContext,
  scenario: Scenario,
  options: { ownerAsSigner?: boolean } = {},
) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: scenario.organisation.organisationGlobalSettingsId },
    data: { includeAuditLog: true },
  });

  const id = uniqueToken();
  const title = `Sdocc21${id}`;
  const signers = [
    { email: addressFor(uniqueLocalPart('c21a')), name: `Qorvarecipa${id}` },
    { email: addressFor(uniqueLocalPart('c21b')), name: `Qorvarecipb${id}` },
    ...(options.ownerAsSigner ? [{ email: scenario.senderEmail, name: scenario.senderName }] : []),
  ];

  const document = await seedDraftDocument(
    scenario.user,
    scenario.team.id,
    signers.map((s) => s.email),
    { internalVersion: 1, createDocumentOptions: { title } },
  );

  for (const signer of signers) {
    const recipient = await prisma.recipient.findFirstOrThrow({
      where: { envelopeId: document.id, email: signer.email },
    });

    await prisma.recipient.update({ where: { id: recipient.id }, data: { name: signer.name } });
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
  }

  const apiToken = await apiTokenFor(scenario);
  const sent = await v1Send(request, apiToken, mapSecondaryIdToDocumentId(document.secondaryId));

  expect(sent.ok(), `v1 send: ${sent.status()} ${await sent.text()}`).toBe(true);

  const recipients = await prisma.recipient.findMany({ where: { envelopeId: document.id }, include: { fields: true } });

  expect(recipients, 'premise: every signer is a recipient').toHaveLength(signers.length);

  return { document, recipients, signers, title, apiToken, envelopeItemId: document.envelopeItems[0].id };
};

/** sendWithAuditLog, then signs as every recipient and waits for COMPLETED. */
const sendAndCompleteWithAuditLog = async (
  page: Page,
  request: APIRequestContext,
  scenario: Scenario,
  options: { ownerAsSigner?: boolean } = {},
) => {
  const sent = await sendWithAuditLog(request, scenario, options);

  for (const recipient of sent.recipients) {
    await signV1AsRecipient(page, recipient);
  }

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: sent.document.id } })).status, {
      message: 'the document is sealed and COMPLETED',
      timeout: 60_000,
    })
    .toBe('COMPLETED');

  return sent;
};

/** The signed PDF as a recipient downloads it with their token. */
const downloadSignedWithToken = async (request: APIRequestContext, token: string, envelopeItemId: string) => {
  const res = await request.get(
    `${WEBAPP_URL}/api/files/token/${token}/envelopeItem/${envelopeItemId}/download/signed`,
  );

  expect(res.ok(), `signed download with a recipient token: ${res.status()}`).toBe(true);

  const body = await res.body();

  expect(body.subarray(0, 5).toString(), 'the signed download is a PDF').toBe('%PDF-');

  return new Uint8Array(body);
};

/**
 * PDF text two ways: with whitespace collapsed, and with all whitespace
 * removed, because a name or an email in a narrow cell can wrap across lines.
 * Negative checks run against both; positive anchors against the second.
 */
const pdfTexts = (bytes: Uint8Array) => {
  const raw = rawPdfText(bytes);
  const flat = raw.replace(/\s+/g, ' ');

  return { raw, flat, joined: flat.replace(/\s+/g, '') };
};

/*
 * The audit pages have two renderers: the default, in the server process, and
 * the Playwright one, used when the server starts with
 * NEXT_PRIVATE_USE_PLAYWRIGHT_PDF=true. That is a server environment variable,
 * which this suite cannot switch per test, so these tests exercise whichever
 * path the server under test runs, the default one locally. Nothing here
 * depends on which; run the file against a server started with the variable
 * to cover the other path.
 */
test('C21 C22 the sealed audit pages contain no sender and name the team; the owner audit log names the sender', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  const scenario = await seedScenario(SETTING_FALSE);
  const { document, recipients, signers, title, envelopeItemId } = await sendAndCompleteWithAuditLog(
    page,
    request,
    scenario,
  );

  const sealed = pdfTexts(await downloadSignedWithToken(request, recipients[0].token, envelopeItemId));

  expect(sealed.joined.includes(title), 'C21: the sealed PDF is this document').toBe(true);
  expect(sealed.joined.includes(scenario.teamName), 'C21: the audit pages name the team').toBe(true);

  for (const signer of signers) {
    expect(sealed.joined.includes(signer.name), `C21: the audit pages still name the recipient ${signer.name}`).toBe(
      true,
    );
  }

  expectNoSenderIn(sealed.flat, scenario, 'C21 sealed PDF text');
  expectNoSenderIn(sealed.joined, scenario, 'C21 sealed PDF text without whitespace');

  const session = await signInAsSender(page, scenario);
  const auditLog = (await trpcMutation(
    session,
    'document.auditLog.download',
    { envelopeId: document.id },
    scenario.team.id,
  )) as { data?: unknown; envelopeTitle?: unknown } | undefined;

  if (typeof auditLog?.data !== 'string') {
    throw new Error(`C22: document.auditLog.download returned no base64 data: ${JSON.stringify(auditLog)}`);
  }

  expect(auditLog.envelopeTitle, 'C22: the audit log is for this document').toBe(title);

  const ownerBytes = Buffer.from(auditLog.data, 'base64');

  expect(ownerBytes.subarray(0, 5).toString(), 'C22: the audit log download is a PDF').toBe('%PDF-');

  const ownerLog = pdfTexts(new Uint8Array(ownerBytes));

  expect(ownerLog.joined.includes(scenario.senderName), "C22: the owner's audit log names the sender").toBe(true);
});

test('C21 with the setting true the sealed audit pages name the sender', async ({ page, request }) => {
  test.setTimeout(240_000);

  const scenario = await seedScenario(SETTING_TRUE);
  const { recipients, title, envelopeItemId } = await sendAndCompleteWithAuditLog(page, request, scenario);

  const sealed = pdfTexts(await downloadSignedWithToken(request, recipients[0].token, envelopeItemId));

  expect(sealed.joined.includes(title), 'C21 true: the sealed PDF is this document').toBe(true);
  expect(sealed.joined.includes(scenario.senderName), 'C21 true: the audit pages name the sender').toBe(true);
});

type Person = { name: string; email: string };

/** Neither the person's name nor email appears in `haystack`. */
const expectNoPersonIn = (haystack: string, person: Person, context: string) => {
  expect(haystack.includes(person.name), `${context} must not contain ${person.name}`).toBe(false);
  expect(
    haystack.toLowerCase().includes(person.email.toLowerCase()),
    `${context} must not contain ${person.email}`,
  ).toBe(false);
};

/**
 * Waits for the rejected document to be sealed and returns the sealed PDF's
 * text. The status can change before the seal job has written the sealed PDF.
 * The title is printed only on the audit pages, not in the seeded PDF, so the
 * download is retried until it carries them.
 */
const readRejectedSeal = async (
  request: APIRequestContext,
  sealed: { envelopeId: string; token: string; envelopeItemId: string; title: string },
) => {
  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: sealed.envelopeId } })).status, {
      message: 'the document is REJECTED',
      timeout: 60_000,
    })
    .toBe('REJECTED');

  let sealedBytes = new Uint8Array();

  await expect
    .poll(
      async () => {
        sealedBytes = await downloadSignedWithToken(request, sealed.token, sealed.envelopeItemId);

        return pdfTexts(sealedBytes).joined.includes(sealed.title);
      },
      { message: 'the rejected document is sealed with its audit pages', timeout: 60_000 },
    )
    .toBe(true);

  return pdfTexts(sealedBytes);
};

/** Rejects for `recipient` through API v2 reject-on-behalf, then returns the sealed PDF's text. */
const rejectOnBehalfOfAndReadSealed = async (
  request: APIRequestContext,
  options: {
    apiToken: string;
    document: { id: string };
    recipient: { id: number; token: string };
    envelopeItemId: string;
    title: string;
    actAsEmail?: string;
  },
) => {
  const res = await request.post(`${V2_URL}/envelope/recipient/${options.recipient.id}/reject`, {
    headers: jsonHeaders(options.apiToken),
    data: {
      envelopeId: options.document.id,
      recipientId: options.recipient.id,
      reason: 'Declined by telephone',
      ...(options.actAsEmail ? { actAsEmail: options.actAsEmail } : {}),
    },
  });

  expect(res.ok(), `reject on behalf of: ${res.status()} ${await res.text()}`).toBe(true);

  return await readRejectedSeal(request, {
    envelopeId: options.document.id,
    token: options.recipient.token,
    envelopeItemId: options.envelopeItemId,
    title: options.title,
  });
};

/**
 * Descriptions of actions only the owner takes, in the catalogue's English
 * ("{user} sent the document", "{user} updated a recipient", ...), with the
 * whitespace removed to match the whitespace-removed PDF text.
 */
const OWNER_ACTION_DESCRIPTIONS = [
  'sentthedocument',
  'createdthedocument',
  'sentanemailto',
  'addeda',
  'updateda',
  'updatedthe',
  'updatedan',
];

test('C23 the owner as a signer: the sealed audit pages show the team for their sending and editing entries', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  const scenario = await seedScenario(SETTING_FALSE);
  const { recipients, signers, title, envelopeItemId } = await sendAndCompleteWithAuditLog(page, request, scenario, {
    ownerAsSigner: true,
  });

  const other = recipients.find((r) => r.email !== scenario.senderEmail);

  if (!other) {
    throw new Error('premise: a signer other than the owner exists');
  }

  const sealed = pdfTexts(await downloadSignedWithToken(request, other.token, envelopeItemId));
  const joinedLower = sealed.joined.toLowerCase();

  expect(sealed.joined.includes(title), 'C23: the sealed PDF is this document').toBe(true);
  expect(
    sealed.joined.includes(`${scenario.teamName}sentthedocument`),
    'C23: the audit pages read "<team> sent the document"',
  ).toBe(true);

  for (const description of OWNER_ACTION_DESCRIPTIONS) {
    expect(
      sealed.joined.includes(`${scenario.senderName}${description}`),
      `C23: no "${scenario.senderName} ${description}..." entry in the audit pages`,
    ).toBe(false);
    expect(
      joinedLower.includes(`${scenario.senderEmail}${description}`),
      `C23: no "${scenario.senderEmail} ${description}..." entry in the audit pages`,
    ).toBe(false);
  }

  for (const signer of signers.filter((s) => s.email !== scenario.senderEmail)) {
    expect(sealed.joined.includes(signer.name), `C23: the audit pages still name the recipient ${signer.name}`).toBe(
      true,
    );
  }
});

test('C24 a rejection on behalf of a recipient, attributed to a team member, names neither in the sealed audit pages', async ({
  request,
}) => {
  test.setTimeout(240_000);

  const scenario = await seedScenario(SETTING_FALSE);
  const member = await seedTeamMember({ teamId: scenario.team.id, name: `Wexmember${uniqueToken()}` });
  const elected: Person = { name: member.name ?? '', email: member.email };

  expect(elected.name.startsWith('Wexmember'), 'premise: the elected member has the unique name').toBe(true);

  const { document, recipients, signers, title, apiToken, envelopeItemId } = await sendWithAuditLog(request, scenario);
  const rejected = recipients[0];

  const sealed = await rejectOnBehalfOfAndReadSealed(request, {
    apiToken,
    document,
    recipient: rejected,
    envelopeItemId,
    title,
    actAsEmail: elected.email,
  });
  const owner: Person = { name: scenario.senderName, email: scenario.senderEmail };

  expect(sealed.joined.includes(title), 'C24: the sealed PDF is this document').toBe(true);
  expect(sealed.joined.includes(scenario.teamName), 'C24: the audit pages name the team').toBe(true);
  expect(
    sealed.joined.includes(signers[0].name) || sealed.joined.includes(signers[1].name),
    'C24: the audit pages still name the recipients',
  ).toBe(true);

  for (const [label, person] of [
    ['owner', owner],
    ['elected member', elected],
  ] as const) {
    expectNoPersonIn(sealed.flat, person, `C24 sealed PDF text (${label})`);
    expectNoPersonIn(sealed.joined, person, `C24 sealed PDF text without whitespace (${label})`);
  }
});

/**
 * C25: the owner is a signer and rejects another signer through API v2
 * reject-on-behalf, electing `electedMember` or no one. The owner's name and
 * email legitimately appear elsewhere in the audit pages, as a recipient, so
 * the owner is checked on the rejection entry only; an elected member who is
 * not a recipient is checked on the whole PDF as well.
 */
const expectExternalRejectionNamesNoMember = async (request: APIRequestContext, electMember: boolean) => {
  const scenario = await seedScenario(SETTING_FALSE);
  const owner: Person = { name: scenario.senderName, email: scenario.senderEmail };
  let elected: Person | undefined;

  if (electMember) {
    const member = await seedTeamMember({ teamId: scenario.team.id, name: `Wexmember${uniqueToken()}` });

    elected = { name: member.name ?? '', email: member.email };

    expect(elected.name.startsWith('Wexmember'), 'premise: the elected member has the unique name').toBe(true);
  }

  const { document, recipients, signers, title, apiToken, envelopeItemId } = await sendWithAuditLog(request, scenario, {
    ownerAsSigner: true,
  });
  const rejected = recipients.find((r) => r.email !== scenario.senderEmail);

  if (!rejected) {
    throw new Error('premise: a signer other than the owner exists');
  }

  expect(
    recipients.some((r) => r.email === scenario.senderEmail),
    'premise: the owner is a signer on the document',
  ).toBe(true);

  const sealed = await rejectOnBehalfOfAndReadSealed(request, {
    apiToken,
    document,
    recipient: rejected,
    envelopeItemId,
    title,
    actAsEmail: elected?.email,
  });
  const label = electMember ? 'C25 elected' : 'C25';

  expect(sealed.joined.includes(title), `${label}: the sealed PDF is this document`).toBe(true);
  expect(sealed.joined.includes(scenario.teamName), `${label}: the audit pages name the team`).toBe(true);
  expect(
    signers.filter((s) => s.email !== scenario.senderEmail).some((s) => sealed.joined.includes(s.name)),
    `${label}: the audit pages still name the recipients`,
  ).toBe(true);

  const entry = auditEntry(sealed.raw, 'DOCUMENT RECIPIENT REJECTED');

  expect(entry.joined.includes('rejectedexternally'), `${label}: the entry is the external rejection`).toBe(true);

  const people: [string, Person][] = [['owner', owner]];

  if (elected) {
    people.push(['elected member', elected]);
  }

  for (const [who, person] of people) {
    expectNoPersonIn(entry.flat, person, `${label} rejection entry (${who})`);
    expectNoPersonIn(entry.joined, person, `${label} rejection entry without whitespace (${who})`);
  }

  if (elected) {
    expectNoPersonIn(sealed.flat, elected, `${label} sealed PDF text (elected member)`);
    expectNoPersonIn(sealed.joined, elected, `${label} sealed PDF text without whitespace (elected member)`);
  }
};

test('C25 an external rejection by the owner who is also a signer names no team member in the sealed audit pages', async ({
  request,
}) => {
  test.setTimeout(240_000);

  await expectExternalRejectionNamesNoMember(request, false);
});

test('C25 an external rejection by the owner-signer electing a team member names neither in the sealed audit pages', async ({
  request,
}) => {
  test.setTimeout(240_000);

  await expectExternalRejectionNamesNoMember(request, true);
});

test('C26 a document created through API v2 with a delegated owner names neither the delegate nor the token user in the sealed audit pages', async ({
  request,
}) => {
  test.setTimeout(240_000);

  const scenario = await seedScenario(SETTING_FALSE);

  await prisma.organisationGlobalSettings.update({
    where: { id: scenario.organisation.organisationGlobalSettingsId },
    data: { includeAuditLog: true, delegateDocumentOwnership: true },
  });

  const id = uniqueToken();
  const delegateUser = await seedTeamMember({ teamId: scenario.team.id, name: `Wexdelegate${id}` });
  const delegate: Person = { name: delegateUser.name ?? '', email: delegateUser.email };
  const tokenUser: Person = { name: scenario.senderName, email: scenario.senderEmail };

  expect(delegate.name.startsWith('Wexdelegate'), 'premise: the delegated owner has the unique name').toBe(true);

  const apiToken = await apiTokenFor(scenario);
  const title = `Sdocc26${id}`;
  const signers = [
    { email: addressFor(uniqueLocalPart('c26a')), name: `Qorvarecipa${id}` },
    { email: addressFor(uniqueLocalPart('c26b')), name: `Qorvarecipb${id}` },
  ];

  const formData = new FormData();

  formData.append(
    'payload',
    JSON.stringify({
      type: 'DOCUMENT',
      title,
      delegatedDocumentOwner: delegate.email,
      recipients: signers.map((signer) => ({
        email: signer.email,
        name: signer.name,
        role: RecipientRole.SIGNER,
        fields: [{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 60, width: 25, height: 8 }],
      })),
    }),
  );

  const pdfData = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

  // The V2 audit pages print the file name, not the document title, so the file
  // carries the title and the seal wait below can find it.
  formData.append('files', new File([pdfData], `${title}.pdf`, { type: 'application/pdf' }));

  const created = await request.post(`${V2_URL}/envelope/create`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    multipart: formData,
  });

  expect(created.ok(), `v2 envelope create: ${created.status()} ${await created.text()}`).toBe(true);

  const { id: envelopeId } = (await created.json()) as { id: string };
  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { envelopeItems: true },
  });

  expect(envelope.userId, 'premise: the delegated owner owns the document').toBe(delegateUser.id);
  expect(
    await prisma.documentAuditLog.count({ where: { envelopeId, type: 'DOCUMENT_DELEGATED_OWNER_CREATED' } }),
    'premise: the delegation is recorded in the audit log',
  ).toBe(1);

  const distributed = await request.post(`${V2_URL}/envelope/distribute`, {
    headers: jsonHeaders(apiToken),
    data: { envelopeId },
  });

  expect(distributed.ok(), `v2 distribute: ${distributed.status()} ${await distributed.text()}`).toBe(true);

  const rejected = await prisma.recipient.findFirstOrThrow({ where: { envelopeId, email: signers[0].email } });

  await trpcMutation(request, 'recipient.rejectDocumentWithToken', {
    token: rejected.token,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    reason: 'The figures in schedule two are wrong',
  });

  const sealed = await readRejectedSeal(request, {
    envelopeId,
    token: rejected.token,
    envelopeItemId: envelope.envelopeItems[0].id,
    title,
  });

  expect(sealed.joined.includes(title), 'C26: the sealed PDF is this document').toBe(true);
  expect(sealed.joined.includes(scenario.teamName), 'C26: the audit pages name the team').toBe(true);
  expect(sealed.joined.includes(signers[0].name), 'C26: the audit pages still name the recipients').toBe(true);

  const entry = auditEntry(sealed.raw, 'DOCUMENT DELEGATED OWNER CREATED');

  for (const [who, person] of [
    ['delegated owner', delegate],
    ['token user', tokenUser],
  ] as const) {
    expectNoPersonIn(sealed.flat, person, `C26 sealed PDF text (${who})`);
    expectNoPersonIn(sealed.joined, person, `C26 sealed PDF text without whitespace (${who})`);
  }

  expect(entry.joined.includes(scenario.teamName), 'C26: the delegation entry names the team').toBe(true);
});
