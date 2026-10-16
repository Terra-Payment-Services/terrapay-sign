/**
 * What the envelope owner sees of an applied company seal on the document page.
 *
 * Written from the specification alone, before any
 * implementation exists. The first signer signs and applies the seal through
 * the real signing page; the owner then opens the document page and the
 * verdicts come from the envelope.field.getSignatures response body and the
 * Konva node tree of the page.
 *
 * | Test                                                                    | Acceptance | Fails on main |
 * | ----------------------------------------------------------------------- | ---------- | ------------- |
 * | getSignatures carries the applied seal field with its image             | A          | yes           |
 * | the applied seal field is drawn as an Image node, never "Signature"     | A          | yes           |
 * | the first signer's SIGNATURE field and its entry are as before          | A (as before) | no         |
 * | the second signer's uninserted seal field still shows its seal label    | A (as before) | no         |
 * | a caller outside the team is refused as before, with no seal bytes      | B          | no            |
 *
 * The two signers each have a SIGNATURE and a COMPANY_SEAL field. Only the
 * first signs, so the envelope stays PENDING, the state the owner page draws
 * from getSignatures.
 */
import { prisma } from '@documenso/prisma';
import { expect, type Page, type Response } from '@playwright/test';

import {
  buildSealEnvelope,
  createBlueSeal,
  expectPrivateNoStore,
  letterSquare,
  readSealField,
  SEAL_UI,
  type SealSession,
  seedSealWorld,
  setupMemberSeal,
  snapshotOf,
  test,
  trpcCall,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 240_000 });

const SIGNED_NAME = 'Priya Signer';
const SIGNATURES_PROCEDURE = 'envelope.field.getSignatures';

type Entry = { fieldId: number; signatureImageAsBase64: string | null; typedSignature: string | null };
type Child = { className: string; text: string | null; imageLoaded: boolean | null };

type Box = { positionX: unknown; positionY: unknown; width: unknown; height: unknown };

const clickFieldCentre = async (page: Page, field: Box) => {
  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
  const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

  await canvas.click({ position: { x, y } });
  await page.waitForTimeout(500);
};

/** The first signer signs, applies the seal and completes, all on the signing page. */
const signThroughThePage = async (
  member: SealSession,
  person: { token: string; signatureFieldId?: number; sealFieldId?: number },
) => {
  const { page } = member;

  await page.goto(`/sign/${person.token}`);

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill(SIGNED_NAME);
  await page.getByRole('button', { name: 'Next' }).click();

  const signatureField = await prisma.field.findUniqueOrThrow({ where: { id: person.signatureFieldId as number } });
  const sealField = await prisma.field.findUniqueOrThrow({ where: { id: person.sealFieldId as number } });

  await clickFieldCentre(page, signatureField);
  await clickFieldCentre(page, sealField);

  const confirmation = page.getByTestId(SEAL_UI.confirmDialogTestId);

  await expect(confirmation, 'the seal confirmation step appears').toBeVisible();
  await confirmation.getByRole('button', { name: SEAL_UI.applyButton }).click();

  await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Complete' }).first().click();
  await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();

  await expect
    .poll(async () => (await prisma.recipient.findFirstOrThrow({ where: { token: person.token } })).signingStatus, {
      timeout: 60_000,
    })
    .toBe('SIGNED');
};

/** The answer to getSignatures out of a possibly batched tRPC response. */
const signaturesFrom = async (response: Response) => {
  const url = new URL(response.url());
  const procedures = decodeURIComponent(url.pathname.split('/api/trpc/')[1]).split(',');
  const body = await response.json();
  const entry = Array.isArray(body) ? body[procedures.indexOf(SIGNATURES_PROCEDURE)] : body;

  return {
    status: response.status(),
    headers: response.headers(),
    data: entry?.result?.data?.json as Entry[] | undefined,
    text: JSON.stringify(entry),
  };
};

/** What the Konva group of one field holds, read from the live page. */
const readGroup = async (page: Page, fieldId: number) =>
  await page.evaluate((id) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const konva = (window as unknown as { Konva: typeof import('konva').default }).Konva;
    const stage = konva.stages.find((s) => s.attrs.id === 'page-1');
    const group = stage?.findOne(`#${id}`);

    if (!group || !('getChildren' in group)) {
      return null;
    }

    return (group as import('konva').default.Group).getChildren().map(
      (child): Child => ({
        className: child.getClassName(),
        text: child.getClassName() === 'Text' ? (child as import('konva').default.Text).text() : null,
        imageLoaded:
          child.getClassName() === 'Image'
            ? ((child as import('konva').default.Image).image() as HTMLImageElement | undefined)?.complete === true
            : null,
      }),
    );
  }, fieldId);

