/**
 * Creating company seals: who may create one, what is recorded, and
 * that nothing changes or removes one afterwards.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | manager creates a seal on the settings page, row records them | 1        | F5            |
 * | admin and owner create seals the same way                     | 1        | F5            |
 * | creator record carries the request's IP address and agent     | 1        | F5            |
 * | member and a foreign manager cannot reach the page or create  | 2        | F5            |
 * | two seals for one legal entity both exist                     | 3        |               |
 * | no procedure or page action changes or removes a seal         | 4        | F6            |
 *
 * Expected on main (red run): every test fails at the first seal creation,
 * because there is no settings page and no companySeal procedure. The
 * "foreign manager" and "member" refusals are not allowed to pass for that
 * reason: each first creates a seal as a manager and then tries to read or
 * change it.
 */
import { expect } from '@playwright/test';

import {
  createBlueSeal,
  createSeal,
  discPng,
  SEAL_INPUT,
  SEAL_PROCEDURES,
  SEAL_ROUTES,
  SEAL_UI,
  type SealRow,
  sealRowById,
  sealRowCount,
  sealRows,
  seedSealWorld,
  sha256Hex,
  storedSealImage,
  test,
  trpcCall,
  uniqueSealNames,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test('criterion_01_manager_creates_a_seal_on_the_settings_page_and_it_is_listed_with_its_image', async ({ signIn }) => {
  const world = await seedSealWorld();
  const session = await signIn(world.manager.email);
  const { page } = session;
  const { name, legalEntityName } = uniqueSealNames();

  await page.goto(SEAL_ROUTES.settingsPage(world.organisation.url));

  const openButton = page.getByRole('button', { name: SEAL_UI.createButton });

  if ((await openButton.count()) > 0) {
    await openButton.first().click();
  }

  await page.getByLabel(SEAL_UI.settingsNameLabel, { exact: true }).fill(name);
  await page.getByLabel(SEAL_UI.settingsLegalEntityLabel, { exact: true }).fill(legalEntityName);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'seal.png',
    mimeType: 'image/png',
    buffer: await discPng(400),
  });

  await expect(page.getByTestId(SEAL_UI.previewTestId), 'the processed image is shown before saving').toBeVisible();
  expect(await sealRowCount(world.organisation.id), 'nothing is stored before the creator confirms').toBe(0);

  await page.getByRole('button', { name: SEAL_UI.settingsSaveButton }).click();

  const row = page.getByTestId(SEAL_UI.rowTestId).filter({ hasText: name });

  await expect(row).toBeVisible();
  await expect(row).toContainText(legalEntityName);
  await expect(row).toContainText('Seal Manager');
  await expect(row.locator('img').first(), 'the list shows the seal image').toBeVisible();

  const [stored] = await sealRows(world.organisation.id);

  expect(stored.name).toBe(name);
  expect(stored.legalEntityName).toBe(legalEntityName);
  expect(stored.createdByUserId, 'the row records the manager as creator').toBe(world.manager.id);
  expect(stored.createdByName).toBe(world.manager.name);
  expect(stored.createdByEmail).toBe(world.manager.email);
});

for (const role of ['admin', 'owner'] as const) {
  test(`criterion_01_${role}_creates_a_seal_and_is_recorded_as_creator`, async ({ signIn }) => {
    const world = await seedSealWorld();
    const creator = role === 'admin' ? world.admin : world.owner;
    const session = await signIn(creator.email);

    const row = await createBlueSeal(session, world.organisation.id);

    expect(row.createdByUserId).toBe(creator.id);
    expect(row.createdByEmail).toBe(creator.email);
    expect(row.imageSha256, 'the row stores the SHA-256 of the stored PNG').toBe(sha256Hex(await storedSealImage(row)));
  });
}

test('criterion_01_creator_record_carries_the_request_ip_address_and_user_agent', async ({ signIn }) => {
  const world = await seedSealWorld();
  const session = await signIn(world.manager.email);
  const { name, legalEntityName } = uniqueSealNames();

  const result = await createSeal(
    session.request,
    { organisationId: world.organisation.id, name, legalEntityName, image: { buffer: await discPng(400) } },
    { 'x-forwarded-for': '203.0.113.77', 'user-agent': 'seal-e2e-agent/1.0' },
  );

  expect(result.ok, `create failed: ${result.text}`).toBe(true);

  const [row] = await sealRows(world.organisation.id);

  expect(row.createdFromIp).toBe('203.0.113.77');
  expect(row.createdUserAgent).toBe('seal-e2e-agent/1.0');
  expect(row.createdAt, 'creation time is recorded').toBeTruthy();
});

