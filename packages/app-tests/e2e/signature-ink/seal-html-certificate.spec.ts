/**
 * The HTML certificate draws each signature from the prepared image (G4 spec, "Round after Codex r1", C102).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md) before any fix,
 * without reading the seal handler or the certificate route. With NEXT_PRIVATE_USE_PLAYWRIGHT_PDF=true the seal
 * prints the signing certificate through the HTML certificate route in Chromium instead of pdf-lib. That is a
 * server environment variable, so this file runs against its own server instance started with it, as
 * seal-certificate-audit.spec.ts is run once against each renderer. The runner says so by setting
 * E2E_SERVER_USES_PLAYWRIGHT_PDF=true and pointing NEXT_PUBLIC_WEBAPP_URL at that instance; without the first the
 * file skips with that reason rather than measuring the pdf-lib path.
 *
 * | Criterion | Test                                                                                       |
 * | --------- | ------------------------------------------------------------------------------------------ |
 * | C102      | C102 control: a stored valid PNG appears as an inked raster in the HTML certificate         |
 * | C102      | C102 the C100 value (sharp reads it, embedPng refuses it) renders as ink in the certificate |
 * | C102      | C102 an SVG declared 8000 x 3500 renders in the certificate as a raster within 4096 px      |
 * | C102      | C102 an unreadable stored value stops the seal with one DOCUMENT_SIGNATURE_IMAGE_UNRENDERABLE |
 *
 * Each envelope is seeded through Prisma (s1 SIGNED with the stored Signature row under test, s2 with a typed
 * signature) and s2 completes through the recipient route, which queues the seal job. The certificate pages are
 * the sealed PDF's pages after the example document's own; their raster images are listed and extracted with
 * pdfimages, and ink is the spec's D1 rule with each image's soft mask as alpha. s2's typed signature is text, so
 * the only signature raster on the certificate is s1's, found by its ink and its 16:7 aspect ratio; the
 * certificate's grey page backgrounds and Chromium's broken-image icon (seen for a value it cannot draw) are not
 * counted. The PDF producer is recorded: Skia on V2; on V1 pdf-lib rewrites the whole file after the merge.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { JOB, jobsFor, keepRecord, pause } from '../fixtures/reject-seal';
import {
  API_V2,
  completeWithToken,
  decodePng,
  expect2xx,
  type G4Seeded,
  isInkPixel,
  P,
  seedG4Envelope,
  validInkedDataUrl,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const EXAMPLE_PDF = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));
const BOUND = 4096;
const QUIET_MS = 8_000;
const UNRENDERABLE = 'DOCUMENT_SIGNATURE_IMAGE_UNRENDERABLE';

/** F02: the PNG prefix around the text "not-an-image". */
const F02_JUNK = `${P}bm90LWFuLWltYWdl`;

/** The C100 value: the inked fixture with one space 8 characters into its payload. */
const C100_VALUE = () => {
  const payload = validInkedDataUrl().slice(P.length);

  return `${P}${payload.slice(0, 8)} ${payload.slice(8)}`;
};

/** A thick black stroke on an 80 x 35 view box, declared 8000 x 3500, so a raster of it exceeds the bound. */
const SVG_OVER_BOUND = `${P}${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="3500" viewBox="0 0 80 35">' +
    '<path d="M5 28 C 20 2, 40 2, 75 28" stroke="black" stroke-width="5" fill="none"/></svg>',
).toString('base64')}`;

type Seeded = G4Seeded & { since: Date };

/** Envelopes the running test seeded; the ones a stopped seal leaves PENDING are deleted after it (#177). */
const seededByTest: string[] = [];

