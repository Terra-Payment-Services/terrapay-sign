/**
 * The sender side of company seals: the V2 editor, the field writers,
 * API v1 refusal, the send check and templates.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | the editor offers Company seal, shows the seals, saves the choice | 3, 8     |               |
 * | the palette does not offer it with no seal in the organisation    | 8        | F14 guard     |
 * | API v2 creates a seal field and replaces a client sealLabel       | 9        |               |
 * | API v2 refuses a missing, unknown or foreign sealId               | 9        | F11           |
 * | API v2 refuses a recipient who is not a SIGNER                    | 9        | F4            |
 * | API v2 update refuses a foreign sealId and replaces the label     | 9        |               |
 * | API v1 and the V1 tRPC field routes refuse COMPANY_SEAL           | 10       | F10           |
 * | the V1 editor does not offer the type                             | 10       | F10           |
 * | send is refused for a non-member recipient and no mail goes out   | 11       | F11           |
 * | send succeeds for a member recipient and mail goes out            | 11       |               |
 * | a document made from a template gets the same send check          | 11       | F11           |
 * | a direct link on a template carrying a seal field is refused      | 12       |               |
 *
 * Expected on main (red run): every test that needs a seal fails creating it,
 * which includes the V1 refusals and the V1 editor test. The palette-hides
 * test passes on main, because a field type the product does not have cannot
 * be offered; it guards against the type leaking into places it must not go.
 */
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { seedTestEmail } from '@documenso/prisma/seed/users';
import { expect } from '@playwright/test';

import {
  API_V1,
  API_V2,
  authHeader,
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
  SEAL_FIELD_TYPE,
  SEAL_UI,
  seedSealWorld,
  test,
} from '../fixtures/company-seals';
import { clickEnvelopeEditorStep } from '../fixtures/envelope-editor';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const sealFieldsOf = async (envelopeId: string) =>
  (await prisma.field.findMany({ where: { envelopeId } })).filter((f) => String(f.type) === SEAL_FIELD_TYPE);

// ---------------------------------------------------------------------------
// Criterion 8: the V2 editor
// ---------------------------------------------------------------------------

test('criterion_08_the_editor_offers_company_seal_lists_the_seals_with_images_and_saves_the_choice', async ({
  signIn,
  request,
}) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const legalEntityName = `TerraPay UK ${Date.now()} Ltd`;

  const first = await createBlueSeal(manager, world.organisation.id, { legalEntityName });
  const second = await createBlueSeal(manager, world.organisation.id, { legalEntityName });

  const draft = await buildDraftWithRecipients(request, world, [{ email: world.owner.email }]);
  const owner = await signIn(world.owner.email);
  const { page } = owner;

  await page.goto(`/t/${world.team.url}/documents/${draft.envelopeId}/edit?step=uploadAndRecipients`);
  await clickEnvelopeEditorStep(page, 'addFields');

  const palette = page.getByRole('button', { name: SEAL_UI.paletteButton, exact: true });

  await expect(palette, 'the palette offers Company seal when the organisation has a seal').toBeVisible();
  await palette.click();

  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 200, y: 250 } });

  await page.getByTestId(SEAL_UI.pickerTestId).click();

  for (const seal of [first, second]) {
    const option = page.getByRole('option').filter({ hasText: seal.name });

    await expect(option, `the picker lists ${seal.name}`).toBeVisible();
    await expect(option).toContainText(legalEntityName);
    await expect(option.locator('img').first(), 'each option shows the seal image').toBeVisible();
  }

  await page.getByRole('option').filter({ hasText: second.name }).click();

  await expect
    .poll(
      async () => {
        const [field] = await sealFieldsOf(draft.envelopeId);

        return field?.fieldMeta;
      },
      { timeout: 30_000 },
    )
    .toMatchObject({
      type: SEAL_FIELD_META_TYPE,
      sealId: second.id,
      sealLabel: `${second.name} (${second.legalEntityName})`,
    });
});

