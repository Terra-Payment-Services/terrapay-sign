/**
 * Generates the G4 signature image fixtures into e2e/fixtures/signature-ink/
 * with a manifest.json recording each file's dimensions, size, SHA-256, D1 ink
 * coverage and the verdict the G4 spec expects.
 *
 * Pixels are written with pngjs from a seeded PRNG, so a rerun gives the same
 * files. sharp is used only where pngjs cannot write the format (JPEG, GIF,
 * WebP, palette, 16-bit, interlaced, greyscale-alpha). Coverage is computed
 * with pngjs and the spec's D1 formula, never with sharp, which is what the
 * implementation is expected to use.
 *
 * Run from packages/app-tests: npx tsx scripts/generate-signature-ink-fixtures.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { PNG } from 'pngjs';
import sharp from 'sharp';

const OUT = path.join(__dirname, '../e2e/fixtures/signature-ink');

type Expected = 'accept' | 'refuse';

type Entry = {
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  coverage: number | null;
  expected: Expected;
  criteria: string[];
  note: string;
};

const manifest: Record<string, Entry> = {};

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

const mulberry32 = (seed: number) => {
  let a = seed;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const gaussian = (random: () => number) => {
  const u = Math.max(random(), 1e-12);
  const v = random();

  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const blank = (width: number, height: number) => {
  const png = new PNG({ width, height });

  png.data.fill(0);

  return png;
};

const setPixel = (png: PNG, x: number, y: number, rgba: [number, number, number, number]) => {
  const i = (y * png.width + x) * 4;

  png.data[i] = rgba[0];
  png.data[i + 1] = rgba[1];
  png.data[i + 2] = rgba[2];
  png.data[i + 3] = rgba[3];
};

/** Exactly `count` pixels of `rgba`, row-major inside a centred block `blockWidth` wide. */
const fillCount = (png: PNG, count: number, rgba: [number, number, number, number], blockWidth: number) => {
  const x0 = Math.floor((png.width - blockWidth) / 2);
  const y0 = Math.floor((png.height - Math.ceil(count / blockWidth)) / 2);

  for (let n = 0; n < count; n++) {
    setPixel(png, x0 + (n % blockWidth), y0 + Math.floor(n / blockWidth), rgba);
  }
};

/** Scattered strokes: `count` distinct pixels of `rgba` along random short horizontal dashes. */
const strokes = (png: PNG, count: number, rgba: [number, number, number, number], seed: number, margin = 20) => {
  const random = mulberry32(seed);
  const used = new Set<number>();

  while (used.size < count) {
    const x = margin + Math.floor(random() * (png.width - 2 * margin - 40));
    const y = margin + Math.floor(random() * (png.height - 2 * margin));
    const length = 10 + Math.floor(random() * 30);

    for (let dx = 0; dx < length && used.size < count; dx++) {
      const key = y * png.width + x + dx;

      if (!used.has(key)) {
        used.add(key);
        setPixel(png, x + dx, y, rgba);
      }
    }
  }
};

const paper = (width: number, height: number, mean: number, sigma: number, seed: number) => {
  const png = new PNG({ width, height });
  const random = mulberry32(seed);

  for (let i = 0; i < width * height; i++) {
    const v = Math.max(0, Math.min(255, Math.round(mean + sigma * gaussian(random))));

    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }

  return png;
};

const isInk = (r: number, g: number, b: number, alpha255: number) => {
  const a = alpha255 / 255;

  return a * (0.299 * r + 0.587 * g + 0.114 * b) + (1 - a) * 255 < 230;
};

const coverage = (png: PNG) => {
  let ink = 0;

  for (let i = 0; i < png.data.length; i += 4) {
    if (isInk(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3])) {
      ink++;
    }
  }

  return ink / (png.width * png.height);
};

// ---------------------------------------------------------------------------
// PNG chunks
// ---------------------------------------------------------------------------

const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);

  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);

  return Buffer.concat([length, body, crc]);
};

/** Inserts `extra` right after IHDR (signature 8 bytes + IHDR chunk 25 bytes). */
const insertAfterIhdr = (png: Buffer, extra: Buffer) => Buffer.concat([png.subarray(0, 33), extra, png.subarray(33)]);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const write = (
  name: string,
  file: string,
  bytes: Buffer,
  dims: { width: number; height: number },
  expected: Expected,
  criteria: string[],
  note: string,
) => {
  fs.writeFileSync(path.join(OUT, file), bytes);

  let cov: number | null = null;

  if (file.endsWith('.png')) {
    try {
      cov = coverage(PNG.sync.read(bytes));
    } catch {
      // pngjs refuses trailing data after IEND; the pixels are the source's, recorded from it.
      cov = coverage(PNG.sync.read(bytes.subarray(0, bytes.lastIndexOf(Buffer.from('IEND', 'latin1')) + 8)));
    }
  }

  manifest[name] = {
    file,
    width: dims.width,
    height: dims.height,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    coverage: cov,
    expected,
    criteria,
    note,
  };
};

