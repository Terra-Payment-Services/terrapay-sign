/**
 * Benchmark for the parse-once change: one API v2 envelope/create carrying five 10 MB PDFs with
 * form values, timed end to end while the server's resident set is sampled.
 *
 * Evidence, not a test. It asserts only that the upload succeeded, so a run
 * that measured a refusal cannot pass for a measurement.
 *
 * Run from packages/app-tests with the repository .env loaded, against a
 * server started with NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT of at least 11 (the
 * default local limit is smaller than the files):
 *
 *   npx dotenv -e ../../.env -- node --import tsx scripts/bench-upload-form-values.ts \
 *     <pid of node build/server/main.js> <input dir> <result json>
 *
 * The five inputs are generated once into the input dir from a fixed seed,
 * so every run, before and after a change, uploads the same bytes. Each is the
 * repository's fillable form followed by pages of noise images and text, about
 * 10 MB in all.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { PDF } from '@libpdf/core';
import { PNG } from 'pngjs';

const run = promisify(execFile);

const FILE_COUNT = 5;
const TARGET_BYTES = 10 * 1024 * 1024;
const IMAGE_SIDE = 512;
const TEXT_PAGES = 200;
const SAMPLE_INTERVAL_MS = 20;

const FORM_VALUES = {
  test_text_field: 'Hello World',
  company_name: 'TerraPay',
  accept_terms: true,
  country: 'Germany',
};

const FORM_PDF = path.join(__dirname, '../../../assets/form-fields-test.pdf');

const main = async () => {
  const [pidArgument, inputDir, outFile] = process.argv.slice(2);
  const serverPid = Number(pidArgument);

  if (!serverPid || !inputDir || !outFile) {
    throw new Error('usage: bench-upload-form-values.ts <server pid> <input dir> <result json>');
  }

  const inputs = await loadInputs(inputDir);
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'bench-32', expiresIn: null });

  // One small upload first, so module loading and JIT warm-up are not billed
  // to the measured request.
  const warmUp = await createEnvelope(token, [{ name: 'warm-up.pdf', bytes: fs.readFileSync(FORM_PDF) }]);

  if (warmUp.status !== 200) {
    throw new Error(`warm-up upload failed: ${warmUp.status} ${warmUp.text.slice(0, 300)}`);
  }

  const baselineRssKb = await readRssKb(serverPid);
  let peakRssKb = baselineRssKb;
  let sampling = true;

  const sampler = (async () => {
    while (sampling) {
      peakRssKb = Math.max(peakRssKb, await readRssKb(serverPid));
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
    }
  })();

  const startedAt = performance.now();
  const response = await createEnvelope(token, inputs);
  const wallMs = performance.now() - startedAt;

  sampling = false;
  await sampler;

  if (response.status !== 200) {
    throw new Error(`measured upload failed: ${response.status} ${response.text.slice(0, 300)}`);
  }

  const { id } = JSON.parse(response.text) as { id: string };
  const storedItems = await prisma.envelopeItem.count({ where: { envelopeId: id } });

  if (storedItems !== FILE_COUNT) {
    throw new Error(`expected ${FILE_COUNT} stored items, found ${storedItems}`);
  }

  const result = {
    wallMs: Math.round(wallMs),
    baselineRssMb: Math.round(baselineRssKb / 1024),
    peakRssMb: Math.round(peakRssKb / 1024),
    peakRssDeltaMb: Math.round((peakRssKb - baselineRssKb) / 1024),
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    envelopeId: id,
    storedItems,
    inputs: inputs.map(({ name, bytes }) => ({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ wallMs: result.wallMs, peakRssMb: result.peakRssMb, delta: result.peakRssDeltaMb }));

  await prisma.$disconnect();
};

const createEnvelope = async (token: string, files: Array<{ name: string; bytes: Uint8Array }>) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ type: 'DOCUMENT', title: 'Bench', formValues: FORM_VALUES }));

  for (const { name, bytes } of files) {
    formData.append('files', new File([bytes], name, { type: 'application/pdf' }));
  }

  const response = await fetch(`${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta/envelope/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  return { status: response.status, text: await response.text() };
};

const readRssKb = async (pid: number) => {
  const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);

  return Number(stdout.trim());
};

const loadInputs = async (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });

  const inputs: Array<{ name: string; bytes: Uint8Array }> = [];

  for (let index = 0; index < FILE_COUNT; index++) {
    const name = `bench-${index + 1}.pdf`;
    const file = path.join(dir, name);

    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, await buildInput(index + 1));
    }

    inputs.push({ name, bytes: new Uint8Array(fs.readFileSync(file)) });
  }

  return inputs;
};

/** The fillable form, then text pages, then noise images until about 10 MB. */
const buildInput = async (seed: number) => {
  const random = mulberry32(seed);
  const doc = await PDF.load(new Uint8Array(fs.readFileSync(FORM_PDF)));

  for (let index = 0; index < TEXT_PAGES; index++) {
    const page = doc.addPage({ size: 'a4' });

    for (let line = 0; line < 40; line++) {
      page.drawText(`Bench input ${seed}, page ${index + 1}, line ${line + 1}: ${random().toString(36)}`, {
        x: 40,
        y: 800 - line * 19,
        size: 9,
      });
    }
  }

  let bytes = await doc.save();

  while (bytes.length < TARGET_BYTES) {
    const page = doc.addPage({ size: 'a4' });

    page.drawImage(doc.embedPng(noisePng(random)), { x: 40, y: 200, width: 500, height: 500 });
    bytes = await doc.save();
  }

  return bytes;
};

const noisePng = (random: () => number) => {
  const png = new PNG({ width: IMAGE_SIDE, height: IMAGE_SIDE });

  for (let offset = 0; offset < png.data.length; offset++) {
    png.data[offset] = offset % 4 === 3 ? 255 : Math.floor(random() * 256);
  }

  return new Uint8Array(PNG.sync.write(png));
};

/** Small seeded PRNG, so the generated inputs are identical on every machine. */
const mulberry32 = (seed: number) => {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;

    let value = Math.imul(state ^ (state >>> 15), 1 | state);

    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

void main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