const seedStored = async (internalVersion: 1 | 2, stored: string): Promise<Seeded> => {
  const seeded = await seedG4Envelope({
    internalVersion,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        signingStatus: SigningStatus.SIGNED,
        fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: true }],
      },
      { key: 's2', signingOrder: 2, fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: true }] },
    ],
  });

  seededByTest.push(seeded.envelopeId);

  await prisma.signature.create({
    data: { fieldId: seeded.r.s1.fields.sig.id, recipientId: seeded.r.s1.id, signatureImageAsBase64: stored },
  });
  await prisma.signature.create({
    data: { fieldId: seeded.r.s2.fields.sig.id, recipientId: seeded.r.s2.id, typedSignature: 'G4 s2' },
  });

  const settings = await prisma.organisationGlobalSettings.findUniqueOrThrow({
    where: { id: seeded.owner.organisation.organisationGlobalSettingsId },
  });

  expect(settings.includeSigningCertificate, 'premise: the organisation prints the signing certificate').toBe(true);

  return { ...seeded, since: new Date() };
};

// A stopped seal leaves the envelope PENDING with s2's recent signedAt, which the seal sweep would retry.
test.afterEach(async () => {
  await prisma.envelope.updateMany({
    where: { id: { in: seededByTest.splice(0) }, status: DocumentStatus.PENDING },
    data: { deletedAt: new Date() },
  });
});

const sealAndSettle = async (request: APIRequestContext, seeded: Seeded) => {
  expect2xx(await completeWithToken(request, seeded, seeded.r.s2.token), "premise: s2's completion is accepted");

  await expect
    .poll(
      async () => {
        const jobs = await jobsFor(JOB.SEAL, 'documentId', seeded.documentId);

        return jobs.length >= 1 && jobs.every((job) => job.status === 'COMPLETED' || job.status === 'FAILED');
      },
      { message: `the seal job of ${seeded.envelopeId} should settle`, timeout: 180_000 },
    )
    .toBe(true);

  await pause(QUIET_MS);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });
  const jobs = await jobsFor(JOB.SEAL, 'documentId', seeded.documentId);
  const unrenderable = await prisma.documentAuditLog.findMany({
    where: { envelopeId: seeded.envelopeId, type: UNRENDERABLE, createdAt: { gte: seeded.since } },
  });

  return { status: envelope.status, retried: jobs.map((job) => job.retried), unrenderable };
};

const download = async (request: APIRequestContext, seeded: G4Seeded) => {
  const res = await request.get(`${API_V2}/envelope/item/${seeded.itemId}/download?version=signed`, {
    headers: { Authorization: `Bearer ${seeded.owner.apiToken}` },
  });

  expect(res.status(), 'download ?version=signed').toBe(200);

  return await res.body();
};

const pageCount = (file: string) => {
  const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout;
  const pages = /Pages:\s+(\d+)/.exec(info);

  if (!pages) {
    throw new Error(`pdfinfo gave no page count: ${info}`);
  }

  return Number(pages[1]);
};

