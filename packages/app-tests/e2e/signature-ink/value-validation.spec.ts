/**
 * Signature value validation on every route (G4 spec section 4.1).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the sign handlers. "Both routes" is section
 * 4.0's: field.signFieldWithToken on a V1 envelope and envelope.field.sign on a
 * V2 envelope, unauthenticated, with only the recipient token. DT is
 * template.createDocumentFromDirectTemplate, submitted as the direct-link page
 * does, against a V2 template (and a V1 template for C1, C7 and C17).
 *
 * Every refusal asserts section 4.0's bundle (400 INVALID_REQUEST, Signature
 * row and Field unchanged, no new field audit row) and then the control: the
 * same field signs with a valid typed value. A DT refusal asserts C16's
 * bundle instead: 400 INVALID_REQUEST, no Envelope, Recipient, Field or
 * Signature row for the team, no email to the direct signer or the owner, and a
 * valid submission on the same template afterwards answers 200. Accepted images
 * must be stored as the normalised PNG (section 3, rule 3), checked structurally
 * with pngjs, never byte for byte.
 *
 * Each test runs its cases one after another and collects every case that
 * breaks the criterion, so a red run lists all of them.
 *
 * | Criterion | Test                                                                                 |
 * | --------- | ------------------------------------------------------------------------------------ |
 * | C1        | C1 a fully transparent 1000 x 438 PNG is refused on both routes and on DT              |
 * | C2        | C2 0.9% ink is refused and 1.1% ink is accepted, on both routes                       |
 * | C3        | C3 the prefix with "not-an-image" bytes is refused (V1 isBase64 true and false, V2)   |
 * | C4        | C4 JPEG, SVG, GIF and WebP bytes under the PNG prefix are refused on both routes       |
 * | C5        | C5 whitespace-only and invisible SIGNATURE values on V2 are refused and never uninsert |
 * | C6        | C6 non-canonical encodings of a valid PNG are refused on both routes                  |
 * | C7        | C7 V1 and DT refuse a value whose kind disagrees with isBase64                       |
 * | C8        | C8 a PNG truncated inside IDAT is refused on both routes                              |
 * | C10       | C10 trailing bytes and a tEXt chunk are accepted and stripped from the stored value  |
 * | C16       | C16 a DT submission failing C1-C8 creates no rows and sends no email                  |
 * | C17       | C17 a 501-character typed signature is refused; 500 is accepted and seals            |
 * | C18       | C18 a valid PNG with leading whitespace is stored as the normalised image            |
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import { keepRecord, pause, type Reply } from '../fixtures/reject-seal';
import {
  auditValueOf,
  completeWithToken,
  createG4Owner,
  errorOf,
  expect2xx,
  expectCallRefused,
  expectMailCatcher,
  expectRefusedWith,
  expectSignatureAccepted,
  fieldAuditRowsOf,
  fieldState,
  type G4DirectTemplate,
  type G4Owner,
  type G4Seeded,
  imageDataUrl,
  imageManifest,
  normalisedPngProblems,
  P,
  QUIET_MS,
  readInbox,
  seedG4DirectTemplate,
  seedInserted,
  seedOneSigner,
  signSignature,
  signV1,
  signV2,
  submitDirectTemplate,
  teamRowCounts,
  uniqueStamp,
  validInkedDataUrl,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const VERSIONS = [1, 2] as const;

const CONTROL_NAME = 'Control Signer';

const routeName = (version: 1 | 2) => (version === 1 ? 'V1 field.signFieldWithToken' : 'V2 envelope.field.sign');

/**
 * The source's size, and the lossless fixture whose pixels the stored image must
 * reproduce (composited over white): `name` itself unless its pixels come from
 * another fixture (trailing-bytes and text-chunk are valid-inked's pixels).
 */
const dims = (name: string, pixelsOf = name) => {
  const entry = imageManifest()[name];

  return { width: entry.width, height: entry.height, fixture: pixelsOf };
};

