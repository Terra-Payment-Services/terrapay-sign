/**
 * What a sealed PDF shows and keeps: the seal's pixels, the effect of a
 * later change to the seal, and counterparty signatures.
 *
 * Written from the specification alone, before any implementation exists.
 * Every verdict on the PDF comes from poppler reading the downloaded bytes:
 * pdftoppm for pixels, pdfsig for signatures.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | a square field shows the blue disc over 70 per cent of its area  | 22       | F10           |
 * | a wide field shows a round disc, centred, nothing outside         | 22       |               |
 * | a reseal after the seal row is overwritten is still blue          | 23       | F8            |
 * | a counterparty-signed PDF with a seal field completes, both valid | 24       | F13           |
 * | guard: counterparty-signed PDF with no seal field seals as before | 28       | F13, F14      |
 * | guard: a plain envelope with no seal field seals and verifies     | 28       | F14           |
 *
 * Expected on main (red run): the criterion tests fail creating the first
 * seal. The two guards pass on main and must keep passing.
 *
 * The test seal is a solid blue disc on a transparent square, so an inscribed
 * disc covers pi/4, about 78.5 per cent, of a square field.
 */
import fs from 'node:fs';
import path from 'node:path';

import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect } from '@playwright/test';

import {
  analyseFieldArea,
  buildSealEnvelope,
  DEFAULT_SEAL_BOX,
  discPng,
  downloadVersion,
  overwriteSealImage,
  RED,
  SEAL_PROCEDURES,
  type SealSession,
  type SealWorld,
  sealRowById,
  seedSealWorld,
  setupMemberSeal,
  sha256Hex,
  signAndCompleteAll,
  storedSealImage,
  test,
  trpcCall,
  waitForEnvelopeStatus,
} from '../fixtures/company-seals';
import { readSignaturesWithPdfsig, SIGNATURE_VALID } from '../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel', timeout: 240_000 });

const EXTERNALLY_SIGNED = fs.readFileSync(
  path.join(__dirname, '../../../lib/server-only/pdf/__fixtures__/externally-signed.pdf'),
);

const completeAndDownload = async (
  built: Awaited<ReturnType<typeof setupMemberSeal>>['built'],
  member: SealSession,
  request: Parameters<typeof signAndCompleteAll>[2],
  email: string,
) => {
  await signAndCompleteAll(built, { [email]: member }, request);

  return await downloadVersion(request, built.apiToken, built.envelopeItemId, 'signed');
};

test('criterion_22_a_square_field_shows_the_blue_disc_over_most_of_its_area_and_nothing_outside', async ({
  signIn,
  request,
}) => {
  const { world, built } = await setupMemberSeal(signIn, request, { sealBox: DEFAULT_SEAL_BOX });
  const member = await signIn(world.member.email);

  const sealed = await completeAndDownload(built, member, request, world.member.email);
  const area = await analyseFieldArea(sealed, DEFAULT_SEAL_BOX);

  expect
    .soft(area.blueRatio, 'share of the field that is the disc blue (an inscribed disc covers about 0.78)')
    .toBeGreaterThanOrEqual(0.7);
  expect.soft(area.blueOutside, 'blue pixels just outside the field').toBe(0);
  expect.soft(area.blueBox, 'the disc is there').toBeTruthy();

  if (area.blueBox) {
    expect.soft(Math.abs(area.blueBox.width - area.blueBox.height), 'the disc is round').toBeLessThanOrEqual(3);
  }
});

test('criterion_22_a_wide_field_keeps_the_disc_round_and_centred', async ({ signIn, request }) => {
  const box = { positionX: 30, positionY: 40, width: 40, height: 10 };
  const { world, built } = await setupMemberSeal(signIn, request, { sealBox: box });
  const member = await signIn(world.member.email);

  const sealed = await completeAndDownload(built, member, request, world.member.email);
  const area = await analyseFieldArea(sealed, box);

  // The disc touches the top and bottom edges of a wide field, so a few anti-aliased pixels land just outside.
  expect.soft(area.blueOutside, 'blue pixels just outside the field').toBeLessThanOrEqual(30);
  expect(area.blueBox, 'the disc is there').toBeTruthy();

  const disc = area.blueBox as { width: number; height: number };

  expect.soft(disc.width / disc.height, 'aspect ratio kept: the disc is round, not stretched').toBeGreaterThan(0.95);
  expect.soft(disc.width / disc.height).toBeLessThan(1.05);
  expect.soft(disc.height, 'scaled to fit the field height').toBeGreaterThanOrEqual(area.fieldPixels.height * 0.9);
  expect.soft(disc.width, 'and no wider than the field').toBeLessThan(area.fieldPixels.width * 0.5);
});