test('criterion_08_the_palette_does_not_offer_company_seal_when_the_organisation_has_no_seal', async ({
  signIn,
  request,
}) => {
  const world = await seedSealWorld();
  const draft = await buildDraftWithRecipients(request, world, [{ email: world.owner.email }]);
  const owner = await signIn(world.owner.email);
  const { page } = owner;

  await page.goto(`/t/${world.team.url}/documents/${draft.envelopeId}/edit?step=uploadAndRecipients`);
  await clickEnvelopeEditorStep(page, 'addFields');

  await expect(page.getByRole('button', { name: 'Signature', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: SEAL_UI.paletteButton, exact: true })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Criterion 9: API v2 field writers
// ---------------------------------------------------------------------------

test('criterion_09_api_v2_creates_a_seal_field_and_replaces_a_client_supplied_label', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const built = await buildSealEnvelope(request, world, {
    recipients: [{ email: world.member.email, sealId: seal.id, sealLabel: 'EVIL LABEL' }],
    send: false,
  });

  const [field] = await sealFieldsOf(built.envelopeId);

  expect(field, 'the seal field exists').toBeTruthy();
  expect(field.fieldMeta).toMatchObject({
    type: SEAL_FIELD_META_TYPE,
    sealId: seal.id,
    sealLabel: `${seal.name} (${seal.legalEntityName})`,
  });

  const read = await request.get(`${API_V2}/envelope/${built.envelopeId}`, { headers: authHeader(built.apiToken) });

  expect(read.ok()).toBe(true);

  const body = await read.json();
  const returned = (body.fields as Array<{ type: string; fieldMeta?: { sealId?: string } }>).find(
    (f) => f.type === SEAL_FIELD_TYPE,
  );

  expect(returned?.fieldMeta?.sealId, 'field responses return the type and meta').toBe(seal.id);
});

for (const caseName of ['a_missing_sealId', 'an_unknown_sealId', 'another_organisations_sealId']) {
  test(`criterion_09_api_v2_refuses_${caseName}_with_400_and_creates_no_field`, async ({ signIn, request }) => {
    const world = await seedSealWorld();
    const manager = await signIn(world.manager.email);
    const foreign = await signIn(world.foreignManager.email);

    await createBlueSeal(manager, world.organisation.id);

    const foreignSeal = await createBlueSeal(foreign, world.foreignOrganisation.id);
    const draft = await buildDraftWithRecipients(request, world, [{ email: world.member.email }]);
    const meta =
      caseName === 'a_missing_sealId'
        ? { type: SEAL_FIELD_META_TYPE }
        : caseName === 'an_unknown_sealId'
          ? { type: SEAL_FIELD_META_TYPE, sealId: 'seal_doesnotexist000000' }
          : { type: SEAL_FIELD_META_TYPE, sealId: foreignSeal.id };

    const res = await postFieldsRaw(request, world.ownerApiToken, draft.envelopeId, draft.envelopeItemId, [
      { recipientId: draft.recipientIdFor(world.member.email), fieldMeta: meta },
    ]);

    expect(res.status(), `refused: ${await res.text()}`).toBe(400);
    expect(await sealFieldsOf(draft.envelopeId), 'no seal field was created').toHaveLength(0);
  });
}

for (const role of ['APPROVER', 'VIEWER', 'CC', 'ASSISTANT'] as const) {
  test(`criterion_09_api_v2_refuses_a_seal_field_for_a_${role}_recipient`, async ({ signIn, request }) => {
    const world = await seedSealWorld();
    const manager = await signIn(world.manager.email);
    const seal = await createBlueSeal(manager, world.organisation.id);

    const draft = await buildDraftWithRecipients(request, world, [{ email: world.member.email, role }]);

    const res = await postFieldsRaw(request, world.ownerApiToken, draft.envelopeId, draft.envelopeItemId, [
      {
        recipientId: draft.recipientIdFor(world.member.email),
        fieldMeta: { type: SEAL_FIELD_META_TYPE, sealId: seal.id },
      },
    ]);

    expect(res.status(), `refused: ${await res.text()}`).toBe(400);
    expect(await sealFieldsOf(draft.envelopeId)).toHaveLength(0);
  });
}

test('criterion_09_api_v2_update_refuses_a_foreign_sealId_and_replaces_the_label_on_a_valid_one', async ({
  signIn,
  request,
}) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const foreign = await signIn(world.foreignManager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const other = await createBlueSeal(manager, world.organisation.id);
  const foreignSeal = await createBlueSeal(foreign, world.foreignOrganisation.id);

  const built = await buildSealEnvelope(request, world, {
    recipients: [{ email: world.member.email, sealId: seal.id }],
    send: false,
  });
  const [field] = await sealFieldsOf(built.envelopeId);

  const update = async (meta: Record<string, unknown>) =>
    await request.post(`${API_V2}/envelope/field/update-many`, {
      headers: authHeader(built.apiToken),
      data: { envelopeId: built.envelopeId, data: [{ id: field.id, type: SEAL_FIELD_TYPE, fieldMeta: meta }] },
    });

  const refused = await update({ type: SEAL_FIELD_META_TYPE, sealId: foreignSeal.id });

  expect(refused.status(), `refused: ${await refused.text()}`).toBe(400);

  const unchanged = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

  expect(unchanged.fieldMeta, 'the refused update changed nothing').toMatchObject({ sealId: seal.id });

  const accepted = await update({ type: SEAL_FIELD_META_TYPE, sealId: other.id, sealLabel: 'EVIL LABEL' });

  expect(accepted.ok(), `update failed: ${await accepted.text()}`).toBe(true);

  const changed = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

  expect(changed.fieldMeta).toMatchObject({
    sealId: other.id,
    sealLabel: `${other.name} (${other.legalEntityName})`,
  });
});

// ---------------------------------------------------------------------------
// Criterion 10: V1 surfaces refuse the type
// ---------------------------------------------------------------------------

const V1_MESSAGE = /company seals? .*v2|v2 document/i;

for (const internalVersion of [1, 2]) {
  test(`criterion_10_api_v1_field_creation_with_company_seal_answers_400_on_a_v${internalVersion}_document`, async ({
    signIn,
    request,
  }) => {
    const world = await seedSealWorld();
    const manager = await signIn(world.manager.email);
    const seal = await createBlueSeal(manager, world.organisation.id);

    const document = await seedDraftDocument(world.owner, world.team.id, [world.member.email], { internalVersion });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
    const documentId = mapSecondaryIdToDocumentId(document.secondaryId);

    const res = await request.post(`${API_V1}/documents/${documentId}/fields`, {
      headers: authHeader(world.ownerApiToken),
      data: {
        recipientId: recipient.id,
        type: SEAL_FIELD_TYPE,
        pageNumber: 1,
        pageX: 40,
        pageY: 40,
        pageWidth: 20,
        pageHeight: 15,
        fieldMeta: { type: SEAL_FIELD_META_TYPE, sealId: seal.id },
      },
    });

    const text = await res.text();

    expect(res.status(), text).toBe(400);
    expect(text, 'the message says company seals need a V2 document').toMatch(V1_MESSAGE);
    expect(await sealFieldsOf(document.id)).toHaveLength(0);
  });
}

test('criterion_10_the_v1_trpc_field_route_answers_400_with_a_v2_message', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const document = await seedDraftDocument(world.owner, world.team.id, [world.member.email], { internalVersion: 1 });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
  const documentId = mapSecondaryIdToDocumentId(document.secondaryId);

  const res = await request.post(`${API_V2}/document/field/create`, {
    headers: authHeader(world.ownerApiToken),
    data: {
      documentId,
      field: {
        recipientId: recipient.id,
        type: SEAL_FIELD_TYPE,
        pageNumber: 1,
        pageX: 40,
        pageY: 40,
        width: 20,
        height: 15,
        fieldMeta: { type: SEAL_FIELD_META_TYPE, sealId: seal.id },
      },
    },
  });

  const text = await res.text();

  expect(res.status(), text).toBe(400);
  expect(text, 'the message says company seals need a V2 document').toMatch(V1_MESSAGE);
  expect(await sealFieldsOf(document.id)).toHaveLength(0);
});

test('criterion_10_the_v1_editor_does_not_offer_company_seal', async ({ signIn }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);

  // The organisation has a seal, so the V2 palette would offer the type.
  await createBlueSeal(manager, world.organisation.id);

  const document = await seedDraftDocument(world.owner, world.team.id, [world.member.email], { internalVersion: 1 });
  const owner = await signIn(world.owner.email);
  const { page } = owner;

  await page.goto(`/t/${world.team.url}/documents/${document.id}/edit`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Add Fields' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Signature' })).toBeVisible();
  await expect(page.getByRole('button', { name: SEAL_UI.paletteButton })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Criterion 11: the send check
// ---------------------------------------------------------------------------

test('criterion_11_send_is_refused_for_a_recipient_who_is_not_a_member_and_no_mail_goes_out', async ({
  signIn,
  request,
}) => {
  await expectMailCatcherReachable();

  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const outsider = seedTestEmail();

  const built = await buildSealEnvelope(request, world, {
    recipients: [
      { email: outsider, sealId: seal.id },
      { email: world.member.email, sealId: seal.id, sealBox: { ...DEFAULT_SEAL_BOX, positionY: 65 } },
    ],
    send: false,
  });

  const res = await built.send();
  const body = await res.json().catch(() => ({}));

  expect(res.status(), JSON.stringify(body)).toBe(SEAL_ERRORS.recipientNotAuthorised.status);
  expect(errorCodeOf(body)).toBe(SEAL_ERRORS.recipientNotAuthorised.code);

  const stored = await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } });

  expect(stored.status, 'the envelope is still a draft').toBe('DRAFT');

  // Mail is sent by a background job, so give it time to arrive before concluding it did not.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  expect(await mailboxMessages(outsider), 'nothing reached the outsider').toHaveLength(0);
  expect(
    await mailboxMessages(world.member.email),
    'nothing reached the member either: the send is all or nothing',
  ).toHaveLength(0);

  // Control: a plain envelope to the same address does arrive, so the silence above is the refusal
  // and not a mail path that never worked.
  await buildSealEnvelope(request, world, { recipients: [{ email: outsider }] });

  await expect.poll(async () => (await mailboxMessages(outsider)).length, { timeout: 30_000 }).toBeGreaterThan(0);
});