// ---------------------------------------------------------------------------
// Collecting cases
// ---------------------------------------------------------------------------

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const stripAnsi = (text: string) => text.replace(ANSI, '');

const newCollector = () => {
  const failures: string[] = [];
  const records: Array<Record<string, unknown>> = [];

  return {
    records,
    /** Runs one case; an assertion it breaks is recorded rather than ending the test. */
    run: async (label: string, body: () => Promise<void>) => {
      try {
        await body();
        records.push({ case: label, verdict: 'ok' });
      } catch (error) {
        const message = stripAnsi(String((error as Error).message ?? error))
          .split('\n')
          .filter((line) => line.trim() !== '')
          .slice(0, 6)
          .join(' | ');

        failures.push(`${label}: ${message}`);
        records.push({ case: label, verdict: message });
      }
    },
    finish: async (name: string) => {
      await keepRecord(`${name}.json`, records);
      expect(failures, `${name}: cases that broke the criterion`).toEqual([]);
    },
  };
};

// ---------------------------------------------------------------------------
// Field-route bundles
// ---------------------------------------------------------------------------

type SendValue = (seeded: G4Seeded) => Promise<Reply>;

/** Refusal bundle on the envelope's signer field, then the valid-value control on the same field. */
const expectRefusedThenSignable = async (
  request: APIRequestContext,
  seeded: G4Seeded,
  sendValue: SendValue,
  label: string,
) => {
  const field = seeded.r.s1.fields.sig;
  const reply = await expectCallRefused(seeded, field, async () => await sendValue(seeded), label);

  expect(errorOf(reply).message, `${label}: the refusal names its reason`).not.toBe('');

  const control = await signSignature(request, seeded, seeded.r.s1.token, field.id, CONTROL_NAME);

  await expectSignatureAccepted(control, seeded, field, { typed: CONTROL_NAME }, `${label}: control sign afterwards`);
};

/** A fresh one-signer envelope of `version`, every method on, under `owner`. */
const freshEnvelope = async (version: 1 | 2, owner: G4Owner) => await seedOneSigner(version, { owner });

/** The value sent as an image claim: V1 with isBase64 true, V2 as the SIGNATURE value. */
const sendImage =
  (request: APIRequestContext, value: string): SendValue =>
  async (seeded) =>
    await signSignature(request, seeded, seeded.r.s1.token, seeded.r.s1.fields.sig.id, value, { isBase64: true });

// ---------------------------------------------------------------------------
// DT bundles
// ---------------------------------------------------------------------------

const mailboxOf = (email: string) => email.split('@')[0].toLowerCase();

/**
 * The mailbox's message count once nothing new has arrived for QUIET_MS (spec 4.0's quiet window). Owners are
 * shared between cases in one test, so mail from an earlier case's valid control must land before a refused
 * submission's "no email to the owner" check takes its baseline.
 */
const settledInboxCount = async (request: APIRequestContext, mailbox: string) => {
  let count = (await readInbox(request, mailbox)).length;

  for (let attempt = 0; attempt < 10; attempt++) {
    await pause(QUIET_MS);

    const next = (await readInbox(request, mailbox)).length;

    if (next === count) {
      return count;
    }

    count = next;
  }

  throw new Error(`premise: mailbox ${mailbox} did not settle`);
};