/** The raster images on the sealed PDF's certificate pages, each with its size and D1 ink coverage. */
const certificateRasters = (sealed: Buffer) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-c102-'));
  const examplePath = path.join(dir, 'example.pdf');
  const sealedPath = path.join(dir, 'sealed.pdf');

  fs.writeFileSync(examplePath, EXAMPLE_PDF);
  fs.writeFileSync(sealedPath, sealed);
  // Kept beside the test's records, so a failure can be inspected with pdfimages and pdftoppm.
  fs.writeFileSync(test.info().outputPath('sealed.pdf'), sealed);

  const firstCertificatePage = pageCount(examplePath) + 1;
  const lastPage = pageCount(sealedPath);

  if (lastPage < firstCertificatePage) {
    fs.rmSync(dir, { recursive: true });

    return { pages: lastPage, firstCertificatePage, producer: '', rasters: [], list: [] };
  }

  const range = ['-f', String(firstCertificatePage), '-l', String(lastPage)];
  const list = spawnSync('pdfimages', ['-list', ...range, sealedPath], { encoding: 'utf8' }).stdout;
  // pdfimages -list columns: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio.
  const listed = list
    .split('\n')
    .slice(2)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length > 4)
    .map((cols) => ({
      page: Number(cols[0]),
      num: Number(cols[1]),
      type: cols[2],
      width: Number(cols[3]),
      height: Number(cols[4]),
      enc: cols[8],
    }));

  const prefix = path.join(dir, 'img');

  spawnSync('pdfimages', ['-png', '-p', ...range, sealedPath, prefix]);

  const files = fs.readdirSync(dir).filter((name) => name.startsWith('img') && name.endsWith('.png'));
  const read = (num: number) => {
    const file = files.find((name) => name.endsWith(`-${String(num).padStart(3, '0')}.png`));

    try {
      return file ? decodePng(fs.readFileSync(path.join(dir, file))) : null;
    } catch {
      return null;
    }
  };
  const rasters = listed
    .filter((entry) => entry.type === 'image')
    .map((entry) => {
      const mask = listed.find(
        (other) => other.type === 'smask' && other.page === entry.page && other.num === entry.num + 1,
      );
      const image = read(entry.num);
      const alpha = mask ? read(mask.num) : null;
      let coverage: number | null = null;

      if (image) {
        let ink = 0;

        for (let i = 0; i < image.width * image.height; i++) {
          const a = alpha && alpha.width === image.width && alpha.height === image.height ? alpha.data[i * 4] : 255;

          ink += isInkPixel(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2], a) ? 1 : 0;
        }

        coverage = ink / (image.width * image.height);
      }

      return { ...entry, hasAlpha: Boolean(mask), coverage };
    });
  const producer = /Producer:\s+(.*)/.exec(spawnSync('pdfinfo', [sealedPath], { encoding: 'utf8' }).stdout)?.[1] ?? '';

  fs.rmSync(dir, { recursive: true });

  return { pages: lastPage, firstCertificatePage, producer, rasters, list: list.split('\n').filter(Boolean) };
};

type Certificate = ReturnType<typeof certificateRasters>;

/**
 * The certificate's rasters that can be s1's signature: a PNG-encoded image (the certificate's own page graphics
 * are grey JPEGs, one of them near 16:7), inked by D1 with its soft mask as alpha, with the stored image's aspect
 * ratio within 5%. Chromium's broken-image icon for a value it cannot draw does not have that aspect, so a
 * signature that did not render leaves none.
 */
const signatureRasters = (certificate: Certificate | null, aspect: number) =>
  (certificate?.rasters ?? []).filter(
    (raster) =>
      raster.enc !== 'jpeg' &&
      (raster.coverage ?? 0) > 0.01 &&
      Math.abs(raster.width / raster.height / aspect - 1) <= 0.05,
  );

/** Aspect ratio of the fixture image and of the SVG's declared size: both 400 x 175 and 8000 x 3500 are 16:7. */
const SIGNATURE_ASPECT = 400 / 175;

// Skipped, with the reason, rather than failed, where the runner starts no such server (CI's e2e job).
test.skip(
  process.env.E2E_SERVER_USES_PLAYWRIGHT_PDF !== 'true',
  'premise: this file runs against a server started with NEXT_PRIVATE_USE_PLAYWRIGHT_PDF=true; the runner sets ' +
    `E2E_SERVER_USES_PLAYWRIGHT_PDF=true and NEXT_PUBLIC_WEBAPP_URL to that instance; it is ${JSON.stringify(process.env.E2E_SERVER_USES_PLAYWRIGHT_PDF ?? null)}.`,
);

