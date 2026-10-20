/**
 * Real signing journeys that must keep working once signature values are
 * validated (G4): three recipients sign through the signing pages
 * by drawing, uploading and typing, and a company seal on V2 still applies.
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the sign routes or the pad. The browser
 * drives the V1 and V2 signing pages as a recipient following the emailed link
 * (no session); the sealed PDF is downloaded through API v2 with the owner's
 * token and rendered with pdftoppm.
 *
 * | Criterion | Test                                                                                |
 * | --------- | ----------------------------------------------------------------------------------- |
 * | C12       | C12 V1/V2: draw, upload and type through the signing pages; sealed PDF shows ink     |
 * | C15       | C15 a company seal on V2 stores the seal image and its audit data as today           |
 *
 * Expected today: both green (spec 4.8); they guard against the fix refusing
 * what the pad and the seal legitimately send.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prisma } from '@documenso/prisma';
import { type Browser, expect, type Page } from '@playwright/test';
import { DocumentSigningOrder, DocumentStatus, FieldType, SigningStatus } from '@prisma/client';
import { PNG } from 'pngjs';
import {
  applySeal,
  completeWithToken as completeSealWithToken,
  readSealField,
  SEAL_FIELD_TYPE,
  test as sealTest,
  setupMemberSeal,
  sha256Hex,
  signSignatureField,
  snapshotOf,
  waitForEnvelopeStatus,
} from '../fixtures/company-seals';
import { keepRecord } from '../fixtures/reject-seal';
import { API_V2, type G4Seeded, imageBytes, seedG4Envelope } from '../fixtures/signature-ink';

const test = sealTest;

test.describe.configure({ mode: 'default' });

type Method = 'draw' | 'upload' | 'type';

const METHODS: Method[] = ['draw', 'upload', 'type'];

/** Blank areas of the example PDF's page 1 (checked on the original below), one per signer. */
const BOXES = [
  { positionX: 38, positionY: 57, width: 24, height: 8 },
  { positionX: 38, positionY: 70, width: 24, height: 8 },
  { positionX: 38, positionY: 83, width: 24, height: 8 },
];

const UPLOAD_FIXTURE = 'ring-600x600';

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const seedThreeSigners = async (internalVersion: 1 | 2) => {
  const seeded = await seedG4Envelope({
    internalVersion,
    signingOrder: DocumentSigningOrder.PARALLEL,
    recipients: METHODS.map((method, index) => ({
      key: method,
      signingOrder: index + 1,
      fields: [{ key: 'sig', type: FieldType.SIGNATURE }],
    })),
  });

  for (const [index, method] of METHODS.entries()) {
    await prisma.field.update({ where: { id: seeded.r[method].fields.sig.id }, data: BOXES[index] });
  }

  return seeded;
};

// ---------------------------------------------------------------------------
// The pad
// ---------------------------------------------------------------------------

const drawStrokes = async (page: Page) => {
  const canvas = page.getByRole('dialog').getByTestId('signature-pad-draw');

  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The draw pad has no bounding box');
  }

  for (const fraction of [0.3, 0.5, 0.7]) {
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * fraction);
    await page.mouse.down();

    for (let step = 0; step <= 24; step++) {
      await page.mouse.move(
        box.x + box.width * (0.1 + (0.8 * step) / 24),
        box.y + box.height * fraction + (step % 2 === 0 ? -10 : 10),
      );
    }

    await page.mouse.up();
  }
};

/** Puts a signature into the open dialog by the given method. */
const fillDialog = async (page: Page, method: Method) => {
  const dialog = page.getByRole('dialog');

  if (method === 'draw') {
    await dialog.getByRole('tab', { name: 'Draw' }).click();
    await drawStrokes(page);
  } else if (method === 'upload') {
    await dialog.getByRole('tab', { name: 'Upload' }).click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'signature.png',
      mimeType: 'image/png',
      buffer: imageBytes(UPLOAD_FIXTURE),
    });
    await page.waitForTimeout(500);
  } else {
    await dialog.getByRole('tab', { name: 'Type' }).click();
    await dialog.getByTestId('signature-pad-type-input').fill('Typed Signer');
  }
};

// ---------------------------------------------------------------------------
// The signing pages
// ---------------------------------------------------------------------------