const setup = async (
  signIn: (email: string) => Promise<SealSession>,
  request: Parameters<typeof buildSealEnvelope>[0],
) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id);

  const built = await buildSealEnvelope(request, world, {
    recipients: [
      { email: world.member.email, sealId: seal.id },
      { email: world.otherMember.email, sealId: seal.id, sealBox: letterSquare(40, 60, 20) },
    ],
  });

  const first = built.personByEmail(world.member.email);
  const second = built.personByEmail(world.otherMember.email);

  await signThroughThePage(await signIn(world.member.email), first);

  const owner = await signIn(world.owner.email);
  const signatures = owner.page.waitForResponse((r) => r.url().includes(SIGNATURES_PROCEDURE), { timeout: 60_000 });

  await owner.page.goto(`/t/${world.team.url}/documents/${built.envelopeId}`);

  return { world, seal, built, first, second, owner, answer: await signaturesFrom(await signatures) };
};

test('A_getSignatures_returns_the_applied_seal_field_with_its_image', async ({ signIn, request }) => {
  const { first, answer } = await setup(signIn, request);

  expectPrivateNoStore(answer.headers, 'getSignatures');
  expect(answer.status, `getSignatures answered ${answer.text.slice(0, 200)}`).toBe(200);

  const { signature } = await readSealField(first.sealFieldId as number);
  const stored = snapshotOf(signature);

  expect(stored, 'precondition: the applied seal has a stored PNG snapshot').toBeTruthy();

  const entry = (answer.data ?? []).find((e) => e.fieldId === first.sealFieldId);

  expect(
    entry,
    `an entry for seal field ${first.sealFieldId} among ${(answer.data ?? []).map((e) => e.fieldId)}`,
  ).toBeTruthy();
  expect(entry?.signatureImageAsBase64, 'the seal image is not empty').toBeTruthy();
  expect(entry?.signatureImageAsBase64, 'it is the stored PNG snapshot').toBe(signature?.signatureImageAsBase64);
  expect(entry?.signatureImageAsBase64?.startsWith('data:image/png;base64,')).toBe(true);
});

