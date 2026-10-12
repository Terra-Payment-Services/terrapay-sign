/**
 * Who can read a seal image, and how it is cached.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | a manager reads seals with images, private and no-store           | 7        | F9            |
 * | an editor reads the organisation's seals in the picker            | 7        | F9            |
 * | an authorised recipient reads the seal at the confirmation step   | 7        | F9            |
 * | a plain member cannot list seals                                  | 7        | F9            |
 * | an unauthenticated caller gets no image from any route            | 7        | F9            |
 * | a manager of another organisation gets no image                   | 7        | F9            |
 * | the branding logo routes and guessable paths never serve a seal   | 7        | F9            |
 *
 * Expected on main (red run): every test fails creating its first seal.
 *
 * "Returns the image" is read as: the response body carries the base64 of the
 * stored PNG, as a bare string or inside a data URL. A response that carries
 * a URL to the image would have to satisfy the same rules, and this constant
 * (bodyCarriesImage in fixtures/company-seals.ts) is where to change that.
 */
import { expect } from '@playwright/test';

import {
  bodyCarriesImage,
  buildDraftWithRecipients,
  buildSealEnvelope,
  createBlueSeal,
  expectPrivateNoStore,
  getSealForField,
  SEAL_INPUT,
  SEAL_PROCEDURES,
  SEAL_ROUTES,
  seedSealWorld,
  sha256Hex,
  storedSealImage,
  test,
  trpcCall,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test('criterion_07_a_manager_reads_the_seals_with_their_images_private_and_no_store', async ({ signIn }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const png = await storedSealImage(seal);

  const listed = await trpcCall(manager.request, SEAL_PROCEDURES.find, SEAL_INPUT.find(world.organisation.id), {
    method: 'GET',
  });

  expect(listed.ok, `find failed: ${listed.status} ${listed.text}`).toBe(true);
  expect(listed.text).toContain(seal.id);
  expect(bodyCarriesImage(listed.text, png), 'the answer carries the seal image').toBe(true);
  expectPrivateNoStore(listed.headers, 'companySeal.find');
});

test('criterion_07_an_editor_reads_the_organisations_seals_with_images_in_the_picker', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const owner = await signIn(world.owner.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const png = await storedSealImage(seal);

  const draft = await buildDraftWithRecipients(request, world, [{ email: world.member.email }]);

  const picker = await trpcCall(
    owner.request,
    SEAL_PROCEDURES.findForEnvelope,
    SEAL_INPUT.findForEnvelope(draft.envelopeId),
    {
      method: 'GET',
    },
  );

  expect(picker.ok, `findForEnvelope failed: ${picker.status} ${picker.text}`).toBe(true);
  expect(picker.text).toContain(seal.id);
  expect(bodyCarriesImage(picker.text, png), 'the picker answer carries the seal image').toBe(true);
  expectPrivateNoStore(picker.headers, 'companySeal.findForEnvelope');
});

test('criterion_07_an_authorised_recipient_reads_the_seal_at_the_confirmation_step', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const member = await signIn(world.member.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const png = await storedSealImage(seal);

  const built = await buildSealEnvelope(request, world, {
    recipients: [{ email: world.member.email, sealId: seal.id }],
  });
  const person = built.personByEmail(world.member.email);

  const confirm = await getSealForField(member.request, person.token, person.sealFieldId as number);

  expect(confirm.ok, `getForField failed: ${confirm.status} ${confirm.text}`).toBe(true);
  expect(bodyCarriesImage(confirm.text, png), 'the confirmation answer carries the seal image').toBe(true);
  expectPrivateNoStore(confirm.headers, 'envelope.companySeal.getForField');
});

test('criterion_07_a_plain_member_cannot_list_the_seals', async ({ signIn }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const member = await signIn(world.member.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const png = await storedSealImage(seal);

  const listed = await trpcCall(member.request, SEAL_PROCEDURES.find, SEAL_INPUT.find(world.organisation.id), {
    method: 'GET',
  });

  expect(listed.ok).toBe(false);
  expect(bodyCarriesImage(listed.text, png)).toBe(false);
});

test('criterion_07_an_unauthenticated_caller_gets_no_image_from_any_seal_route', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const png = await storedSealImage(seal);

  const built = await buildSealEnvelope(request, world, {
    recipients: [{ email: world.member.email, sealId: seal.id }],
  });
  const person = built.personByEmail(world.member.email);

  const answers = {
    find: await trpcCall(request, SEAL_PROCEDURES.find, SEAL_INPUT.find(world.organisation.id), { method: 'GET' }),
    findForEnvelope: await trpcCall(
      request,
      SEAL_PROCEDURES.findForEnvelope,
      SEAL_INPUT.findForEnvelope(built.envelopeId),
      {
        method: 'GET',
      },
    ),
    getForField: await getSealForField(request, person.token, person.sealFieldId as number),
  };

  for (const [name, answer] of Object.entries(answers)) {
    expect.soft(answer.ok, `${name} refuses a caller with no session (${answer.status})`).toBe(false);
    expect.soft(bodyCarriesImage(answer.text, png), `${name} returns no image`).toBe(false);
  }
});

test('criterion_07_a_manager_of_another_organisation_gets_no_image', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const foreign = await signIn(world.foreignManager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const png = await storedSealImage(seal);

  const built = await buildSealEnvelope(request, world, {
    recipients: [{ email: world.member.email, sealId: seal.id }],
  });
  const person = built.personByEmail(world.member.email);

  const answers = {
    find: await trpcCall(foreign.request, SEAL_PROCEDURES.find, SEAL_INPUT.find(world.organisation.id), {
      method: 'GET',
    }),
    findForEnvelope: await trpcCall(
      foreign.request,
      SEAL_PROCEDURES.findForEnvelope,
      SEAL_INPUT.findForEnvelope(built.envelopeId),
      { method: 'GET' },
    ),
    getForField: await getSealForField(foreign.request, person.token, person.sealFieldId as number),
  };

  for (const [name, answer] of Object.entries(answers)) {
    expect.soft(answer.ok, `${name} refuses another organisation's manager (${answer.status})`).toBe(false);
    expect.soft(bodyCarriesImage(answer.text, png), `${name} returns no image`).toBe(false);
  }
});

test('criterion_07_the_branding_routes_and_guessable_paths_never_serve_a_seal', async ({ signIn, request }) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);
  const png = await storedSealImage(seal);
  const hash = sha256Hex(png);

  const paths = [
    SEAL_ROUTES.brandingLogoOrganisation(world.organisation.id),
    SEAL_ROUTES.brandingLogoOrganisation(seal.id),
    SEAL_ROUTES.brandingLogoTeam(world.team.id),
    `/api/seals/${seal.id}`,
    `/api/seal/${seal.id}`,
    `/api/company-seal/${seal.id}`,
    `/api/company-seals/${seal.id}`,
    `/api/branding/logo/seal/${seal.id}`,
    `/api/branding/seal/${seal.id}`,
  ];

  for (const path of paths) {
    const res = await request.get(path);
    const body = await res.body();
    const text = body.toString('latin1');

    expect.soft(sha256Hex(body) === hash, `${path} does not return the seal image bytes`).toBe(false);
    expect.soft(bodyCarriesImage(text, png), `${path} does not carry the seal image`).toBe(false);
  }
});
