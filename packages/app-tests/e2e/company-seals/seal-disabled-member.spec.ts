/**
 * A disabled account is not a member.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | send is refused for a disabled recipient who keeps a membership    | 11, 17   | F3, F11       |
 * | the editor warns for a disabled recipient as for a non-member      | 8, 11    | F11           |
 *
 * Spec, "Who may apply a seal", check 4: "That user is a current member of the
 * seal's organisation." Spec, background: directory sync "disables the Sign
 * account of a leaver (User.disabled) and ends their sessions; it does not
 * remove organisation membership." A disabled account cannot apply (criterion
 * 17), so at send "every COMPANY_SEAL field must point at a seal of the
 * envelope's organisation and its recipient's email must belong to a member
 * of that organisation; otherwise the send is refused" with
 * COMPANY_SEAL_RECIPIENT_NOT_AUTHORISED. The specification does not say in so
 * many words that a disabled account is not a member for the send check or the
 * editor; the strictest reading is taken, because a document whose seal
 * recipient cannot sign in is a document nobody can finish (F11).
 */
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';

import {
  buildDraftWithRecipients,
  buildSealEnvelope,
  createBlueSeal,
  DEFAULT_SEAL_BOX,
  errorCodeOf,
  expectMailCatcherReachable,
  mailboxMessages,
  postFieldsRaw,
  SEAL_ERRORS,
  SEAL_FIELD_META_TYPE,
  SEAL_UI,
  seedSealWorld,
  test,
} from '../fixtures/company-seals';
import { clickEnvelopeEditorStep } from '../fixtures/envelope-editor';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test('criterion_11_send_is_refused_for_a_disabled_recipient_who_keeps_a_membership', async ({ signIn, request }) => {
  await expectMailCatcherReachable();

  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const built = await buildSealEnvelope(request, world, {
    recipients: [{ email: world.member.email, sealId: seal.id }],
    send: false,
  });

  // What directory sync does to a leaver: the account is disabled, the membership row stays.
  await prisma.user.update({ where: { id: world.member.id }, data: { disabled: true } });

  expect(
    await prisma.organisationMember.count({
      where: { userId: world.member.id, organisationId: world.organisation.id },
    }),
    'precondition: the membership row remains',
  ).toBe(1);

  const res = await built.send();
  const body = await res.json().catch(() => ({}));

  expect(res.status(), JSON.stringify(body)).toBe(SEAL_ERRORS.recipientNotAuthorised.status);
  expect(errorCodeOf(body)).toBe(SEAL_ERRORS.recipientNotAuthorised.code);

  const stored = await prisma.envelope.findUniqueOrThrow({
    where: { id: built.envelopeId },
    include: { recipients: true },
  });

  expect(stored.status, 'the envelope is still a draft').toBe('DRAFT');
  expect(
    stored.recipients.every((r) => r.sendStatus === 'NOT_SENT'),
    'nobody was marked sent',
  ).toBe(true);

  // Mail is sent by a background job, so give it time to arrive before concluding it did not.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  expect(await mailboxMessages(world.member.email), 'no mail went out').toHaveLength(0);

  // Control: with the account enabled again, the same envelope sends, so the refusal was the disabled flag.
  await prisma.user.update({ where: { id: world.member.id }, data: { disabled: false } });

  const accepted = await built.send();

  expect(accepted.ok(), `an enabled member sends: ${await accepted.text()}`).toBe(true);
});

test('criterion_08_the_editor_warns_for_a_disabled_recipient_as_for_a_non_member', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const draft = await buildDraftWithRecipients(request, world, [{ email: world.member.email }]);
  const created = await postFieldsRaw(request, world.ownerApiToken, draft.envelopeId, draft.envelopeItemId, [
    {
      recipientId: draft.recipientIdFor(world.member.email),
      fieldMeta: { type: SEAL_FIELD_META_TYPE, sealId: seal.id },
    },
  ]);

  expect(created.ok(), `seal field creation: ${await created.text()}`).toBe(true);

  const owner = await signIn(world.owner.email);
  const { page } = owner;

  const selectSealField = async () => {
    await page.goto(`/t/${world.team.url}/documents/${draft.envelopeId}/edit?step=uploadAndRecipients`);
    await clickEnvelopeEditorStep(page, 'addFields');

    const canvas = page.locator('.konva-container canvas').first();

    await expect(canvas).toBeVisible();

    const box = await canvas.boundingBox();

    expect(box, 'the page canvas has a size').toBeTruthy();

    const { width, height } = box as { width: number; height: number };

    await canvas.click({
      position: {
        x: ((DEFAULT_SEAL_BOX.positionX + DEFAULT_SEAL_BOX.width / 2) / 100) * width,
        y: ((DEFAULT_SEAL_BOX.positionY + DEFAULT_SEAL_BOX.height / 2) / 100) * height,
      },
    });

    await expect(page.getByTestId(SEAL_UI.pickerTestId), 'selecting the seal field opens its form').toBeVisible();
  };

  const warning = page.getByText(/not a member of the organisation/i);

  // Control: an enabled member draws no warning.
  await selectSealField();
  await expect(warning, 'no warning for an enabled member').toHaveCount(0);

  await prisma.user.update({ where: { id: world.member.id }, data: { disabled: true } });

  await selectSealField();
  await expect(warning, 'the editor warns that a disabled recipient is not a member').toBeVisible();
});
