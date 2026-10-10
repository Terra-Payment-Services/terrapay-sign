/**
 * The two-step upload URL must not reach a sent document's PDF.
 *
 * Written from the specification alone, without reading the send
 * implementation. Criterion 10 (documents made from a two-step template) is
 * not in scope here; it is a separate issue.
 *
 * API v1 `createDocument` returns a presigned PUT URL for the object that holds
 * the document's PDF. For the hour the signature is valid anyone holding the
 * URL could replace a document after it was sent. The fix has the send copy the
 * checked bytes to a key that was never presigned, repoint the existing
 * DocumentData row at it, and delete the uploaded object.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | after send neither column names the upload key, row id kept,      | 1        | F1, F2, F6    |
 * |   no row names the old key                                        |          |               |
 * | concurrent sends of one DRAFT: one stored copy, row names it,     | 1, 8     | F6            |
 * |   no unattached row                                               |          |               |
 * | stored bytes equal the uploaded bytes (data and initialData)      | 2        | F4            |
 * | late PUT: recipient is served the original, current and initial   | 3        | F1, F2        |
 * | late PUT: recipient signs, sealed PDF derives from the original   | 3        | F1, F2        |
 * | control: no late PUT, the same flow seals (page count reference)  | 3, F8    | F8            |
 * | refused upload, per kind [x4]: refused as today, no mail, DRAFT,  | 4        | F5            |
 * |   row unchanged, no new object or row                             |          |               |
 * | refused, then a second PUT and send succeeds with the second     | 5        | F5            |
 * | two PUTs before the send: the send stores the second              | 6        | F3            |
 * | formValues: prefilled, late PUT no effect, one row, key unnamed   | 7        | F7            |
 * | no orphans, plain send                                            | 8        | F6            |
 * | no orphans, after a late PUT                                      | 8        | F6            |
 * | no orphans, formValues send                                       | 8        | F6, F7        |
 * | tRPC /document/create/beta then distribute: as criterion 1        | 9        | F1, F2        |
 * | tRPC /document/create/beta then distribute: as criterion 3        | 9        | F1, F2        |
 * | control: tRPC beta create, distribute, repeat, redistribute work  | F8       | F8            |
 *
 * Criteria 4, 5 and 6 and the controls describe behaviour that must not
 * change, so they pass before and after the change; the others fail until the
 * send repoints the row.
 *
 * Measurements, all from outside the code under test:
 * - the key the upload URL writes is parsed from the URL itself, and checked
 *   against `documentData.data` before the send;
 * - the uploaded object is not deleted at send (a later cleanup collects it), so what is
 *   asserted about the old key is that no DocumentData row names it;
 * - objects are read from MinIO with the server's own credentials;
 * - "the PDF the recipient sees" is what the token PDF route serves for
 *   `current` and for `initial`, compared by sha256;
 * - "no orphan" is the count of DocumentData rows minted for the test's team
 *   that no envelope item points at, plus a search of the bucket for objects
 *   holding the document's unique marker bytes;
 * - the sealed PDF is read with pdfinfo and pdftotext.
 *
 * Two-step creation exists only under the S3 upload transport, so the whole
 * spec skips with that reason unless NEXT_PUBLIC_UPLOAD_TRANSPORT is "s3".
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  assertVerifierToolsPresent,
  buildFreshOpenPasswordPdf,
  buildFreshOwnerOnlyPdf,
  buildSignedThenTamperedPdf,
  FORM_FIELDS_PDF,
  FORM_VALUES,
  readEncryptionWithPdfinfo,
  readInfoWithPdfinfo,
  readPageTextWithPdftotext,
  SIGNATURE_ALREADY_INVALID,
  signV1AsRecipientInBrowser,
} from '../../fixtures/protected-pdfs';
import {
  addressFor,
  assertMailCatcherReachable,
  expectNoNewMail,
  expectSameRefusalAsDraft,
  jsonHeaders,
  readRefusal,
  uniqueLocalPart,
  V1_URL,
  V2_URL,
  v1Send,
  v2Distribute,
  v2Redistribute,
  waitForMail,
} from '../../fixtures/send-path';
import {
  buildMarkerPdf,
  buildOwnerRestrictedMarkerPdf,
  countUnattachedRows,
  createTwoStep,
  documentDataOf,
  envelopeOf,
  fetchRecipientPdf,
  keyOfUploadUrl,
  keysHoldingBytes,
  putPdf,
  rowsNamingKey,
  sha256,
  storedBytes,
  type TwoStep,
  uniqueMarker,
} from '../../fixtures/two-step-upload';

test.describe.configure({ mode: 'parallel' });

const UPLOAD_TRANSPORT = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT;

test.skip(
  UPLOAD_TRANSPORT !== 's3',
  `Two-step v1 creation exists only under the S3 upload transport; NEXT_PUBLIC_UPLOAD_TRANSPORT is ${JSON.stringify(UPLOAD_TRANSPORT ?? null)}.`,
);

test.beforeAll(async ({ request }) => {
  assertVerifierToolsPresent();
  await assertMailCatcherReachable(request);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Ctx = Awaited<ReturnType<typeof apiCreateTestContext>>;

const originalPdf = () => buildMarkerPdf(uniqueMarker('ORIGINAL'), 2);

const replacementPdf = () => {
  const replacement = buildOwnerRestrictedMarkerPdf(uniqueMarker('REPLACEMENT'), 5);

  expect(
    readEncryptionWithPdfinfo(replacement).encrypted,
    'fixture precondition: the replacement is owner-restricted',
  ).toBe(true);

  return replacement;
};

/** A late PUT. Criterion 3 allows it to fail or to succeed, so its answer is not asserted. */
const latePut = async (request: APIRequestContext, uploadUrl: string, file: Buffer) =>
  await request.put(uploadUrl, { headers: { 'Content-Type': 'application/pdf' }, data: file });

