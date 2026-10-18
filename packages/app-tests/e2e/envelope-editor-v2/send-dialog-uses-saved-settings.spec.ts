/**
 * The send dialog sends the subject and message saved in Settings.
 *
 * Criteria C1 to C7. Each test
 * seeds a V2 draft with one signer at a unique Inbucket address and one signature
 * field, signs in as the owner, and drives the editor and the send dialog as a user does.
 *
 * Email is observed in Inbucket and saved values are read from documentMeta in Prisma.
 * The send dialog's form fields carry no test ids, so they are found by name inside
 * the open dialog; the Email and None tabs are found by their role and label.
 */
import { FIELD_SIGNATURE_META_DEFAULT_VALUES } from '@documenso/lib/types/field-meta';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDistributionMethod, DocumentStatus, FieldType } from '@prisma/client';

import { apiSignin } from '../fixtures/authentication';
import { getEnvelopeEditorSettingsTrigger, setRecipientName } from '../fixtures/envelope-editor';
import { expectToastTextToBeVisible } from '../fixtures/generic';
import {
  addressFor,
  assertMailCatcherReachable,
  expectNoNewMail,
  INBUCKET_URL,
  uniqueLocalPart,
  waitForMail,
} from '../fixtures/send-path';

const SUBJECT_2 = 'Saved in Settings two';
const MESSAGE_2 = 'Message saved in Settings two';
const SUBJECT_3 = 'Saved in Settings three';
const SUBJECT_4 = 'Typed in the send dialog four';
const SUBJECT_5 = 'Typed then cancelled five';
const REPLY_TO_1 = 'reply-one@test.documenso.com';
const REPLY_TO_2 = 'reply-two@test.documenso.com';

type Surface = { page: Page; envelopeId: string; localPart: string };