/** C16's refusal bundle on DT, then a valid submission on the same template answers 200. */
const expectDtRefused = async (
  request: APIRequestContext,
  template: G4DirectTemplate,
  signature: { value: string; isBase64: boolean },
  label: string,
) => {
  const signerMailbox = `g4dt-${uniqueStamp()}`;
  const ownerMailbox = mailboxOf(template.owner.user.email);
  const rowsBefore = await teamRowCounts(template.owner.team.id);
  const ownerMailBefore = await settledInboxCount(request, ownerMailbox);

  const reply = await submitDirectTemplate(request, template, signature, {
    email: `${signerMailbox}@test.documenso.com`,
  });

  const rowsAfter = await teamRowCounts(template.owner.team.id);

  expect(rowsAfter, `${label}: no Envelope, Recipient, Field or Signature row (reply ${reply.status})`).toEqual(
    rowsBefore,
  );
  expectRefusedWith(reply, 400, 'INVALID_REQUEST', label);

  await pause(QUIET_MS);

  expect(await readInbox(request, signerMailbox), `${label}: no email to the direct signer`).toHaveLength(0);
  expect((await readInbox(request, ownerMailbox)).length, `${label}: no email to the owner`).toBe(ownerMailBefore);

  const control = await submitDirectTemplate(request, template, { value: CONTROL_NAME, isBase64: false });

  expect2xx(control, `${label}: a valid submission on the same template afterwards`);
};

/** The document a DT submission created, read from its reply. */
const dtCreated = async (reply: Reply) => {
  const body = JSON.parse(reply.body) as { result?: { data?: { json?: { envelopeId?: string } } } };
  const envelopeId = body.result?.data?.json?.envelopeId;

  expect(envelopeId, `the DT reply names the envelope it created: ${reply.body.slice(0, 200)}`).toBeTruthy();

  const signatures = await prisma.signature.findMany({ where: { field: { envelopeId } } });
  const fields = await prisma.field.findMany({ where: { envelopeId, type: FieldType.SIGNATURE } });

  return { envelopeId: envelopeId as string, signatures, fields };
};

/** The DT document's insert audit row for its SIGNATURE field records exactly `stored`. */
const expectDtInsertAudit = async (created: Awaited<ReturnType<typeof dtCreated>>, stored: unknown, label: string) => {
  expect(created.fields, `${label}: one SIGNATURE field on the created document`).toHaveLength(1);

  const rows = await fieldAuditRowsOf(created.envelopeId, created.fields[0].secondaryId, ['DOCUMENT_FIELD_INSERTED']);

  expect(rows.length, `${label}: exactly one DOCUMENT_FIELD_INSERTED row`).toBe(1);
  expect(auditValueOf(rows[0]), `${label}: the audit row records the stored value`).toBe(stored);
};