for (const version of [1, 2] as const) {
  test(`C102 V${version} control: a stored valid PNG appears as an inked raster in the HTML certificate`, async ({
    request,
  }) => {
    test.setTimeout(300_000);

    const seeded = await seedStored(version, validInkedDataUrl());
    const sealed = await sealAndSettle(request, seeded);

    expect(sealed.status, `premise V${version}: the control envelope seals`).toBe(DocumentStatus.COMPLETED);

    const certificate = certificateRasters(await download(request, seeded));

    await keepRecord(`C102-v${version}-control.json`, { ...sealed, certificate });

    expect(certificate.pages, 'premise: the sealed PDF has certificate pages').toBeGreaterThanOrEqual(
      certificate.firstCertificatePage,
    );
    expect(
      signatureRasters(certificate, SIGNATURE_ASPECT).length,
      "premise: s1's signature is an inked raster on the certificate (the measurement can see it)",
    ).toBeGreaterThanOrEqual(1);
  });

  test(`C102 V${version}: the C100 value renders as ink in the HTML certificate`, async ({ request }) => {
    test.setTimeout(300_000);

    const seeded = await seedStored(version, C100_VALUE());
    const sealed = await sealAndSettle(request, seeded);
    const certificate =
      sealed.status === DocumentStatus.COMPLETED ? certificateRasters(await download(request, seeded)) : null;

    await keepRecord(`C102-v${version}-c100.json`, { ...sealed, certificate });

    expect.soft(sealed.status, `V${version}: the envelope seals (COMPLETED)`).toBe(DocumentStatus.COMPLETED);
    expect.soft(sealed.retried, `V${version}: one seal job, not retried`).toEqual([0]);
    expect.soft(sealed.unrenderable, `V${version}: no ${UNRENDERABLE} entry`).toEqual([]);
    expect
      .soft(
        signatureRasters(certificate, SIGNATURE_ASPECT).length,
        `V${version}: s1's signature is drawn as ink in the certificate`,
      )
      .toBeGreaterThanOrEqual(1);
  });

  test(`C102 V${version}: an SVG declared 8000 x 3500 renders in the HTML certificate as a raster within ${BOUND} px`, async ({
    request,
  }) => {
    test.setTimeout(300_000);

    const seeded = await seedStored(version, SVG_OVER_BOUND);
    const sealed = await sealAndSettle(request, seeded);
    const certificate =
      sealed.status === DocumentStatus.COMPLETED ? certificateRasters(await download(request, seeded)) : null;
    const inked = signatureRasters(certificate, SIGNATURE_ASPECT);

    await keepRecord(`C102-v${version}-svg.json`, { ...sealed, certificate });

    expect.soft(sealed.status, `V${version}: the envelope seals (COMPLETED)`).toBe(DocumentStatus.COMPLETED);
    expect.soft(sealed.retried, `V${version}: one seal job, not retried`).toEqual([0]);
    expect
      .soft(inked.length, `V${version}: the signature is in the certificate as the prepared raster, with ink`)
      .toBeGreaterThanOrEqual(1);

    for (const raster of inked) {
      expect
        .soft(
          Math.max(raster.width, raster.height),
          `V${version}: certificate image ${raster.num} (${raster.width} x ${raster.height}) is within ${BOUND} px`,
        )
        .toBeLessThanOrEqual(BOUND);
    }
  });

  test(`C102 V${version}: an unreadable stored value stops the seal with one ${UNRENDERABLE} entry`, async ({
    request,
  }) => {
    test.setTimeout(300_000);

    const seeded = await seedStored(version, F02_JUNK);
    const sealed = await sealAndSettle(request, seeded);
    const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: seeded.itemId } });
    const stored = await prisma.signature.findFirstOrThrow({ where: { fieldId: seeded.r.s1.fields.sig.id } });

    await keepRecord(`C102-v${version}-unreadable.json`, { ...sealed, documentDataId: item.documentDataId });

    expect.soft(sealed.status, `V${version}: the envelope stays PENDING`).toBe(DocumentStatus.PENDING);
    expect.soft(sealed.retried, `V${version}: one seal job, not retried`).toEqual([0]);
    expect.soft(sealed.unrenderable.length, `V${version}: exactly one ${UNRENDERABLE} entry`).toBe(1);
    expect
      .soft(
        JSON.stringify(sealed.unrenderable[0]?.data ?? {}).includes(seeded.r.s1.fields.sig.secondaryId) ||
          new RegExp(`"fieldId":\\s*${seeded.r.s1.fields.sig.id}\\b`).test(
            JSON.stringify(sealed.unrenderable[0]?.data ?? {}),
          ),
        `V${version}: the entry names s1's field`,
      )
      .toBe(true);
    expect.soft(stored.signatureImageAsBase64, `V${version}: the stored row is unchanged`).toBe(F02_JUNK);
  });
}