const clickV2Field = async (
  page: Page,
  field: { positionX: number; positionY: number; width: number; height: number },
) => {
  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  await canvas.click({
    position: {
      x: ((field.positionX + field.width / 2) / 100) * box.width,
      y: ((field.positionY + field.height / 2) / 100) * box.height,
    },
  });
};

const signOnPage = async (browser: Browser, seeded: G4Seeded, method: Method, index: number) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
  const page = await context.newPage();
  const recipient = seeded.r[method];
  const fieldId = recipient.fields.sig.id;
  const signUrl = `/sign/${recipient.token}`;

  await page.goto(signUrl);

  if (seeded.internalVersion === 1) {
    await expect(page.getByRole('heading', { name: 'Sign Document' })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('signature-pad-dialog-button').click();
    await fillDialog(page, method);

    const next = page.getByRole('dialog').getByRole('button', { name: 'Next' });

    await expect(next, `V1 ${method}: the pad accepts the ${method} signature`).toBeEnabled();
    await next.click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.locator(`#field-${fieldId}`).getByRole('button').click();
    await expect(page.locator(`#field-${fieldId}`)).toHaveAttribute('data-inserted', 'true', { timeout: 15_000 });
  } else {
    await clickV2Field(page, BOXES[index]);

    const dialog = page.getByRole('dialog');

    await expect(dialog, `V2 ${method}: clicking the field opens the signature dialog`).toBeVisible();
    await fillDialog(page, method);

    const sign = dialog.getByRole('button', { name: 'Sign', exact: true });

    await expect(sign, `V2 ${method}: the dialog accepts the ${method} signature`).toBeEnabled();
    await sign.click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: fieldId } })).inserted, {
        message: `V2 ${method}: the field is inserted`,
        timeout: 15_000,
      })
      .toBe(true);
  }

  await page.getByRole('button', { name: 'Complete' }).first().click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();

  await expect
    .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus, {
      message: `V${seeded.internalVersion} ${method}: the recipient completes`,
      timeout: 30_000,
    })
    .toBe(SigningStatus.SIGNED);

  await page.screenshot({ path: test.info().outputPath(`C12-v${seeded.internalVersion}-${method}.png`) });
  await context.close();
};

// ---------------------------------------------------------------------------
// Rendering the sealed PDF
// ---------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-journeys-'));

/** Non-white share of each box on page 1, rendered at 72 dpi. Non-white: any channel below 245. */
const inkShares = (pdf: Buffer, name: string) => {
  const file = path.join(workDir, `${name}.pdf`);
  const prefix = path.join(workDir, name);

  fs.writeFileSync(file, pdf);
  execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-png', '-singlefile', file, prefix], { stdio: 'pipe' });

  const png = PNG.sync.read(fs.readFileSync(`${prefix}.png`));

  return BOXES.map((box) => {
    const x0 = Math.round((box.positionX / 100) * png.width);
    const y0 = Math.round((box.positionY / 100) * png.height);
    const w = Math.round((box.width / 100) * png.width);
    const h = Math.round((box.height / 100) * png.height);
    let dark = 0;

    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * png.width + x) * 4;

        if (Math.min(png.data[i], png.data[i + 1], png.data[i + 2]) < 245) {
          dark++;
        }
      }
    }

    return dark / (w * h);
  });
};

const download = async (
  request: import('@playwright/test').APIRequestContext,
  seeded: G4Seeded,
  version: 'original' | 'signed',
) => {
  const res = await request.get(`${API_V2}/envelope/item/${seeded.itemId}/download?version=${version}`, {
    headers: { Authorization: `Bearer ${seeded.owner.apiToken}` },
  });

  expect(res.status(), `download ?version=${version}`).toBe(200);

  return Buffer.from(await res.body());
};

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