/** Seeds the draft, adds the signature field, signs in and opens the editor. */
const openEditor = async (
  page: Page,
  label: string,
  meta: { subject?: string; message?: string; emailReplyTo?: string } = {},
): Promise<Surface> => {
  const { user, team } = await seedUser();
  const localPart = uniqueLocalPart(label);

  const envelope = await seedDraftDocument(user, team.id, [addressFor(localPart)], { internalVersion: 2 });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  // A V2 envelope is distributed only when every field carries its metadata; the seed's NAME field has none.
  await prisma.field.updateMany({
    where: { envelopeId: envelope.id, type: FieldType.NAME },
    data: { fieldMeta: { type: 'name' } },
  });

  await prisma.field.create({
    data: {
      page: 1,
      type: FieldType.SIGNATURE,
      fieldMeta: FIELD_SIGNATURE_META_DEFAULT_VALUES,
      inserted: false,
      customText: '',
      positionX: 10,
      positionY: 10,
      width: 20,
      height: 5,
      recipientId: recipient.id,
      envelopeId: envelope.id,
      envelopeItemId: envelope.envelopeItems[0].id,
    },
  });

  if (Object.keys(meta).length > 0) {
    await prisma.documentMeta.update({ where: { id: envelope.documentMetaId }, data: meta });
  }

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/documents/${envelope.id}/edit?step=uploadAndRecipients`,
  });

  return { page, envelopeId: envelope.id, localPart };
};

const sendDialog = (page: Page) => page.getByRole('dialog');

const openSendDialog = async (page: Page) => {
  await page.locator('button[title="Send Envelope"]').click();
  await expect(page.getByRole('heading', { name: 'Send Document' })).toBeVisible();
};

const cancelSendDialog = async (page: Page) => {
  await sendDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(sendDialog(page)).toHaveCount(0);
};

const clickSend = async (page: Page, buttonName: 'Send' | 'Generate Links' = 'Send') => {
  await sendDialog(page).getByRole('button', { name: buttonName, exact: true }).click();
  await expectToastTextToBeVisible(page, 'Envelope distributed');
};

const subjectField = (page: Page) => sendDialog(page).locator('input[name="meta.subject"]');
const messageField = (page: Page) => sendDialog(page).locator('textarea[name="meta.message"]');
const replyToField = (page: Page) => sendDialog(page).locator('input[name="meta.emailReplyTo"]');

const saveSettings = async (page: Page, update: () => Promise<void>) => {
  await getEnvelopeEditorSettingsTrigger(page).click();
  await expect(page.getByRole('heading', { name: 'Document Settings' })).toBeVisible();

  await update();

  await page.getByRole('button', { name: 'Update' }).click();
  await expectToastTextToBeVisible(page, 'Envelope updated');
  await expect(page.getByRole('heading', { name: 'Document Settings' })).toHaveCount(0);
};

const saveEmailSettings = async (page: Page, values: { subject?: string; message?: string; emailReplyTo?: string }) =>
  await saveSettings(page, async () => {
    await page.getByRole('button', { name: 'Notifications' }).click();

    if (values.emailReplyTo !== undefined) {
      await page.locator('input[name="meta.emailReplyTo"]').fill(values.emailReplyTo);
    }

    if (values.subject !== undefined) {
      await page.locator('input[name="meta.subject"]').fill(values.subject);
    }

    if (values.message !== undefined) {
      await page.locator('textarea[name="meta.message"]').fill(values.message);
    }
  });

const saveDistributionMethod = async (page: Page, optionLabel: 'Email' | 'None') =>
  await saveSettings(page, async () => {
    await page.getByRole('button', { name: 'General' }).click();
    await page.locator('[data-testid="documentDistributionMethodSelectValue"]').click();
    await page.getByRole('option', { name: optionLabel, exact: true }).click();
  });

const readSavedMeta = async (envelopeId: string) =>
  (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, include: { documentMeta: true } }))
    .documentMeta;

/** The text and HTML of the first message in the mailbox, from Inbucket's web API. */
const readFirstMessageBody = async (page: Page, localPart: string) => {
  const list = await page.request.get(`${INBUCKET_URL}/api/v1/mailbox/${localPart}`);
  const [first] = (await list.json()) as { id: string }[];

  const res = await page.request.get(`${INBUCKET_URL}/api/v1/mailbox/${localPart}/${first.id}`);
  const message = (await res.json()) as { body?: { text?: string; html?: string } };

  return `${message.body?.text ?? ''}\n${message.body?.html ?? ''}`;
};

test.describe('send dialog uses the subject and message saved in Settings', () => {
  test.beforeEach(async ({ request }) => {
    await assertMailCatcherReachable(request);
  });

  test('C1 subject and message saved in Settings reach the invitation and the saved meta', async ({
    page,
    request,
  }) => {
    const { envelopeId, localPart } = await openEditor(page, 'c1');

    await openSendDialog(page);
    await cancelSendDialog(page);

    await saveEmailSettings(page, { subject: SUBJECT_2, message: MESSAGE_2 });

    await openSendDialog(page);
    await expect(subjectField(page)).toHaveValue(SUBJECT_2);
    await expect(messageField(page)).toHaveValue(MESSAGE_2);

    await clickSend(page);

    const messages = await waitForMail(request, localPart, 1);

    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe(SUBJECT_2);
    expect(await readFirstMessageBody(page, localPart)).toContain(MESSAGE_2);

    const meta = await readSavedMeta(envelopeId);

    expect(meta.subject).toBe(SUBJECT_2);
    expect(meta.message).toBe(MESSAGE_2);
  });

  test('C2 a second edit in Settings shows in the send dialog after it was opened and cancelled', async ({ page }) => {
    await openEditor(page, 'c2');

    await saveEmailSettings(page, { subject: SUBJECT_2 });

    await openSendDialog(page);
    await expect(subjectField(page)).toHaveValue(SUBJECT_2);
    await cancelSendDialog(page);

    await saveEmailSettings(page, { subject: SUBJECT_3 });

    await openSendDialog(page);
    await expect(subjectField(page)).toHaveValue(SUBJECT_3);
  });

  test('C3 reply-to changed in Settings shows in the send dialog and is saved on send', async ({ page }) => {
    const { envelopeId } = await openEditor(page, 'c3', { emailReplyTo: REPLY_TO_1 });

    await openSendDialog(page);
    await expect(replyToField(page)).toHaveValue(REPLY_TO_1);
    await cancelSendDialog(page);

    await saveEmailSettings(page, { emailReplyTo: REPLY_TO_2 });

    await openSendDialog(page);
    await expect(replyToField(page)).toHaveValue(REPLY_TO_2);

    await clickSend(page);

    const meta = await readSavedMeta(envelopeId);

    expect(meta.emailReplyTo).toBe(REPLY_TO_2);
  });

  test('C4 a subject typed in the send dialog is the one emailed and saved', async ({ page, request }) => {
    const { envelopeId, localPart } = await openEditor(page, 'c4', { subject: SUBJECT_2, message: MESSAGE_2 });

    await openSendDialog(page);
    await expect(subjectField(page)).toHaveValue(SUBJECT_2);

    await subjectField(page).fill(SUBJECT_4);
    await clickSend(page);

    const messages = await waitForMail(request, localPart, 1);

    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe(SUBJECT_4);

    const meta = await readSavedMeta(envelopeId);

    expect(meta.subject).toBe(SUBJECT_4);
  });

  test('C5 a subject typed in the send dialog and cancelled is discarded on reopen', async ({ page }) => {
    await openEditor(page, 'c5', { subject: SUBJECT_2, message: MESSAGE_2 });

    await openSendDialog(page);
    await expect(subjectField(page)).toHaveValue(SUBJECT_2);

    await subjectField(page).fill(SUBJECT_5);
    await cancelSendDialog(page);

    await openSendDialog(page);
    await expect(subjectField(page)).toHaveValue(SUBJECT_2);
  });

  test('C6 the send dialog opens on the tab matching the distribution method saved in Settings', async ({ page }) => {
    await openEditor(page, 'c6');

    await openSendDialog(page);
    await expect(sendDialog(page).getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
    await cancelSendDialog(page);

    await saveDistributionMethod(page, 'None');

    await openSendDialog(page);
    await expect(sendDialog(page).getByRole('tab', { name: 'None' })).toHaveAttribute('aria-selected', 'true');
    await cancelSendDialog(page);

    await saveDistributionMethod(page, 'Email');

    await openSendDialog(page);
    await expect(sendDialog(page).getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
  });

  test('C7 sending through the None tab saves the Settings subject and message and emails nobody', async ({
    page,
    request,
  }) => {
    const { envelopeId, localPart } = await openEditor(page, 'c7');

    await openSendDialog(page);
    await cancelSendDialog(page);

    await saveEmailSettings(page, { subject: SUBJECT_2, message: MESSAGE_2 });

    await openSendDialog(page);
    await sendDialog(page).getByRole('tab', { name: 'None' }).click();
    await clickSend(page, 'Generate Links');

    const meta = await readSavedMeta(envelopeId);

    expect(meta.subject).toBe(SUBJECT_2);
    expect(meta.message).toBe(MESSAGE_2);

    const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

    expect(envelope.status).toBe(DocumentStatus.PENDING);

    await expectNoNewMail(request, localPart, 0, 'send through the None tab');
  });

  test('C8 an editor autosave still in flight disables the send dialog until it finishes, then the dialog shows the saved settings', async ({
    page,
    request,
  }) => {
    const { envelopeId, localPart } = await openEditor(page, 'c8');

    // S2 is saved through Settings first, as a user would.
    await saveEmailSettings(page, { subject: SUBJECT_2 });

    // Hold back the first recipients autosave (tRPC procedure envelope.recipient.set) until the test releases it.
    let held = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route(
      (url) => url.pathname.replace('/api/trpc/', '').split(',').includes('envelope.recipient.set'),
      async (route) => {
        if (route.request().method() !== 'POST' || held > 0) {
          await route.continue();
          return;
        }

        held += 1;
        await gate;
        await route.continue();
      },
    );

    // Editing the signer's name on the recipients step triggers the debounced autosave.
    await setRecipientName(page, 0, 'Renamed during autosave');
    await expect
      .poll(() => held, { message: 'the envelope.recipient.set request is held in flight', timeout: 15_000 })
      .toBe(1);

    await openSendDialog(page);

    // While the autosave is in flight the tabs and the send button are disabled, and the subject is
    // either not shown (a spinner stands in for the form) or disabled.
    await expect(sendDialog(page).getByRole('tab', { name: 'None' })).toBeDisabled();
    await expect(sendDialog(page).getByRole('tab', { name: 'Email' })).toBeDisabled();
    await expect(sendDialog(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    if ((await subjectField(page).count()) > 0) {
      await expect(subjectField(page)).toBeDisabled();
    }

    release();

    await expect(sendDialog(page).getByRole('tab', { name: 'None' })).toBeEnabled();
    await expect(subjectField(page)).toHaveValue(SUBJECT_2);

    await sendDialog(page).getByRole('tab', { name: 'None' }).click();
    await clickSend(page, 'Generate Links');

    const meta = await readSavedMeta(envelopeId);

    expect(meta.subject).toBe(SUBJECT_2);
    expect(meta.distributionMethod).toBe(DocumentDistributionMethod.NONE);

    await expectNoNewMail(request, localPart, 0, 'send through the None tab after a sync');
  });
});