test('criterion_23_a_reseal_after_the_seal_row_is_overwritten_still_shows_the_original_blue_disc', async ({
  signIn,
  request,
}) => {
  const { world, seal, built } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);

  const first = await completeAndDownload(built, member, request, world.member.email);
  const before = await analyseFieldArea(first, DEFAULT_SEAL_BOX);

  expect(before.blueRatio, 'precondition: the first seal is blue').toBeGreaterThanOrEqual(0.7);

  // Stands in for an operator's change; the application has no way to make one.
  await overwriteSealImage(seal.id, await discPng(400, RED));

  const overwritten = await storedSealImage((await sealRowById(seal.id)) as typeof seal);

  expect(sha256Hex(overwritten), 'precondition: the row now holds the red disc').not.toBe(seal.imageSha256);

  const { user: platformAdmin } = await seedUser({ isAdmin: true });
  const admin = await signIn(platformAdmin.email);

  const itemBefore = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: built.envelopeItemId } });

  const resealed = await trpcCall(admin.request, SEAL_PROCEDURES.reseal, { id: built.envelopeId });

  expect(resealed.ok, `reseal failed: ${resealed.status} ${resealed.text}`).toBe(true);

  // A reseal within the same second as the first seal can be byte-identical, so the new document data row is the
  // signal that it finished, not a different hash.
  await expect
    .poll(
      async () =>
        (await prisma.envelopeItem.findUniqueOrThrow({ where: { id: built.envelopeItemId } })).documentDataId !==
        itemBefore.documentDataId,
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe(true);

  const latest = await downloadVersion(request, built.apiToken, built.envelopeItemId, 'signed');

  const after = await analyseFieldArea(latest, DEFAULT_SEAL_BOX);

  expect.soft(after.blueRatio, 'the resealed field is still blue').toBeGreaterThanOrEqual(0.7);
  expect.soft(after.redRatio, 'and holds no red').toBe(0);
});

const sealCounterpartySigned = async (
  signIn: (email: string) => Promise<SealSession>,
  request: Parameters<typeof signAndCompleteAll>[2],
  withSeal: boolean,
) => {
  if (!withSeal) {
    const world: SealWorld = await seedSealWorld();
    const built = await buildSealEnvelope(request, world, {
      pdf: { name: 'externally-signed.pdf', data: EXTERNALLY_SIGNED },
      recipients: [{ email: world.member.email }],
    });

    await signAndCompleteAll(built, {}, request);

    return { sealed: await downloadVersion(request, built.apiToken, built.envelopeItemId, 'signed') };
  }

  const { world, built } = await setupMemberSeal(signIn, request, {
    pdf: { name: 'externally-signed.pdf', data: EXTERNALLY_SIGNED },
  });
  const member = await signIn(world.member.email);

  return { sealed: await completeAndDownload(built, member, request, world.member.email) };
};

test('criterion_24_a_counterparty_signed_pdf_with_a_seal_field_completes_with_both_signatures_valid', async ({
  signIn,
  request,
}) => {
  const original = readSignaturesWithPdfsig(EXTERNALLY_SIGNED);

  expect(original, 'fixture precondition: one valid counterparty signature').toHaveLength(1);
  expect(original[0].validation).toBe(SIGNATURE_VALID);

  const { sealed } = await sealCounterpartySigned(signIn, request, true);
  const signatures = readSignaturesWithPdfsig(sealed);

  const counterparty = signatures.find(
    (s) => s.fieldName === original[0].fieldName && s.signingTime === original[0].signingTime,
  );

  expect.soft(counterparty, `the counterparty signature survives (pdfsig saw ${signatures.length})`).toBeTruthy();
  expect.soft(signatures.length, "Sign's own signature is present as well").toBeGreaterThanOrEqual(2);

  for (const signature of signatures) {
    expect
      .soft(signature.validation, `pdfsig verifies #${signature.index} (${signature.fieldName})`)
      .toBe(SIGNATURE_VALID);
  }

  const area = await analyseFieldArea(sealed, DEFAULT_SEAL_BOX);

  expect.soft(area.blueRatio, 'the seal is visible as in criterion 22').toBeGreaterThanOrEqual(0.7);
  expect.soft(area.blueOutside).toBe(0);
});

test('criterion_28_guard_a_counterparty_signed_pdf_with_no_seal_field_seals_exactly_as_before', async ({
  signIn,
  request,
}) => {
  const original = readSignaturesWithPdfsig(EXTERNALLY_SIGNED);
  const { sealed } = await sealCounterpartySigned(signIn, request, false);
  const signatures = readSignaturesWithPdfsig(sealed);

  expect(signatures.length, "the counterparty's and Sign's signatures").toBeGreaterThanOrEqual(2);
  expect(
    signatures.some((s) => s.fieldName === original[0].fieldName && s.signingTime === original[0].signingTime),
  ).toBe(true);

  for (const signature of signatures) {
    expect(signature.validation, `pdfsig verifies #${signature.index}`).toBe(SIGNATURE_VALID);
  }
});

test('criterion_28_guard_a_plain_envelope_with_no_seal_field_seals_and_verifies', async ({ request }) => {
  const world = await seedSealWorld();
  const built = await buildSealEnvelope(request, world, { recipients: [{ email: world.member.email }] });

  await signAndCompleteAll(built, {}, request);
  await waitForEnvelopeStatus(built.envelopeId, 'COMPLETED');

  const sealed = await downloadVersion(request, built.apiToken, built.envelopeItemId, 'signed');
  const signatures = readSignaturesWithPdfsig(sealed);

  expect(signatures).toHaveLength(1);
  expect(signatures[0].validation).toBe(SIGNATURE_VALID);
});