test('A_the_applied_seal_field_is_drawn_as_an_image_and_never_as_the_text_Signature', async ({ signIn, request }) => {
  const { first, owner } = await setup(signIn, request);

  await expect
    .poll(async () => (await readGroup(owner.page, first.sealFieldId as number))?.length ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Let the answer land and the field redraw before judging the final picture.
  await owner.page.waitForLoadState('networkidle');

  const children = (await readGroup(owner.page, first.sealFieldId as number)) as Child[];
  const describe = JSON.stringify(children);

  expect(
    children.filter((c) => c.className === 'Image'),
    `the seal group holds one Image node (children: ${describe})`,
  ).toHaveLength(1);
  expect(
    children.filter((c) => c.className === 'Text' && c.text === 'Signature'),
    `the seal group holds no Text node reading "Signature" (children: ${describe})`,
  ).toHaveLength(0);
  expect(children.find((c) => c.className === 'Image')?.imageLoaded, 'the seal image has loaded').toBe(true);
});

test('A_as_before_the_first_signers_SIGNATURE_field_still_draws_its_typed_signature', async ({ signIn, request }) => {
  const { first, owner, answer } = await setup(signIn, request);

  const entry = (answer.data ?? []).find((e) => e.fieldId === first.signatureFieldId);

  expect(entry, `an entry for signature field ${first.signatureFieldId}`).toBeTruthy();
  expect(entry?.typedSignature, 'the typed name the signer entered').toBe(SIGNED_NAME);

  await expect
    .poll(async () => (await readGroup(owner.page, first.signatureFieldId as number))?.length ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const children = (await readGroup(owner.page, first.signatureFieldId as number)) as Child[];

  expect(
    children.filter((c) => c.className === 'Text').map((c) => c.text),
    `the signature group shows the signer's typed name (children: ${JSON.stringify(children)})`,
  ).toEqual([SIGNED_NAME]);
});

test('A_as_before_the_second_signers_uninserted_seal_field_still_shows_its_seal_label', async ({ signIn, request }) => {
  const { seal, second, owner } = await setup(signIn, request);

  await expect
    .poll(async () => (await readGroup(owner.page, second.sealFieldId as number))?.length ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const children = (await readGroup(owner.page, second.sealFieldId as number)) as Child[];

  expect(
    children.filter((c) => c.className === 'Text').map((c) => c.text),
    `the uninserted seal field shows its label (children: ${JSON.stringify(children)})`,
  ).toEqual([`${seal.name} (${seal.legalEntityName})`]);
  expect(
    children.filter((c) => c.className === 'Image'),
    'and no image',
  ).toHaveLength(0);
});

test('B_a_caller_outside_the_team_is_refused_as_before_and_receives_no_seal_bytes', async ({ signIn, request }) => {
  const { world, built, first } = await setup(signIn, request);
  const { signature } = await readSealField(first.sealFieldId as number);
  const sealBase64 = (signature?.signatureImageAsBase64 as string).split(',')[1];
  const input = { envelopeId: built.envelopeId };

  const foreign = await signIn(world.foreignOwner.email);

  const own = await trpcCall(foreign.request, SIGNATURES_PROCEDURE, input, { method: 'GET' });
  const named = await trpcCall(foreign.request, SIGNATURES_PROCEDURE, input, {
    method: 'GET',
    headers: { 'x-team-id': String(world.team.id) },
  });
  const anonymous = await trpcCall(request, SIGNATURES_PROCEDURE, input, { method: 'GET' });

  for (const [who, result] of [
    ['a signed-in user of another team', own],
    ['that user naming this team', named],
    ['no session', anonymous],
  ] as const) {
    expect(result.ok, `${who}: refused (${result.status} ${result.text.slice(0, 200)})`).toBe(false);
    expect(result.text.includes(sealBase64), `${who}: the answer carries no seal bytes`).toBe(false);
  }

  expect.soft(`${own.status} ${own.code}`, 'another team, no team header').toBe('404 NOT_FOUND');
  expect.soft(`${named.status} ${named.code}`, 'another team, naming this team').toBe('404 NOT_FOUND');
  expect.soft(`${anonymous.status} ${anonymous.code}`, 'no session').toBe('401 UNAUTHORIZED');
});

test('D_an_owner_calling_from_another_team_gets_no_seal_entry_and_no_seal_bytes', async ({ signIn, request }) => {
  const { world, built, first } = await setup(signIn, request);
  const { signature } = await readSealField(first.sealFieldId as number);
  const sealBase64 = (signature?.signatureImageAsBase64 as string).split(',')[1];

  // The owner of the envelope belongs to another team and is not a member of the envelope's team. The foreign
  // owner's own team stands for that other team, and the envelope is owned by that user.
  const otherTeam = await prisma.team.findFirstOrThrow({
    where: { organisationId: world.foreignOrganisation.id },
  });

  await prisma.envelope.update({ where: { id: built.envelopeId }, data: { userId: world.foreignOwner.id } });

  const other = await signIn(world.foreignOwner.email);
  const result = await trpcCall(
    other.request,
    SIGNATURES_PROCEDURE,
    { envelopeId: built.envelopeId },
    { method: 'GET', headers: { 'x-team-id': String(otherTeam.id) } },
  );

  expect(result.text.includes(sealBase64), `the answer carries no seal bytes (${result.status})`).toBe(false);

  const entries = (result.data ?? []) as Entry[];

  expect(
    entries.map((e) => e.fieldId),
    `no entry for seal field ${first.sealFieldId} (status ${result.status}, ${result.text.slice(0, 200)})`,
  ).not.toContain(first.sealFieldId);
  expect(result.ok, `the owner is still answered, as today (${result.status} ${result.text.slice(0, 200)})`).toBe(true);
  expect(
    entries.map((e) => e.fieldId),
    'and still gets the inserted SIGNATURE entry',
  ).toContain(first.signatureFieldId);
});

test('E_a_recipient_who_applied_the_seal_and_reloaded_is_not_prefilled_with_the_seal_image', async ({
  signIn,
  request,
}) => {
  const { world, person } = await setupMemberSeal(signIn, request);
  const { page } = await signIn(world.member.email);

  await page.goto(`/sign/${person.token}`);

  const signatureField = await prisma.field.findUniqueOrThrow({ where: { id: person.signatureFieldId as number } });
  const sealField = await prisma.field.findUniqueOrThrow({ where: { id: person.sealFieldId as number } });

  await clickFieldCentre(page, sealField);

  const confirmation = page.getByTestId(SEAL_UI.confirmDialogTestId);

  await expect(confirmation, 'the seal confirmation step appears').toBeVisible();
  await confirmation.getByRole('button', { name: SEAL_UI.applyButton }).click();

  await expect
    .poll(async () => (await readSealField(person.sealFieldId as number)).field.inserted, { timeout: 15_000 })
    .toBe(true);

  const sealImage = (await readSealField(person.sealFieldId as number)).signature?.signatureImageAsBase64;

  expect(sealImage, 'precondition: the applied seal has a stored image').toBeTruthy();

  await page.reload();
  await expect(page.getByText('1 Field Remaining').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await clickFieldCentre(page, signatureField);

  const dialog = page.getByRole('dialog').first();

  // Either the signature dialog opens, or the field is inserted with an image of its own.
  await expect
    .poll(
      async () =>
        (await dialog.isVisible()) ||
        (await prisma.field.findUniqueOrThrow({ where: { id: person.signatureFieldId as number } })).inserted,
      { timeout: 15_000 },
    )
    .toBe(true);

  const stored = await readSealField(person.signatureFieldId as number);

  if (stored.field.inserted) {
    expect(stored.signature?.signatureImageAsBase64, 'the SIGNATURE field was not filled with the seal image').not.toBe(
      sealImage,
    );
  }
});