/** The key the URL writes, checked against the row before the send so the parse is known to be right. */
const uploadKeyOf = async (doc: TwoStep) => {
  const key = keyOfUploadUrl(doc.uploadUrl);
  const row = await documentDataOf(doc.documentId);

  expect(
    { data: row.data, initialData: row.initialData },
    'premise: before the send both columns name the object the upload URL writes',
  ).toEqual({ data: key, initialData: key });

  return key;
};

const sendOk = async (request: APIRequestContext, ctx: Ctx, doc: TwoStep) => {
  const send = await v1Send(request, ctx.token, doc.documentId);

  expect(send.status(), `send: ${await send.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 1);
};

const expectServes = async (
  request: APIRequestContext,
  doc: TwoStep,
  expected: Uint8Array,
  context: string,
  versions: Array<'current' | 'initial'> = ['current', 'initial'],
) => {
  for (const version of versions) {
    const served = await fetchRecipientPdf(request, doc.documentId, doc.recipientId, version);

    expect(sha256(served), `${context}: the recipient's ${version} PDF is the expected bytes`).toBe(sha256(expected));
  }
};

const pagesOf = (bytes: Uint8Array) => Number(readInfoWithPdfinfo(bytes).Pages);

const downloadCompletedV1 = async (request: APIRequestContext, token: string, documentId: number) => {
  const res = await request.get(`${V1_URL}/documents/${documentId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();

  expect(res.status(), `GET /api/v1/documents/${documentId}/download: ${text}`).toBe(200);

  const file = await request.get((JSON.parse(text) as { downloadUrl: string }).downloadUrl);

  expect(file.ok(), `fetching the download URL: ${file.status()}`).toBe(true);

  return new Uint8Array(await file.body());
};

/** Send, optionally PUT a replacement, sign as the recipient in a browser, and return the sealed PDF. */
const sendSignAndSeal = async ({
  request,
  page,
  ctx,
  label,
  original,
  replacement,
}: {
  request: APIRequestContext;
  page: Parameters<typeof signV1AsRecipientInBrowser>[0]['page'];
  ctx: Ctx;
  label: string;
  original: Buffer;
  replacement?: Buffer;
}) => {
  const doc = await createTwoStep(request, ctx.token, label, original);

  await sendOk(request, ctx, doc);

  if (replacement) {
    await latePut(request, doc.uploadUrl, replacement);
  }

  const envelope = await envelopeOf(doc.documentId);
  const recipient = envelope.recipients.find((r) => r.id === doc.recipientId);

  if (!recipient) {
    throw new Error(`recipient ${doc.recipientId} is not on document ${doc.documentId}`);
  }

  await signV1AsRecipientInBrowser({ page, recipientToken: recipient.token, fieldId: doc.fieldId });

  await expect(async () => {
    expect((await envelopeOf(doc.documentId)).status).toBe(DocumentStatus.COMPLETED);
  }).toPass({ timeout: 60_000 });

  return await downloadCompletedV1(request, ctx.token, doc.documentId);
};

// ---------------------------------------------------------------------------
// Criteria 1 and 2
// ---------------------------------------------------------------------------

test('criterion_1_after_a_v1_two_step_send_neither_column_names_the_upload_key_the_row_id_is_kept_and_no_row_names_the_old_key', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c1');
  const doc = await createTwoStep(request, ctx.token, 'u37-c1', originalPdf());
  const oldKey = await uploadKeyOf(doc);
  const before = await envelopeOf(doc.documentId);

  await sendOk(request, ctx, doc);

  const after = await envelopeOf(doc.documentId);
  const row = after.envelopeItems[0].documentData;

  expect(row.id, 'the DocumentData id is the one the envelope item had before the send').toBe(
    before.envelopeItems[0].documentData.id,
  );
  expect(after.envelopeItems[0].documentDataId, 'the envelope item still points at that row').toBe(row.id);
  expect(row.data, 'data no longer names the key the upload URL writes').not.toBe(oldKey);
  expect(row.initialData, 'initialData no longer names the key the upload URL writes').not.toBe(oldKey);
  expect(await rowsNamingKey(oldKey), 'no DocumentData row, attached or not, names the old key').toEqual([]);
});

/**
 * Concurrent sends of one DRAFT. Each request checks and stages its own copy;
 * only one may commit it. A loser must not overwrite the winner's row, and must
 * not leave its staged copy in the bucket or a row behind. A send that starts
 * after the winner committed finds the document PENDING and answers 200; one
 * that lost the race answers 409, never 500. Which of the two each gets depends
 * on timing.
 */
test('criterion_1_concurrent_v1_sends_of_one_draft_store_one_copy_and_leave_no_staged_object_or_row_behind', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const ctx = await apiCreateTestContext('u37-c1-race');
  const original = originalPdf();
  const doc = await createTwoStep(request, ctx.token, 'u37-c1-race', original);
  const oldKey = await uploadKeyOf(doc);
  const unattachedBefore = await countUnattachedRows(ctx.team.id);

  const sends = await Promise.all(
    Array.from({ length: 4 }, async () => await v1Send(request, ctx.token, doc.documentId)),
  );
  const statuses = sends.map((send) => send.status());

  test.info().annotations.push({ type: 'send statuses', description: statuses.join(', ') });

  expect(statuses, 'at least one of the concurrent sends succeeds').toContain(200);
  expect(
    statuses.every((status) => status === 200 || status === 409),
    `every concurrent send answers 200 or, having lost the race, 409 (${statuses.join(', ')})`,
  ).toBe(true);
  await waitForMail(request, doc.localPart, 1);

  const row = await documentDataOf(doc.documentId);

  expect(row.data, 'data no longer names the upload key').not.toBe(oldKey);
  expect(row.initialData, 'initialData names the same stored copy').toBe(row.data);
  expect(await countUnattachedRows(ctx.team.id), 'no unattached DocumentData row was left').toBe(unattachedBefore);
  expect(
    (await keysHoldingBytes(original)).filter((key) => key !== oldKey),
    'exactly one stored copy of the upload exists, and it is the one the row names',
  ).toEqual([row.data]);
});

test('criterion_2_the_bytes_stored_after_the_send_are_byte_identical_to_the_bytes_uploaded', async ({ request }) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c2');
  const original = originalPdf();
  const doc = await createTwoStep(request, ctx.token, 'u37-c2', original);

  await uploadKeyOf(doc);
  await sendOk(request, ctx, doc);

  for (const column of ['data', 'initialData'] as const) {
    expect(sha256(await storedBytes(doc.documentId, column)), `the stored ${column} bytes are the uploaded bytes`).toBe(
      sha256(original),
    );
  }

  await expectServes(request, doc, original, 'after the send');
});

// ---------------------------------------------------------------------------
// Criterion 3
// ---------------------------------------------------------------------------

test('criterion_3_a_put_to_the_upload_url_after_the_send_does_not_change_what_the_recipient_is_served_or_what_is_stored', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c3-serve');
  const original = originalPdf();
  const doc = await createTwoStep(request, ctx.token, 'u37-c3-serve', original);

  await uploadKeyOf(doc);
  await sendOk(request, ctx, doc);

  const put = await latePut(request, doc.uploadUrl, replacementPdf());

  test.info().annotations.push({ type: 'late PUT', description: `${put.status()}` });

  await expectServes(request, doc, original, 'after the late PUT');

  for (const column of ['data', 'initialData'] as const) {
    expect(sha256(await storedBytes(doc.documentId, column)), `the stored ${column} bytes are still the original`).toBe(
      sha256(original),
    );
  }
});

test('criterion_3_after_a_late_put_the_recipient_signs_and_the_sealed_pdf_is_unencrypted_and_derives_from_the_original', async ({
  request,
  page,
}) => {
  test.setTimeout(240_000);

  const ctx = await apiCreateTestContext('u37-c3-seal');
  const originalMarker = uniqueMarker('ORIGINAL');
  const original = buildMarkerPdf(originalMarker, 2);
  const replacementMarker = uniqueMarker('REPLACEMENT');
  const replacement = buildOwnerRestrictedMarkerPdf(replacementMarker, 5);

  const control = await sendSignAndSeal({
    request,
    page,
    ctx,
    label: 'u37-c3-seal-control',
    original: buildMarkerPdf(uniqueMarker('CONTROL'), 2),
  });
  const sealed = await sendSignAndSeal({ request, page, ctx, label: 'u37-c3-seal', original, replacement });

  expect(readEncryptionWithPdfinfo(sealed).encrypted, 'the sealed PDF is unencrypted').toBe(false);
  expect(
    pagesOf(sealed),
    'the sealed PDF has the original’s pages plus the pages sealing appends, as an undisturbed document does',
  ).toBe(pagesOf(control));
  expect(pagesOf(sealed), 'sealing appended pages to the original').toBeGreaterThan(pagesOf(original));

  const text = readPageTextWithPdftotext(sealed);

  expect(text, 'the sealed PDF carries the original’s content').toContain(originalMarker);
  expect(text, 'the sealed PDF does not carry the replacement’s content').not.toContain(replacementMarker);
});

test('control_f8_two_step_create_send_sign_and_seal_with_no_late_put_still_works', async ({ request, page }) => {
  test.setTimeout(150_000);

  const ctx = await apiCreateTestContext('u37-f8');
  const marker = uniqueMarker('ORIGINAL');
  const sealed = await sendSignAndSeal({
    request,
    page,
    ctx,
    label: 'u37-f8',
    original: buildMarkerPdf(marker, 2),
  });

  expect(readEncryptionWithPdfinfo(sealed).encrypted, 'the sealed PDF is unencrypted').toBe(false);
  expect(readPageTextWithPdftotext(sealed), 'the sealed PDF carries the uploaded content').toContain(marker);
});

// ---------------------------------------------------------------------------
// Criteria 4 and 5: refused uploads
// ---------------------------------------------------------------------------

const REFUSED_KINDS: Array<{ kind: string; build: () => Promise<Buffer>; code?: string }> = [
  {
    kind: 'not a PDF',
    build: async () => Buffer.from(`This upload is plain text, not a PDF. ${uniqueMarker('TEXT')}\n`),
    code: 'INVALID_DOCUMENT_FILE',
  },
  { kind: 'user password', build: buildFreshOpenPasswordPdf },
  { kind: 'owner restrictions', build: async () => await buildFreshOwnerOnlyPdf('AES-256') },
  {
    kind: 'broken signature',
    build: async () => {
      const tampered = Buffer.from(await buildSignedThenTamperedPdf());
      const commentStart = tampered.indexOf('\n%', 0, 'latin1') + 3;

      // A second change inside the binary comment gives every run its own bytes; the signature is already broken.
      tampered[commentStart] = 0x80 + Math.floor(Math.random() * 0x7f);

      return tampered;
    },
    code: SIGNATURE_ALREADY_INVALID,
  },
];

for (const { kind, build, code } of REFUSED_KINDS) {
  test(`criterion_4_a_refused_upload_is_refused_at_send_as_today_and_leaves_the_row_and_the_bucket_untouched (${kind})`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const ctx = await apiCreateTestContext('u37-c4');

    const referenceDoc = await createTwoStep(request, ctx.token, 'u37-c4-reference', await build());
    const reference = await readRefusal(await v1Send(request, ctx.token, referenceDoc.documentId));

    const file = await build();
    const doc = await createTwoStep(request, ctx.token, 'u37-c4', file);
    const oldKey = await uploadKeyOf(doc);
    const rowBefore = await documentDataOf(doc.documentId);
    const rowsBefore = await prisma.documentData.count({ where: { teamId: ctx.team.id } });
    const unattachedBefore = await countUnattachedRows(ctx.team.id);

    expect(await keysHoldingBytes(file), 'premise: the upload is in the bucket once, at its key').toEqual([oldKey]);

    const refusal = await readRefusal(await v1Send(request, ctx.token, doc.documentId));

    expectSameRefusalAsDraft(refusal, reference, `v1 send of an upload with ${kind}`);

    if (code) {
      expect(refusal.code ?? refusal.text, `the refusal for ${kind} names ${code}`).toContain(code);
    }

    await expectNoNewMail(request, doc.localPart, 0, `v1 send of an upload with ${kind}`);

    const envelope = await envelopeOf(doc.documentId);

    expect(envelope.status, 'the document stays DRAFT').toBe(DocumentStatus.DRAFT);
    expect(await documentDataOf(doc.documentId), 'the DocumentData row is unchanged').toEqual(rowBefore);
    expect(rowBefore.data, 'and still points at the upload key').toBe(oldKey);
    expect(await keysHoldingBytes(file), 'no object was written for the refused send').toEqual([oldKey]);
    expect(await prisma.documentData.count({ where: { teamId: ctx.team.id } }), 'no DocumentData row was written').toBe(
      rowsBefore,
    );
    expect(await countUnattachedRows(ctx.team.id), 'no row was left unattached').toBe(unattachedBefore);
  });
}

test('criterion_5_after_a_refusal_a_second_put_of_an_acceptable_pdf_followed_by_a_send_succeeds_and_the_recipient_sees_the_second_upload', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const ctx = await apiCreateTestContext('u37-c5');
  const doc = await createTwoStep(
    request,
    ctx.token,
    'u37-c5',
    buildOwnerRestrictedMarkerPdf(uniqueMarker('FIRST'), 3),
  );

  const refused = await readRefusal(await v1Send(request, ctx.token, doc.documentId));

  expect(refused.status, `the first upload is refused: ${refused.text}`).toBe(400);

  const second = originalPdf();

  await putPdf(request, doc.uploadUrl, second);
  await sendOk(request, ctx, doc);
  await expectServes(request, doc, second, 'after the second upload and send');
});

// ---------------------------------------------------------------------------
// Criterion 6
// ---------------------------------------------------------------------------

test('criterion_6_two_puts_before_the_send_the_send_checks_and_stores_the_second_and_the_recipient_sees_it', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c6');
  const first = buildMarkerPdf(uniqueMarker('FIRST'), 3);
  const second = buildMarkerPdf(uniqueMarker('SECOND'), 2);
  const doc = await createTwoStep(request, ctx.token, 'u37-c6', first);

  await putPdf(request, doc.uploadUrl, second);
  await sendOk(request, ctx, doc);

  for (const column of ['data', 'initialData'] as const) {
    expect(sha256(await storedBytes(doc.documentId, column)), `the stored ${column} bytes are the second upload`).toBe(
      sha256(second),
    );
  }

  await expectServes(request, doc, second, 'after two PUTs and a send');
  expect(await keysHoldingBytes(first), 'the first upload exists nowhere in the bucket').toEqual([]);
});

// ---------------------------------------------------------------------------
// Criterion 7: formValues
// ---------------------------------------------------------------------------

const expectFormValuesOnPage = (bytes: Uint8Array, context: string) => {
  const pageText = readPageTextWithPdftotext(bytes);

  for (const [name, supplied] of Object.entries(FORM_VALUES)) {
    if (typeof supplied === 'string') {
      expect(pageText, `${context}: the value supplied for ${name} is on the page`).toContain(supplied);
    }
  }
};

test('criterion_7_a_two_step_document_with_form_values_is_prefilled_unaffected_by_a_late_put_and_its_one_row_does_not_name_the_upload_key', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const ctx = await apiCreateTestContext('u37-c7');
  const doc = await createTwoStep(request, ctx.token, 'u37-c7', FORM_FIELDS_PDF, { formValues: FORM_VALUES });
  const oldKey = await uploadKeyOf(doc);

  await sendOk(request, ctx, doc);

  const current = await fetchRecipientPdf(request, doc.documentId, doc.recipientId, 'current');

  expectFormValuesOnPage(current, 'the recipient is shown the prefilled PDF');

  const envelope = await envelopeOf(doc.documentId);

  expect(envelope.envelopeItems, 'the envelope has one item').toHaveLength(1);
  expect(envelope.envelopeItems[0].documentData.data, 'data does not name the upload key').not.toBe(oldKey);
  expect(envelope.envelopeItems[0].documentData.initialData, 'initialData does not name the upload key').not.toBe(
    oldKey,
  );
  expect(await rowsNamingKey(oldKey), 'no DocumentData row, attached or not, names the upload key').toEqual([]);

  const initialBefore = await fetchRecipientPdf(request, doc.documentId, doc.recipientId, 'initial');

  await latePut(request, doc.uploadUrl, replacementPdf());

  await expectServes(request, doc, current, 'after the late PUT', ['current']);
  await expectServes(request, doc, initialBefore, 'after the late PUT', ['initial']);
});

// ---------------------------------------------------------------------------
// Criterion 8: no orphans
// ---------------------------------------------------------------------------

test('criterion_8_a_plain_send_leaves_no_unattached_row_and_only_the_object_its_row_names', async ({ request }) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c8-plain');
  const original = originalPdf();
  const doc = await createTwoStep(request, ctx.token, 'u37-c8-plain', original);
  const oldKey = await uploadKeyOf(doc);
  const unattachedBefore = await countUnattachedRows(ctx.team.id);

  await sendOk(request, ctx, doc);

  const row = await documentDataOf(doc.documentId);

  expect(await countUnattachedRows(ctx.team.id), 'the send left no unattached DocumentData row').toBe(unattachedBefore);
  expect(await rowsNamingKey(oldKey), 'no row names the upload key').toEqual([]);

  const held = await keysHoldingBytes(original);

  const copies = held.filter((key) => key !== oldKey);

  expect(copies.length, 'the document’s bytes are stored').toBeGreaterThan(0);
  expect(
    copies.every((key) => key === row.data || key === row.initialData),
    `apart from the uploaded object, which a later cleanup collects, the only objects holding the document’s bytes are the ones its row names (${held.join(', ')})`,
  ).toBe(true);
});

test('criterion_8_a_late_put_after_the_send_creates_no_unattached_row_and_no_row_names_the_upload_key', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c8-late');
  const doc = await createTwoStep(request, ctx.token, 'u37-c8-late', originalPdf());
  const oldKey = await uploadKeyOf(doc);

  await sendOk(request, ctx, doc);

  const unattachedBefore = await countUnattachedRows(ctx.team.id);

  await latePut(request, doc.uploadUrl, replacementPdf());

  expect(await countUnattachedRows(ctx.team.id), 'the late PUT left no unattached DocumentData row').toBe(
    unattachedBefore,
  );
  expect(await rowsNamingKey(oldKey), 'no row names the upload key after the late PUT').toEqual([]);
});

test('criterion_8_a_form_values_send_leaves_no_unattached_row_and_no_row_names_the_upload_key', async ({ request }) => {
  test.setTimeout(120_000);

  const ctx = await apiCreateTestContext('u37-c8-form');
  const doc = await createTwoStep(request, ctx.token, 'u37-c8-form', FORM_FIELDS_PDF, { formValues: FORM_VALUES });
  const oldKey = await uploadKeyOf(doc);
  const unattachedBefore = await countUnattachedRows(ctx.team.id);

  await sendOk(request, ctx, doc);

  expect(await countUnattachedRows(ctx.team.id), 'the send left no unattached DocumentData row').toBe(unattachedBefore);
  expect(await rowsNamingKey(oldKey), 'no row names the upload key').toEqual([]);
});

// ---------------------------------------------------------------------------
// Criterion 9: tRPC /document/create/beta then distribute
// ---------------------------------------------------------------------------

const createViaTrpcBeta = async (request: APIRequestContext, token: string, label: string, file: Buffer) => {
  const localPart = uniqueLocalPart(label);
  const res = await request.post(`${V2_URL}/document/create/beta`, {
    headers: jsonHeaders(token),
    data: {
      title: label,
      recipients: [
        {
          name: 'Send Path Signer',
          email: addressFor(localPart),
          role: 'SIGNER',
          fields: [{ type: FieldType.SIGNATURE, pageNumber: 1, pageX: 10, pageY: 10, width: 20, height: 5 }],
        },
      ],
    },
  });
  const text = await res.text();

  expect(res.status(), `POST /api/v2-beta/document/create/beta: ${text}`).toBe(200);

  const body = JSON.parse(text) as { document: { id: number }; uploadUrl: string };

  await putPdf(request, body.uploadUrl, file);

  const envelope = await envelopeOf(body.document.id);
  const recipientId = envelope.recipients[0].id;

  const doc: TwoStep = {
    documentId: body.document.id,
    recipientId,
    fieldId: 0,
    uploadUrl: body.uploadUrl,
    localPart,
  };

  return doc;
};

const distributeOk = async (request: APIRequestContext, ctx: Ctx, doc: TwoStep) => {
  const res = await v2Distribute(request, ctx.token, doc.documentId);

  expect(res.status(), `distribute: ${await res.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 1);
};

test('criterion_9_trpc_create_beta_then_distribute_leaves_neither_column_on_the_upload_key_and_stores_the_uploaded_bytes', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c9-keys');
  const original = originalPdf();
  const doc = await createViaTrpcBeta(request, ctx.token, 'u37-c9-keys', original);
  const oldKey = await uploadKeyOf(doc);
  const before = await envelopeOf(doc.documentId);

  await distributeOk(request, ctx, doc);

  const after = await envelopeOf(doc.documentId);
  const row = after.envelopeItems[0].documentData;

  expect(row.id, 'the DocumentData id is the one the envelope item had before the send').toBe(
    before.envelopeItems[0].documentData.id,
  );
  expect(row.data, 'data no longer names the key the upload URL writes').not.toBe(oldKey);
  expect(row.initialData, 'initialData no longer names the key the upload URL writes').not.toBe(oldKey);
  expect(await rowsNamingKey(oldKey), 'no DocumentData row, attached or not, names the old key').toEqual([]);

  for (const column of ['data', 'initialData'] as const) {
    expect(sha256(await storedBytes(doc.documentId, column)), `the stored ${column} bytes are the uploaded bytes`).toBe(
      sha256(original),
    );
  }
});