test('criterion_02_a_member_cannot_reach_the_page_or_create_a_seal', async ({ signIn }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const member = await signIn(world.member.email);

  // A seal must exist, or a page that simply does not exist would pass.
  await createBlueSeal(manager, world.organisation.id);

  await member.page.goto(SEAL_ROUTES.settingsPage(world.organisation.url));
  await member.page.waitForLoadState('networkidle');

  await expect(member.page.getByLabel(SEAL_UI.settingsLegalEntityLabel, { exact: true })).toHaveCount(0);
  await expect(member.page.getByTestId(SEAL_UI.rowTestId)).toHaveCount(0);

  const { name, legalEntityName } = uniqueSealNames();

  const result = await createSeal(member.request, {
    organisationId: world.organisation.id,
    name,
    legalEntityName,
    image: { buffer: await discPng(400) },
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('UNAUTHORIZED');
  expect(await sealRowCount(world.organisation.id), 'only the manager seal exists').toBe(1);
});

test('criterion_02_a_manager_of_another_organisation_cannot_reach_the_page_or_create_a_seal', async ({ signIn }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const foreign = await signIn(world.foreignManager.email);

  await createBlueSeal(manager, world.organisation.id);

  await foreign.page.goto(SEAL_ROUTES.settingsPage(world.organisation.url));
  await foreign.page.waitForLoadState('networkidle');

  await expect(foreign.page.getByLabel(SEAL_UI.settingsLegalEntityLabel, { exact: true })).toHaveCount(0);
  await expect(foreign.page.getByTestId(SEAL_UI.rowTestId)).toHaveCount(0);

  const { name, legalEntityName } = uniqueSealNames();

  const result = await createSeal(foreign.request, {
    organisationId: world.organisation.id,
    name,
    legalEntityName,
    image: { buffer: await discPng(400) },
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('UNAUTHORIZED');
  expect(await sealRowCount(world.organisation.id)).toBe(1);

  // Their own organisation is open to them, which shows the refusal above is about the organisation.
  const own = await createBlueSeal(foreign, world.foreignOrganisation.id);

  expect(own.createdByUserId).toBe(world.foreignManager.id);
});

test('criterion_03_two_seals_for_one_legal_entity_can_both_be_created_and_are_both_listed', async ({ signIn }) => {
  const world = await seedSealWorld();
  const session = await signIn(world.manager.email);
  const legalEntityName = `TerraPay UK ${Date.now()} Ltd`;

  const first = await createBlueSeal(session, world.organisation.id, { legalEntityName });
  const second = await createBlueSeal(session, world.organisation.id, { legalEntityName });

  expect(first.id).not.toBe(second.id);
  expect(await sealRowCount(world.organisation.id)).toBe(2);

  const listed = await trpcCall(session.request, SEAL_PROCEDURES.find, SEAL_INPUT.find(world.organisation.id), {
    method: 'GET',
  });

  expect(listed.ok, `find failed: ${listed.text}`).toBe(true);
  expect(listed.text).toContain(first.id);
  expect(listed.text).toContain(second.id);

  await session.page.goto(SEAL_ROUTES.settingsPage(world.organisation.url));

  await expect(session.page.getByTestId(SEAL_UI.rowTestId).filter({ hasText: legalEntityName })).toHaveCount(2);
});

/** Names a client might try for an operation the specification says does not exist. */
const FORBIDDEN_VERBS = [
  'update',
  'edit',
  'delete',
  'remove',
  'retire',
  'archive',
  'replace',
  'replaceImage',
  'updateImage',
  'setImage',
  'rename',
  'hide',
  'disable',
];

test('criterion_04_no_procedure_changes_or_removes_a_seal', async ({ signIn }) => {
  const world = await seedSealWorld();
  const session = await signIn(world.owner.email);
  const seal = await createBlueSeal(session, world.organisation.id);

  const before = await sealRowById(seal.id);

  // Probed over HTTP as the owner, the most privileged organisation role. An unknown tRPC procedure answers 404.
  for (const verb of FORBIDDEN_VERBS) {
    for (const prefix of ['organisation.companySeal', 'envelope.companySeal']) {
      const result = await trpcCall(session.request, `${prefix}.${verb}`, {
        id: seal.id,
        sealId: seal.id,
        organisationId: world.organisation.id,
        name: 'changed',
        legalEntityName: 'changed',
      });

      expect(result.ok, `${prefix}.${verb} must not exist (${result.status})`).toBe(false);
      expect(result.status, `${prefix}.${verb} is an unknown procedure`).toBe(404);
    }
  }

  const after = await sealRowById(seal.id);

  expect(after, 'the seal row is exactly as created').toEqual(before as SealRow);
});

test('criterion_04_the_settings_page_offers_no_action_that_changes_or_removes_a_seal', async ({ signIn }) => {
  const world = await seedSealWorld();
  const session = await signIn(world.owner.email);
  const seal = await createBlueSeal(session, world.organisation.id);

  await session.page.goto(SEAL_ROUTES.settingsPage(world.organisation.url));

  const row = session.page.getByTestId(SEAL_UI.rowTestId).filter({ hasText: seal.name });

  await expect(row).toBeVisible();

  const actions = row.locator('button, [role="menuitem"], [role="button"], a[href]');

  for (let index = 0; index < (await actions.count()); index += 1) {
    const label = (await actions.nth(index).innerText()).trim();
    const ariaLabel = (await actions.nth(index).getAttribute('aria-label')) ?? '';

    expect(`${label} ${ariaLabel}`, 'no row action names an edit or removal').not.toMatch(
      /edit|delete|remove|retire|archive|replace|rename|disable|hide|update|change/i,
    );
  }

  await expect(session.page.getByRole('button', { name: /edit|delete|remove|retire|archive|replace/i })).toHaveCount(0);
});