for (const version of [1, 2] as const) {
  test(`C12 V${version}: three recipients draw, upload and type through the signing pages; the sealed PDF shows each`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);

    const seeded = await seedThreeSigners(version);

    const original = inkShares(await download(request, seeded, 'original'), `v${version}-original`);

    for (const [index, share] of original.entries()) {
      expect(share, `premise: box ${index} is blank on the original page`).toBeLessThan(0.01);
    }

    for (const [index, method] of METHODS.entries()) {
      await signOnPage(browser, seeded, method, index);
    }

    const stored = await Promise.all(
      METHODS.map(async (method) => {
        const row = await prisma.signature.findUnique({ where: { fieldId: seeded.r[method].fields.sig.id } });

        return { method, image: Boolean(row?.signatureImageAsBase64), typed: row?.typedSignature ?? null };
      }),
    );

    expect(
      stored.find((row) => row.method === 'draw')?.image,
      'premise: the drawn signature is stored as an image',
    ).toBe(true);
    expect(stored.find((row) => row.method === 'upload')?.image, 'premise: the upload is stored as an image').toBe(
      true,
    );
    expect(stored.find((row) => row.method === 'type')?.typed, 'premise: the typed name is stored as text').toBe(
      'Typed Signer',
    );

    await expect
      .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } })).status, {
        message: 'the envelope reaches COMPLETED',
        timeout: 90_000,
      })
      .toBe(DocumentStatus.COMPLETED);

    const sealed = await download(request, seeded, 'signed');

    fs.writeFileSync(test.info().outputPath(`C12-v${version}-sealed.pdf`), sealed);

    const shares = inkShares(sealed, `v${version}-sealed`);

    await keepRecord(`C12-v${version}.json`, { envelopeId: seeded.envelopeId, stored, original, sealed: shares });

    for (const [index, method] of METHODS.entries()) {
      expect
        .soft(shares[index], `V${version} ${method}: at least 1% non-white pixels in the field`)
        .toBeGreaterThanOrEqual(0.01);
    }
  });
}

// ---------------------------------------------------------------------------
// C15
// ---------------------------------------------------------------------------

type SealAuditData = {
  fieldId: string;
  field: { type: string; data: { sealId: string; sealName: string; legalEntityName: string; imageSha256: string } };
};

test('C15 a company seal on V2 stores the seal image and its audit data, and the envelope completes', async ({
  signIn,
  request,
}) => {
  test.setTimeout(180_000);

  const { world, seal, built, person } = await setupMemberSeal(signIn, request);
  const member = await signIn(world.member.email);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: built.envelopeId } });

  expect(envelope.internalVersion, 'premise: the seal envelope is V2').toBe(2);
  expect(person.sealFieldId, 'premise: the member has a seal field').toBeDefined();

  const signed = await signSignatureField(member.request, person.token, person.signatureFieldId as number);

  expect(signed.ok, `the signature field signs: ${signed.status} ${signed.text.slice(0, 200)}`).toBe(true);

  const applied = await applySeal(member.request, person.token, person.sealFieldId as number);

  expect(applied.ok, `the seal applies: ${applied.status} ${applied.text.slice(0, 300)}`).toBe(true);

  const { field, signature } = await readSealField(person.sealFieldId as number);
  const snapshot = snapshotOf(signature);

  expect(field.inserted, 'the seal field is inserted').toBe(true);
  expect(snapshot, 'the Signature row holds the seal PNG').toBeTruthy();
  expect(sha256Hex(snapshot as Buffer), 'the stored image is the seal image').toBe(seal.imageSha256);

  const rows = await prisma.documentAuditLog.findMany({
    where: { envelopeId: built.envelopeId, type: 'DOCUMENT_FIELD_INSERTED' },
  });
  const sealRow = rows.find((row) => (row.data as unknown as SealAuditData).field?.type === SEAL_FIELD_TYPE);

  expect(sealRow, 'the seal application is audited').toBeTruthy();
  expect((sealRow?.data as unknown as SealAuditData).field.data).toEqual({
    sealId: seal.id,
    sealName: seal.name,
    legalEntityName: seal.legalEntityName,
    imageSha256: seal.imageSha256,
  });

  const completed = await completeSealWithToken(member.request, person.token, built.documentId);

  expect(completed.ok, `completion: ${completed.status} ${completed.text.slice(0, 200)}`).toBe(true);

  await waitForEnvelopeStatus(built.envelopeId, 'COMPLETED', 90_000);

  await keepRecord('C15-seal.json', { envelopeId: built.envelopeId, sealId: seal.id, auditRowId: sealRow?.id });
});