test('criterion_9_trpc_create_beta_then_distribute_is_unaffected_by_a_late_put_and_distribute_and_redistribute_still_answer_200', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const ctx = await apiCreateTestContext('u37-c9-late');
  const original = originalPdf();
  const doc = await createViaTrpcBeta(request, ctx.token, 'u37-c9-late', original);

  await uploadKeyOf(doc);
  await distributeOk(request, ctx, doc);
  await latePut(request, doc.uploadUrl, replacementPdf());

  await expectServes(request, doc, original, 'after the late PUT');

  const again = await v2Distribute(request, ctx.token, doc.documentId);

  expect(again.status(), `repeat distribute after a late PUT: ${await again.text()}`).toBe(200);

  const redistribute = await v2Redistribute(request, ctx.token, doc.documentId, [doc.recipientId]);

  expect(redistribute.status(), `redistribute after a late PUT: ${await redistribute.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 2);
});

test('control_f8_trpc_create_beta_distribute_repeat_distribute_and_redistribute_work_with_no_late_put', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const ctx = await apiCreateTestContext('u37-c9-control');
  const doc = await createViaTrpcBeta(request, ctx.token, 'u37-c9-control', originalPdf());

  await distributeOk(request, ctx, doc);

  const again = await v2Distribute(request, ctx.token, doc.documentId);

  expect(again.status(), `repeat distribute: ${await again.text()}`).toBe(200);

  const redistribute = await v2Redistribute(request, ctx.token, doc.documentId, [doc.recipientId]);

  expect(redistribute.status(), `redistribute: ${await redistribute.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 2);
});