const expectDtStoredImage = async (
  reply: Reply,
  source: { width: number; height: number; fixture?: string },
  label: string,
) => {
  expect2xx(reply, label);

  const created = await dtCreated(reply);

  expect(created.signatures, `${label}: one Signature row`).toHaveLength(1);
  expect(
    created.fields.every((field) => field.inserted),
    `${label}: the SIGNATURE field is inserted`,
  ).toBe(true);
  expect(created.signatures[0].typedSignature ?? null, `${label}: not stored as a typed signature`).toBeNull();
  expect(
    normalisedPngProblems(created.signatures[0].signatureImageAsBase64, source),
    `${label}: stored as the normalised PNG`,
  ).toEqual([]);
  await expectDtInsertAudit(created, created.signatures[0].signatureImageAsBase64, label);

  return created;
};

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test('C1 a fully transparent 1000 x 438 PNG is refused on both routes and on DT', async ({ request }) => {
  test.setTimeout(180_000);
  await expectMailCatcher(request);

  const entry = imageManifest()['transparent-1000x438'];

  expect(entry.coverage, 'premise: the fixture has no ink').toBe(0);
  expect([entry.width, entry.height], 'premise: the pad aspect 16:7').toEqual([1000, 438]);

  const owner = await createG4Owner();
  const cases = newCollector();
  const value = imageDataUrl('transparent-1000x438');

  for (const version of VERSIONS) {
    await cases.run(routeName(version), async () => {
      await expectRefusedThenSignable(request, await freshEnvelope(version, owner), sendImage(request, value), 'C1');
    });
  }

  for (const version of VERSIONS) {
    await cases.run(`DT V${version} template`, async () => {
      await expectDtRefused(
        request,
        await seedG4DirectTemplate(version, {}, owner),
        { value, isBase64: true },
        `C1 DT V${version}`,
      );
    });
  }

  await cases.finish('C1');
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test('C2 0.9% ink is refused and 1.1% ink is accepted, on both routes', async ({ request }) => {
  test.setTimeout(120_000);

  const manifest = imageManifest();

  expect(manifest['ink-0p9-1000x438'].coverage, 'premise: 0.9% ink').toBeCloseTo(0.009, 6);
  expect(manifest['ink-1p1-1000x438'].coverage, 'premise: 1.1% ink').toBeCloseTo(0.011, 6);

  const owner = await createG4Owner();
  const cases = newCollector();

  for (const version of VERSIONS) {
    await cases.run(`${routeName(version)} 0.9% refused`, async () => {
      await expectRefusedThenSignable(
        request,
        await freshEnvelope(version, owner),
        sendImage(request, imageDataUrl('ink-0p9-1000x438')),
        'C2 0.9%',
      );
    });

    await cases.run(`${routeName(version)} 1.1% accepted`, async () => {
      const seeded = await freshEnvelope(version, owner);
      const field = seeded.r.s1.fields.sig;
      const reply = await sendImage(request, imageDataUrl('ink-1p1-1000x438'))(seeded);

      await expectSignatureAccepted(reply, seeded, field, { image: dims('ink-1p1-1000x438') }, 'C2 1.1%');
    });
  }

  await cases.finish('C2');
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

const F02_VALUE = `${P}bm90LWFuLWltYWdl`;

test('C3 the prefix with "not-an-image" bytes is refused (V1 isBase64 true and false, V2)', async ({ request }) => {
  test.setTimeout(120_000);

  expect(Buffer.from(F02_VALUE.slice(P.length), 'base64').toString(), 'premise: the F02 payload').toBe('not-an-image');

  const owner = await createG4Owner();
  const cases = newCollector();

  for (const isBase64 of [true, false]) {
    await cases.run(`V1 isBase64 ${isBase64}`, async () => {
      await expectRefusedThenSignable(
        request,
        await freshEnvelope(1, owner),
        async (seeded) => await signV1(request, seeded.r.s1.token, seeded.r.s1.fields.sig.id, F02_VALUE, isBase64),
        `C3 V1 isBase64 ${isBase64}`,
      );
    });
  }

  await cases.run('V2', async () => {
    await expectRefusedThenSignable(
      request,
      await freshEnvelope(2, owner),
      async (seeded) =>
        await signV2(request, seeded.r.s1.token, seeded.r.s1.fields.sig.id, {
          type: FieldType.SIGNATURE,
          value: F02_VALUE,
        }),
      'C3 V2',
    );
  });

  await cases.finish('C3');
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

/** Section 2 of the spec: which consumer decodes each format under the PNG prefix today. */
const CONSUMERS_TODAY: Record<string, Record<string, string>> = {
  'jpeg-bytes': { skiaV2Seal: 'loads', pdfLibV1Seal: 'throws', chromiumImg: 'loads' },
  'svg-bytes': { skiaV2Seal: 'loads', pdfLibV1Seal: 'throws', chromiumImg: 'error' },
  'gif-bytes': { skiaV2Seal: 'loads', pdfLibV1Seal: 'throws', chromiumImg: 'loads' },
  'webp-bytes': { skiaV2Seal: 'loads', pdfLibV1Seal: 'throws', chromiumImg: 'loads' },
};

test('C4 JPEG, SVG, GIF and WebP bytes under the PNG prefix are refused on both routes', async ({ request }) => {
  test.setTimeout(180_000);

  await keepRecord('C4-consumers-from-spec-section-2.json', CONSUMERS_TODAY);

  const owner = await createG4Owner();
  const cases = newCollector();

  for (const name of Object.keys(CONSUMERS_TODAY)) {
    const value = imageDataUrl(name);

    expect(value.startsWith(P), `premise: ${name} is sent under the PNG prefix`).toBe(true);
    expect(
      Buffer.from(value.slice(P.length), 'base64')
        .subarray(0, 4)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      `premise: ${name} bytes are not PNG`,
    ).toBe(false);

    for (const version of VERSIONS) {
      await cases.run(`${name} ${routeName(version)}`, async () => {
        await expectRefusedThenSignable(
          request,
          await freshEnvelope(version, owner),
          sendImage(request, value),
          `C4 ${name}`,
        );
      });
    }
  }

  await cases.finish('C4');
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

const BLANK_VALUES: Record<string, string> = {
  'three spaces': '   ',
  'U+00A0': ' ',
  'U+3000': '　',
  'U+200B': '​',
  'U+FEFF': '﻿',
  'tab newline': '\t\n',
};

test('C5 whitespace-only and invisible SIGNATURE values on V2 are refused and never uninsert', async ({ request }) => {
  test.setTimeout(180_000);

  const owner = await createG4Owner();
  const cases = newCollector();

  for (const [name, value] of Object.entries(BLANK_VALUES)) {
    const sendBlank: SendValue = async (seeded) =>
      await signV2(request, seeded.r.s1.token, seeded.r.s1.fields.sig.id, { type: FieldType.SIGNATURE, value });

    await cases.run(`${name} on an uninserted field`, async () => {
      await expectRefusedThenSignable(request, await freshEnvelope(2, owner), sendBlank, `C5 ${name} uninserted`);
    });

    await cases.run(`${name} on a field inserted with "S Two"`, async () => {
      const seeded = await freshEnvelope(2, owner);
      const field = seeded.r.s1.fields.sig;

      await seedInserted(seeded, 's1', 'sig', { typed: 'S Two' });

      const before = await fieldState(field.id);

      expect(before.inserted && before.signature?.typed === 'S Two', 'premise: seeded inserted with "S Two"').toBe(
        true,
      );

      const auditBefore = (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length;
      const reply = await sendBlank(seeded);

      // The criterion asks for a 400 here, not a code: on an inserted field the
      // refusal may come from the value check or the one-insert check.
      expect(
        reply.status,
        `C5 ${name} inserted: refused with 400, got ${reply.status} ${reply.body.slice(0, 200)}`,
      ).toBe(400);
      expect(await fieldState(field.id), `C5 ${name} inserted: still "S Two" and inserted`).toEqual(before);
      expect(
        (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length,
        `C5 ${name} inserted: no field audit row`,
      ).toBe(auditBefore);
    });
  }

  await cases.finish('C5');
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

/** One case per section 2 row C6 lists, each a string transform of the valid inked data URL. */
const encodings = (valid: string) => {
  const payload = valid.slice(P.length);

  return {
    'newline inside the payload': `${P}${payload.slice(0, 10)}\n${payload.slice(10)}`,
    'space inside the payload': `${P}${payload.slice(0, 10)} ${payload.slice(10)}`,
    'URL-safe alphabet': `${P}${payload.replace(/\+/g, '-').replace(/\//g, '_')}`,
    'padding removed': `${P}${payload.replace(/=+$/, '')}`,
    'percent-encoded payload': `${P}${encodeURIComponent(payload)}`,
    'DATA: upper-case scheme': `DATA:image/png;base64,${payload}`,
    'extra ;charset=utf-8 parameter': `data:image/png;charset=utf-8;base64,${payload}`,
    'data:image/png, without ;base64': `data:image/png,${payload}`,
    'data:image/jpeg;base64, around PNG bytes': `data:image/jpeg;base64,${payload}`,
  };
};

/** Section 2: skia (V2 seal) / pdf-lib (V1 seal) / Chromium <img> today, for the record. */
const ENCODING_CONSUMERS: Record<string, string> = {
  'newline inside the payload': 'skia loads, pdf-lib throws, Chromium loads',
  'space inside the payload': 'skia loads, pdf-lib throws, Chromium loads',
  'URL-safe alphabet': 'skia loads, pdf-lib ok, Chromium error',
  'padding removed': 'skia loads, pdf-lib ok, Chromium loads',
  'percent-encoded payload': 'skia throws, pdf-lib throws, Chromium loads',
  'DATA: upper-case scheme': 'skia throws, pdf-lib ok, Chromium loads',
  'extra ;charset=utf-8 parameter': 'skia throws, pdf-lib ok, Chromium loads',
  'data:image/png, without ;base64': 'skia throws, pdf-lib ok, Chromium error',
  'data:image/jpeg;base64, around PNG bytes': 'skia loads, pdf-lib ok, Chromium loads',
};

test('C6 non-canonical encodings of a valid PNG are refused on both routes', async ({ request }) => {
  test.setTimeout(240_000);

  const valid = validInkedDataUrl();
  const cases = encodings(valid);
  const payload = valid.slice(P.length);

  expect(/[+/]/.test(payload), 'premise: the payload has + or / for the URL-safe case to change').toBe(true);
  expect(payload.endsWith('='), 'premise: the payload is padded for the padding case to change').toBe(true);

  for (const [name, value] of Object.entries(cases)) {
    expect(value, `premise: ${name} differs from the canonical value`).not.toBe(valid);
  }

  await keepRecord('C6-consumers-from-spec-section-2.json', ENCODING_CONSUMERS);

  const owner = await createG4Owner();
  const collector = newCollector();

  for (const [name, value] of Object.entries(cases)) {
    for (const version of VERSIONS) {
      await collector.run(`${name} ${routeName(version)}`, async () => {
        await expectRefusedThenSignable(
          request,
          await freshEnvelope(version, owner),
          sendImage(request, value),
          `C6 ${name}`,
        );
      });
    }
  }

  await collector.finish('C6');
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test('C7 V1 and DT refuse a value whose kind disagrees with isBase64', async ({ request }) => {
  test.setTimeout(180_000);
  await expectMailCatcher(request);

  const owner = await createG4Owner();
  const cases = newCollector();
  const mismatches = [
    { name: 'a valid PNG data URL with isBase64 false', value: validInkedDataUrl(), isBase64: false },
    { name: 'a typed name with isBase64 true', value: 'Typed Name', isBase64: true },
  ];

  for (const mismatch of mismatches) {
    await cases.run(`V1 ${mismatch.name}`, async () => {
      await expectRefusedThenSignable(
        request,
        await freshEnvelope(1, owner),
        async (seeded) =>
          await signV1(request, seeded.r.s1.token, seeded.r.s1.fields.sig.id, mismatch.value, mismatch.isBase64),
        `C7 V1 ${mismatch.name}`,
      );
    });

    for (const version of VERSIONS) {
      await cases.run(`DT V${version} template ${mismatch.name}`, async () => {
        await expectDtRefused(
          request,
          await seedG4DirectTemplate(version, {}, owner),
          { value: mismatch.value, isBase64: mismatch.isBase64 },
          `C7 DT V${version} ${mismatch.name}`,
        );
      });
    }
  }

  await cases.finish('C7');
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

test('C8 a PNG truncated inside IDAT is refused on both routes', async ({ request }) => {
  test.setTimeout(120_000);

  const bytes = Buffer.from(imageDataUrl('truncated-idat').slice(P.length), 'base64');

  expect(bytes.subarray(12, 16).toString('latin1'), 'premise: IHDR is intact').toBe('IHDR');
  expect(bytes.includes(Buffer.from('IDAT', 'latin1')), 'premise: an IDAT chunk starts').toBe(true);
  expect(bytes.includes(Buffer.from('IEND', 'latin1')), 'premise: no IEND').toBe(false);

  const owner = await createG4Owner();
  const cases = newCollector();

  for (const version of VERSIONS) {
    await cases.run(routeName(version), async () => {
      await expectRefusedThenSignable(
        request,
        await freshEnvelope(version, owner),
        sendImage(request, imageDataUrl('truncated-idat')),
        'C8',
      );
    });
  }

  await cases.finish('C8');
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test('C10 trailing bytes and a tEXt chunk are accepted and stripped from the stored value', async ({ request }) => {
  test.setTimeout(120_000);

  const owner = await createG4Owner();
  const cases = newCollector();

  for (const name of ['trailing-bytes', 'text-chunk']) {
    for (const version of VERSIONS) {
      await cases.run(`${name} ${routeName(version)}`, async () => {
        const seeded = await freshEnvelope(version, owner);
        const reply = await sendImage(request, imageDataUrl(name))(seeded);

        // expectSignatureAccepted checks for trailing bytes and text chunks in the stored value.
        await expectSignatureAccepted(
          reply,
          seeded,
          seeded.r.s1.fields.sig,
          { image: dims(name, 'valid-inked') },
          `C10 ${name}`,
        );
      });
    }
  }

  await cases.finish('C10');
});

// ---------------------------------------------------------------------------
// C16
// ---------------------------------------------------------------------------

test('C16 a DT submission failing C1-C8 creates no rows and sends no email', async ({ request }) => {
  test.setTimeout(240_000);
  await expectMailCatcher(request);

  const owner = await createG4Owner();
  const template = await seedG4DirectTemplate(2, {}, owner);
  const cases = newCollector();

  const submissions: Record<string, { value: string; isBase64: boolean }> = {
    'C1 fully transparent': { value: imageDataUrl('transparent-1000x438'), isBase64: true },
    'C2 0.9% ink': { value: imageDataUrl('ink-0p9-1000x438'), isBase64: true },
    'C3 not-an-image': { value: F02_VALUE, isBase64: true },
    'C4 JPEG under the PNG prefix': { value: imageDataUrl('jpeg-bytes'), isBase64: true },
    'C4 SVG under the PNG prefix': { value: imageDataUrl('svg-bytes'), isBase64: true },
    'C4 GIF under the PNG prefix': { value: imageDataUrl('gif-bytes'), isBase64: true },
    'C4 WebP under the PNG prefix': { value: imageDataUrl('webp-bytes'), isBase64: true },
    'C5 whitespace only': { value: '   ', isBase64: false },
    'C5 zero-width space': { value: '​', isBase64: false },
    'C6 newline inside the payload': {
      value: encodings(validInkedDataUrl())['newline inside the payload'],
      isBase64: true,
    },
    'C6 URL-safe alphabet': { value: encodings(validInkedDataUrl())['URL-safe alphabet'], isBase64: true },
    'C6 DATA: upper-case scheme': {
      value: encodings(validInkedDataUrl())['DATA: upper-case scheme'],
      isBase64: true,
    },
    'C8 truncated inside IDAT': { value: imageDataUrl('truncated-idat'), isBase64: true },
  };

  for (const [name, signature] of Object.entries(submissions)) {
    await cases.run(name, async () => {
      await expectDtRefused(request, template, signature, `C16 ${name}`);
    });
  }

  await cases.finish('C16');
});

// ---------------------------------------------------------------------------
// C17
// ---------------------------------------------------------------------------

const typedOfLength = (length: number) => 'Signature'.repeat(Math.ceil(length / 9)).slice(0, length);

const waitForEnvelopeStatus = async (envelopeId: string, status: DocumentStatus) => {
  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status, {
      message: `envelope ${envelopeId} should reach ${status}`,
      timeout: 90_000,
    })
    .toBe(status);
};

test('C17 a 501-character typed signature is refused; 500 is accepted and seals', async ({ request }) => {
  test.setTimeout(360_000);
  await expectMailCatcher(request);

  const long = typedOfLength(501);
  const fits = typedOfLength(500);

  expect([long.length, fits.length], 'premise: the lengths').toEqual([501, 500]);
  expect(fits.trim(), 'premise: no whitespace to trim').toBe(fits);

  const owner = await createG4Owner();
  const cases = newCollector();

  for (const version of VERSIONS) {
    await cases.run(`501 ${routeName(version)}`, async () => {
      await expectRefusedThenSignable(
        request,
        await freshEnvelope(version, owner),
        async (seeded) => await signSignature(request, seeded, seeded.r.s1.token, seeded.r.s1.fields.sig.id, long),
        'C17 501',
      );
    });

    await cases.run(`500 ${routeName(version)} accepted and sealed`, async () => {
      const seeded = await freshEnvelope(version, owner);
      const reply = await signSignature(request, seeded, seeded.r.s1.token, seeded.r.s1.fields.sig.id, fits);

      await expectSignatureAccepted(reply, seeded, seeded.r.s1.fields.sig, { typed: fits }, 'C17 500');
      expect2xx(await completeWithToken(request, seeded, seeded.r.s1.token), 'C17 500: completion');
      await waitForEnvelopeStatus(seeded.envelopeId, DocumentStatus.COMPLETED);
    });
  }

  for (const version of VERSIONS) {
    await cases.run(`501 DT V${version} template`, async () => {
      await expectDtRefused(
        request,
        await seedG4DirectTemplate(version, {}, owner),
        { value: long, isBase64: false },
        `C17 501 DT V${version}`,
      );
    });

    await cases.run(`500 DT V${version} template accepted and sealed`, async () => {
      const label = `C17 500 DT V${version}`;
      const reply = await submitDirectTemplate(request, await seedG4DirectTemplate(version, {}, owner), {
        value: fits,
        isBase64: false,
      });

      expect2xx(reply, label);

      const created = await dtCreated(reply);

      expect(created.signatures, `${label}: one Signature row`).toHaveLength(1);
      expect(created.signatures[0].typedSignature, `${label}: the typed signature`).toBe(fits);
      expect(created.signatures[0].signatureImageAsBase64 ?? null, `${label}: no image stored`).toBeNull();
      expect(
        created.fields.every((field) => field.inserted),
        `${label}: the SIGNATURE field is inserted`,
      ).toBe(true);
      await expectDtInsertAudit(created, fits, label);
      await waitForEnvelopeStatus(created.envelopeId, DocumentStatus.COMPLETED);
    });
  }

  await cases.finish('C17');
});

// ---------------------------------------------------------------------------
// C18
// ---------------------------------------------------------------------------

const LEADING: Record<string, string> = { 'a leading space': ' ', 'a leading U+00A0': ' ', 'a leading tab': '\t' };

test('C18 a valid PNG with leading whitespace is stored as the normalised image', async ({ request }) => {
  test.setTimeout(180_000);

  const owner = await createG4Owner();
  const cases = newCollector();
  const source = dims('valid-inked');

  for (const [name, prefix] of Object.entries(LEADING)) {
    const value = `${prefix}${validInkedDataUrl()}`;

    for (const version of VERSIONS) {
      await cases.run(`${name} ${routeName(version)}`, async () => {
        const seeded = await freshEnvelope(version, owner);
        const reply = await sendImage(request, value)(seeded);

        await expectSignatureAccepted(reply, seeded, seeded.r.s1.fields.sig, { image: source }, `C18 ${name}`);
      });
    }

    await cases.run(`${name} DT`, async () => {
      const reply = await submitDirectTemplate(request, await seedG4DirectTemplate(2, {}, owner), {
        value,
        isBase64: true,
      });

      await expectDtStoredImage(reply, source, `C18 ${name} DT`);
    });
  }

  await cases.finish('C18');
});