const writePng = (name: string, png: PNG, expected: Expected, criteria: string[], note: string) =>
  write(name, `${name}.png`, PNG.sync.write(png), png, expected, criteria, note);

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const BLACK: [number, number, number, number] = [0, 0, 0, 255];

  // C1: the pad's 16:7 aspect, nothing drawn.
  writePng('transparent-1000x438', blank(1000, 438), 'refuse', ['C1', 'C50'], 'Fully transparent RGBA.');

  // C2: the threshold pair, identical except for the ink pixel count (438000 pixels).
  const below = blank(1000, 438);
  fillCount(below, 3942, BLACK, 800);
  writePng('ink-0p9-1000x438', below, 'refuse', ['C2', 'C50'], '3942 opaque black pixels on transparency: 0.9%.');

  const above = blank(1000, 438);
  fillCount(above, 4818, BLACK, 800);
  writePng('ink-1p1-1000x438', above, 'accept', ['C2', 'C50'], '4818 opaque black pixels on transparency: 1.1%.');

  // The generic valid image: 400 x 175 (16:7), black strokes over 6%.
  const valid = blank(400, 175);
  strokes(valid, 4200, BLACK, 7);
  const validBytes = PNG.sync.write(valid);
  writePng('valid-inked', valid, 'accept', ['C3', 'C6', 'C10', 'C18', 'C20-C23'], 'Black strokes on transparency, 6%.');

  // C4: other formats under the PNG prefix, from the same strokes flattened on white where needed.
  const jpeg = await sharp(validBytes).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  write('jpeg-bytes', 'jpeg-bytes.jpg', jpeg, valid, 'refuse', ['C4'], 'JPEG of valid-inked on white.');

  const gif = await sharp(validBytes).gif().toBuffer();
  write('gif-bytes', 'gif-bytes.gif', gif, valid, 'refuse', ['C4'], 'GIF of valid-inked.');

  const webp = await sharp(validBytes).webp({ lossless: true }).toBuffer();
  write('webp-bytes', 'webp-bytes.webp', webp, valid, 'refuse', ['C4'], 'Lossless WebP of valid-inked.');

  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="175">' +
      '<path d="M20 120 C 80 20, 160 20, 200 100 S 320 160, 380 60" stroke="black" stroke-width="12" fill="none"/>' +
      '</svg>',
  );
  write('svg-bytes', 'svg-bytes.svg', svg, valid, 'refuse', ['C4'], 'SVG with a 12 px black stroke.');

  // C8: header and IHDR intact, cut halfway through the first IDAT, no IEND.
  const idat = validBytes.indexOf(Buffer.from('IDAT', 'latin1')) - 4;
  const idatLength = validBytes.readUInt32BE(idat);
  const truncated = validBytes.subarray(0, idat + 8 + Math.floor(idatLength / 2));
  write('truncated-idat', 'truncated-idat.png.bin', truncated, valid, 'refuse', ['C8'], 'valid-inked cut inside IDAT.');

  // C9: 5000 x 5000, compresses small, ink 3%.
  const huge = blank(5000, 5000);
  for (let y = 0; y < 5000; y += 100) {
    for (let dy = 0; dy < 3; dy++) {
      for (let x = 0; x < 5000; x++) {
        setPixel(huge, x, y + dy, BLACK);
      }
    }
  }
  writePng('huge-5000x5000', huge, 'refuse', ['C9'], 'Horizontal 3 px black lines every 100 px: 3% ink.');

  // C10: trailing bytes after IEND, and a tEXt chunk.
  write(
    'trailing-bytes',
    'trailing-bytes.png',
    Buffer.concat([validBytes, Buffer.from('<html><body>trailing</body></html>', 'latin1')]),
    valid,
    'accept',
    ['C10'],
    'valid-inked followed by HTML after IEND.',
  );
  write(
    'text-chunk',
    'text-chunk.png',
    insertAfterIhdr(validBytes, chunk('tEXt', Buffer.from('Comment\0g4 ancillary text chunk', 'latin1'))),
    valid,
    'accept',
    ['C10'],
    'valid-inked with a tEXt chunk after IHDR.',
  );

  // C11: encodings every decoder must read once stored.
  write(
    'palette-trns',
    'palette-trns.png',
    await sharp(validBytes).png({ palette: true, colours: 4 }).toBuffer(),
    valid,
    'accept',
    ['C11'],
    'Palette PNG with tRNS (sharp palette: true).',
  );
  write(
    'sixteen-bit',
    'sixteen-bit.png',
    await sharp(validBytes).toColourspace('rgb16').png().toBuffer(),
    valid,
    'accept',
    ['C11'],
    '16-bit RGBA.',
  );
  write(
    'interlaced',
    'interlaced.png',
    await sharp(validBytes).png({ progressive: true }).toBuffer(),
    valid,
    'accept',
    ['C11'],
    'Adam7 interlaced.',
  );
  write(
    'grey-alpha',
    'grey-alpha.png',
    await sharp(validBytes).toColourspace('b-w').png().toBuffer(),
    valid,
    'accept',
    ['C11'],
    'Greyscale with alpha.',
  );

  // C35: a 600 x 600 ring stamp on transparency.
  const ring = blank(600, 600);
  for (let y = 0; y < 600; y++) {
    for (let x = 0; x < 600; x++) {
      const r = Math.hypot(x - 299.5, y - 299.5);

      if (r >= 255 && r <= 295) {
        setPixel(ring, x, y, [20, 20, 120, 255]);
      }
    }
  }
  writePng('ring-600x600', ring, 'accept', ['C35', 'C36', 'C39', 'C50'], 'Dark blue ring, outer radius 295 px.');

  // C37: 1200 x 300 with ink touching all four edges.
  const wide = blank(1200, 300);
  for (let x = 0; x < 1200; x++) {
    for (const y of [0, 1, 298, 299]) {
      setPixel(wide, x, y, BLACK);
    }
  }
  for (let y = 0; y < 300; y++) {
    for (const x of [0, 1, 1198, 1199]) {
      setPixel(wide, x, y, BLACK);
    }
  }
  strokes(wide, 9000, BLACK, 37);
  writePng('wide-1200x300', wide, 'accept', ['C37', 'C39', 'C50'], 'Black frame on every edge plus strokes.');

  // C38: a photographed signature: opaque near-white paper, dark strokes in the middle, faint strokes at the edges.
  const photo = paper(1200, 500, 250, 2, 38);
  strokes(photo, 12000, [40, 40, 40, 255], 381, 150);
  // Faint strokes are 3 px thick so that resampling cannot average a 1 px line up past Y 230.
  for (let x = 30; x < 1170; x++) {
    for (let t = 0; t < 3; t++) {
      setPixel(photo, x, 3 + t, [205, 205, 205, 255]);
      setPixel(photo, x, 494 + t, [205, 205, 205, 255]);
    }
  }
  for (let y = 30; y < 470; y++) {
    for (let t = 0; t < 3; t++) {
      setPixel(photo, 3 + t, y, [205, 205, 205, 255]);
      setPixel(photo, 1194 + t, y, [205, 205, 205, 255]);
    }
  }
  writePng(
    'photo-faint-edges',
    photo,
    'accept',
    ['C38', 'C39', 'C50'],
    'Paper 250, strokes Y 40, faint Y 205 strokes 3 px thick, 3-5 px from each edge.',
  );

  // C52: pure white opaque, and white through JPEG quality 75 drawn back into a PNG.
  const white = paper(1000, 438, 255, 0, 52);
  writePng('white-opaque', white, 'refuse', ['C52', 'C50'], 'Opaque pure white.');

  const whiteJpeg = await sharp(PNG.sync.write(white)).jpeg({ quality: 75 }).toBuffer();
  const whiteThroughJpeg = PNG.sync.read(await sharp(whiteJpeg).ensureAlpha().png().toBuffer());
  writePng(
    'white-through-jpeg75',
    whiteThroughJpeg,
    'refuse',
    ['C52', 'C50'],
    'White, JPEG q75, back to PNG. Byte-identical to white-opaque: sharp decodes flat white JPEG to exactly 255.',
  );

  // C52, the upload pad's real path: the JPEG file itself, which the browser decodes and draws into the pad.
  write('white-q75-jpeg', 'white-q75.jpg', whiteJpeg, white, 'refuse', ['C52'], 'Opaque white as a JPEG file, q75.');

  // C53-C55: noisy paper.
  writePng('paper-noise', paper(1000, 438, 248, 4, 53), 'refuse', ['C53', 'C50'], 'Mean 248, sigma 4, no strokes.');

  const paper2 = paper(1000, 438, 248, 4, 54);
  strokes(paper2, 8760, [40, 40, 40, 255], 541);
  writePng('paper-noise-strokes-2pc', paper2, 'accept', ['C54', 'C50'], 'Paper 248/4 with Y 40 strokes over 2%.');

  const paperHalf = paper(1000, 438, 248, 4, 55);
  strokes(paperHalf, 2190, [40, 40, 40, 255], 551);
  writePng(
    'paper-noise-strokes-0p5pc',
    paperHalf,
    'refuse',
    ['C54', 'C50'],
    'Paper 248/4 with Y 40 strokes over 0.5%.',
  );

  const grey = paper(1000, 438, 200, 6, 56);
  strokes(grey, 8760, [40, 40, 40, 255], 561);
  writePng(
    'grey-paper-strokes-2pc',
    grey,
    'accept',
    ['C55', 'C50'],
    'Grey paper 200/6 with Y 40 strokes over 2%; passes on the paper.',
  );

  // C56: light strokes on transparency, 5%.
  const light240 = blank(1000, 438);
  strokes(light240, 21900, [240, 240, 240, 255], 571);
  writePng('light-strokes-y240', light240, 'refuse', ['C56', 'C50'], 'Y 240 strokes over 5% on transparency.');

  const light220 = blank(1000, 438);
  strokes(light220, 21900, [220, 220, 220, 255], 572);
  writePng('light-strokes-y220', light220, 'accept', ['C56', 'C50'], 'Y 220 strokes over 5% on transparency.');

  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`wrote ${Object.keys(manifest).length} fixtures to ${OUT}`);
};

void main();
