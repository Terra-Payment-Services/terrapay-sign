/**
 * Image validation and storage for company seals.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | PNG, JPEG and WebP are accepted and stored as PNG within 1024 px  | 5        |               |
 * | a small image is not enlarged; a 150 px image is accepted         | 5        |               |
 * | a transparent corner stays transparent                            | 5        |               |
 * | EXIF orientation is applied                                       | 5        |               |
 * | a file near 5 MB is accepted                                      | 5        |               |
 * | the stored hash is the SHA-256 of the stored PNG                  | 5        |               |
 * | each unacceptable file is refused with 400 and stores nothing     | 6        | F7            |
 * |   (SVG x2, GIF x2, PDF as PNG, over 5 MB, under 150 px,           |          |               |
 * |   over 40 megapixels, over 1.5 MB after re-encoding)             |          |               |
 * | the server answers promptly after a decompression bomb           | 6        | F7            |
 *
 * Expected on main (red run): every test fails at the first creation,
 * because companySeal.create does not exist.
 *
 * Every refusal, including the two the request boundary makes (the declared
 * type and the 5 MB size, which reuse zfdBrandingImageFile), must carry
 * data.code INVALID_BODY: "Refusals answer 400 INVALID_BODY".
 */
import { expect } from '@playwright/test';
import sharp from 'sharp';

import {
  createSeal,
  discJpeg,
  discPng,
  discPngOfSize,
  discWebp,
  gifBytes,
  noisePng,
  PNG_SIGNATURE,
  pdfBytes,
  SEAL_INPUT,
  SEAL_PROCEDURES,
  type SealSession,
  type SealWorld,
  sealRowCount,
  sealRows,
  seedSealWorld,
  sha256Hex,
  solidPng,
  storedSealImage,
  svgBytes,
  test,
  trpcCall,
  uncompressedPng,
  uniqueSealNames,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const setup = async (signIn: (email: string) => Promise<SealSession>) => {
  const world = await seedSealWorld();
  const session = await signIn(world.manager.email);

  return { world, session };
};

const upload = async (session: SealSession, world: SealWorld, buffer: Buffer, mimeType: string, name = 'seal.png') => {
  const names = uniqueSealNames();

  return await createSeal(session.request, {
    organisationId: world.organisation.id,
    name: names.name,
    legalEntityName: names.legalEntityName,
    image: { buffer, mimeType, name },
  });
};

const storedMetadata = async (organisationId: string) => {
  const [row] = await sealRows(organisationId);
  const bytes = await storedSealImage(row);

  return { row, bytes, meta: await sharp(bytes).metadata() };
};

const FORMATS = [
  { label: 'PNG', make: async () => await discPng(1400), mime: 'image/png', file: 'seal.png' },
  { label: 'JPEG', make: async () => await discJpeg(1400), mime: 'image/jpeg', file: 'seal.jpg' },
  { label: 'WebP', make: async () => await discWebp(1400), mime: 'image/webp', file: 'seal.webp' },
] as const;

for (const format of FORMATS) {
  test(`criterion_05_${format.label}_is_accepted_and_stored_as_a_png_within_1024_px`, async ({ signIn }) => {
    const { world, session } = await setup(signIn);

    const result = await upload(session, world, await format.make(), format.mime, format.file);

    expect(result.ok, `create failed: ${result.status} ${result.text}`).toBe(true);

    const { bytes, meta } = await storedMetadata(world.organisation.id);

    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'stored bytes are a PNG').toBe(true);
    expect(meta.format).toBe('png');
    expect(meta.width, 'resized to fit within 1024').toBe(1024);
    expect(meta.height).toBe(1024);
  });
}

test('criterion_05_a_small_image_is_not_enlarged_and_a_150_px_image_is_accepted', async ({ signIn }) => {
  const { world, session } = await setup(signIn);

  const small = await upload(session, world, await discPng(150), 'image/png');

  expect(small.ok, `a 150 px image is accepted: ${small.status} ${small.text}`).toBe(true);

  const { meta } = await storedMetadata(world.organisation.id);

  expect(meta.width, 'not enlarged').toBe(150);
  expect(meta.height).toBe(150);
});