test('criterion_11_send_succeeds_when_the_recipient_is_a_member_and_the_mail_goes_out', async ({ signIn, request }) => {
  await expectMailCatcherReachable();

  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const built = await buildSealEnvelope(request, world, {
    recipients: [{ email: world.member.email, sealId: seal.id }],
    send: true,
  });

  const stored = await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } });

  expect(stored.status).toBe('PENDING');

  await expect
    .poll(async () => (await mailboxMessages(world.member.email)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test('criterion_11_a_document_made_from_a_template_gets_the_same_send_check', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const template = await buildSealEnvelope(request, world, {
    type: 'TEMPLATE',
    recipients: [{ email: world.member.email, sealId: seal.id }],
    send: false,
  });
  const templateRecipient = template.people[0];

  const useTemplate = async (email: string) => {
    const form = new FormData();

    form.append(
      'payload',
      JSON.stringify({
        envelopeId: template.envelopeId,
        recipients: [{ id: templateRecipient.id, email, name: email }],
        distributeDocument: false,
      }),
    );

    const res = await request.post(`${API_V2}/envelope/use`, {
      headers: authHeader(world.ownerApiToken),
      multipart: form,
    });

    expect(res.ok(), `envelope/use failed: ${await res.text()}`).toBe(true);

    return ((await res.json()) as { id: string }).id;
  };

  const distribute = async (envelopeId: string) =>
    await request.post(`${API_V2}/envelope/distribute`, {
      headers: authHeader(world.ownerApiToken),
      data: { envelopeId },
    });

  const outsiderDocument = await useTemplate(seedTestEmail());
  const [copied] = await sealFieldsOf(outsiderDocument);

  expect(copied?.fieldMeta, 'the document copies the field meta').toMatchObject({ sealId: seal.id });

  const refused = await distribute(outsiderDocument);

  expect(refused.status(), await refused.text()).toBe(400);
  expect(errorCodeOf(await refused.json())).toBe(SEAL_ERRORS.recipientNotAuthorised.code);

  const memberDocument = await useTemplate(world.member.email);
  const accepted = await distribute(memberDocument);

  expect(accepted.ok(), `a member recipient sends: ${await accepted.text()}`).toBe(true);
});

// ---------------------------------------------------------------------------
// Criterion 12: direct links
// ---------------------------------------------------------------------------

test('criterion_12_a_direct_link_on_a_template_carrying_a_seal_field_is_refused', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const template = await buildSealEnvelope(request, world, {
    type: 'TEMPLATE',
    recipients: [{ email: world.member.email, sealId: seal.id }],
    send: false,
  });

  const res = await request.post(`${API_V2}/template/direct/create`, {
    headers: authHeader(world.ownerApiToken),
    data: {
      templateId: mapSecondaryIdToTemplateId(template.secondaryId),
      directRecipientId: template.people[0].id,
    },
  });

  expect(res.ok(), `a direct link must be refused: ${res.status()}`).toBe(false);
  expect(res.status()).toBe(400);
  expect(await prisma.templateDirectLink.count({ where: { envelopeId: template.envelopeId } })).toBe(0);
});