test('criterion_05_a_transparent_corner_stays_transparent_in_the_stored_image', async ({ signIn }) => {
  const { world, session } = await setup(signIn);

  const result = await upload(session, world, await discPng(400), 'image/png');

  expect(result.ok, `create failed: ${result.text}`).toBe(true);

  const { bytes } = await storedMetadata(world.organisation.id);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  expect(data[3], 'alpha of the top-left pixel').toBe(0);

  const { info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const centre = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;

  expect(data[centre + 3], 'alpha of the centre pixel').toBe(255);
  expect([data[centre], data[centre + 1], data[centre + 2]], 'the centre is still blue').toEqual([0, 0, 255]);
});

test('criterion_05_exif_orientation_is_applied_to_the_stored_image', async ({ signIn }) => {
  const { world, session } = await setup(signIn);

  const landscape = await sharp(await discPngOfSize(300, 200))
    .flatten({ background: '#ffffff' })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  expect((await sharp(landscape).metadata()).orientation, 'fixture precondition').toBe(6);

  const result = await upload(session, world, landscape, 'image/jpeg', 'rotated.jpg');

  expect(result.ok, `create failed: ${result.text}`).toBe(true);

  const { meta } = await storedMetadata(world.organisation.id);

  expect(meta.width, 'a landscape image rotated by its orientation tag is portrait').toBe(200);
  expect(meta.height).toBe(300);
});

test('criterion_05_a_file_near_5_mb_is_accepted_and_stored_small', async ({ signIn }) => {
  const { world, session } = await setup(signIn);
  const big = await uncompressedPng(1100, 1100);

  expect(big.length, 'fixture precondition: close to the limit, under it').toBeGreaterThan(4_000_000);
  expect(big.length).toBeLessThan(5 * 1024 * 1024);

  const result = await upload(session, world, big, 'image/png', 'big.png');

  expect(result.ok, `a file under 5 MB is accepted: ${result.status} ${result.text.slice(0, 300)}`).toBe(true);

  const { bytes } = await storedMetadata(world.organisation.id);

  expect(bytes.length, 'the stored PNG is the re-encoded one').toBeLessThan(1.5 * 1024 * 1024);
});

test('criterion_05_the_stored_hash_is_the_sha256_of_the_stored_png', async ({ signIn }) => {
  const { world, session } = await setup(signIn);

  const result = await upload(session, world, await discPng(600), 'image/png');

  expect(result.ok, `create failed: ${result.text}`).toBe(true);

  const { row, bytes } = await storedMetadata(world.organisation.id);

  expect(row.imageSha256).toBe(sha256Hex(bytes));
  expect(row.imageSha256).toMatch(/^[0-9a-f]{64}$/);
});

type Refusal = {
  label: string;
  make: () => Promise<Buffer>;
  mime: string;
  file: string;
  reason: RegExp;
};

const REFUSALS: Refusal[] = [
  {
    label: 'svg_declared_as_svg',
    make: async () => svgBytes(),
    mime: 'image/svg+xml',
    file: 'seal.svg',
    reason: /jpg|jpeg|png|webp|type|format|svg/i,
  },
  {
    label: 'svg_bytes_declared_as_png',
    make: async () => svgBytes(),
    mime: 'image/png',
    file: 'seal.png',
    reason: /format|png|jpe?g|webp|svg|type|image/i,
  },
  {
    label: 'gif_declared_as_gif',
    make: async () => await gifBytes(),
    mime: 'image/gif',
    file: 'seal.gif',
    reason: /jpg|jpeg|png|webp|type|format|gif/i,
  },
  {
    label: 'gif_bytes_declared_as_png',
    make: async () => await gifBytes(),
    mime: 'image/png',
    file: 'seal.png',
    reason: /format|png|jpe?g|webp|gif|type|image/i,
  },
  {
    label: 'pdf_renamed_png',
    make: async () => await pdfBytes(),
    mime: 'image/png',
    file: 'seal.png',
    reason: /format|png|jpe?g|webp|pdf|type|image/i,
  },
  {
    label: 'file_over_5_mb',
    make: async () => await uncompressedPng(1300, 1300),
    mime: 'image/png',
    file: 'huge.png',
    reason: /5 ?MB|large|size/i,
  },
  {
    label: 'shorter_side_under_150_px',
    make: async () => await discPngOfSize(149, 400),
    mime: 'image/png',
    file: 'thin.png',
    reason: /150|small|short|side|pixel/i,
  },
  {
    label: 'dimensions_over_40_megapixels',
    make: async () => await solidPng(7000, 6000),
    mime: 'image/png',
    file: 'bomb.png',
    reason: /megapixel|40|pixel|dimension|large/i,
  },
  {
    label: 'reencoded_png_over_1_5_mb',
    make: async () => await noisePng(1000),
    mime: 'image/png',
    file: 'noise.png',
    reason: /1\.5|MB|large|size|complex/i,
  },
];

for (const refusal of REFUSALS) {
  test(`criterion_06_${refusal.label}_is_refused_with_400_and_stores_nothing`, async ({ signIn }) => {
    const { world, session } = await setup(signIn);
    const buffer = await refusal.make();

    const started = Date.now();
    const result = await upload(session, world, buffer, refusal.mime, refusal.file);
    const elapsed = Date.now() - started;

    expect.soft(result.ok, `refused (${result.status})`).toBe(false);
    expect.soft(result.httpStatus, `declared status: ${result.text.slice(0, 300)}`).toBe(400);
    // Spec, "Image validation and storage": refusals answer 400 INVALID_BODY, at the boundary as in processing.
    expect.soft(result.code, `error code ${result.code}: ${result.text.slice(0, 300)}`).toBe('INVALID_BODY');
    expect.soft(result.text, 'the message names the reason').toMatch(refusal.reason);
    expect.soft(await sealRowCount(world.organisation.id), 'nothing is stored').toBe(0);
    expect.soft(elapsed, 'refused without stalling').toBeLessThan(30_000);

    // The server keeps answering other requests.
    const listed = await trpcCall(session.request, SEAL_PROCEDURES.find, SEAL_INPUT.find(world.organisation.id), {
      method: 'GET',
    });

    expect(listed.ok, `the server still answers: ${listed.status} ${listed.text.slice(0, 200)}`).toBe(true);
  });
}
