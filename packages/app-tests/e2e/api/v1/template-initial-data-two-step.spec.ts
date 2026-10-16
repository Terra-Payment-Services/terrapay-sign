/**
 * A document made from a template never names the template's presigned upload key.
 *
 * Written from the specification before the
 * fix. The code under test was read only to list the routes that create a
 * document from a template (`createDocumentFromTemplate`'s callers and
 * `createDocumentFromDirectTemplate`) and to learn which later steps read
 * `initialData` (the send-time copy keeps a differing one; a reseal reads it).
 * Every assertion is on something observable from outside: the keys the rows
 * name, the bytes MinIO holds under them, and the sealed PDF.
 *
 * | Test                                                                | Criteria | Failure modes |
 * | ------------------------------------------------------------------- | -------- | ------------- |
 * | per route [x7]: keys outside the template's, initialData is the      | 1, 2, 4  | F1, F2, F3,   |
 * |   uploaded PDF, a PUT to the template URL changes neither column     |          | F4            |
 * |   (v1 create-document, v1 generate-document, tRPC                    |          |               |
 * |   template.createDocumentFromTemplate, API v2 template/use, API v2   |          |               |
 * |   envelope/use, bulk send, direct template signing)                  |          |               |
 * | per form-capable route [x5]: initialData is the unfilled template,   | 3        | F1, F2, F3,   |
 * |   data is prefilled, a PUT changes neither                           |          | F4            |
 * | custom upload through API v2 template/use: initialData is the        | 1        | F2            |
 * |   upload as stored, keys outside the template's, a PUT changes       |          |               |
 * |   neither                                                            |          |               |
 * | PUT before the send: send, sign, complete; the sealed PDF and the    | 5        | F1, F4        |
 * |   rows hold the original                                             |          |               |
 * | PUT before the send, then a reseal: the resealed PDF holds the       | 5        | F1, F4        |
 * |   original                                                           |          |               |
 * | template made without an upload URL: data/initialData as today       | 6        |               |
 *
 * Measurements:
 * - the key the upload URL writes is parsed from the URL and checked against
 *   the template's row before anything else, so the parse is known to be right;
 * - key checks are soft, so a red run also reports what the bytes did;
 * - bytes are read from MinIO with the server's own credentials and compared
 *   by sha256 before and after a PUT of a different marker PDF to the
 *   template's upload URL, which is still inside its hour;
 * - "the PDF the document was created from" is the bytes uploaded to the
 *   template, or the custom upload's stored `initialData` read before the use;
 * - the sealed and resealed PDFs are read with pdftotext for the original's
 *   and the replacement's markers.
 *
 * Criterion 6 asks for the database transport. This worktree's server runs S3,
 * so the criterion 6 test here makes its template through API v2 envelope/create
 * (no upload URL, so nothing presigned) and runs under either transport. The
 * database-transport run of the existing template specs
 * (e2e/api/orphan-document-data/template-use.spec.ts, criterion_2) is the rest
 * of criterion 6.
 *
 * The two-step tests skip unless NEXT_PUBLIC_UPLOAD_TRANSPORT is "s3": under any
 * other transport there is no upload URL. qpdf is not needed: the replacement is
 * a plain marker PDF.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DocumentStatus, EnvelopeType, FieldType } from '@prisma/client';
import { type ApiSeedContext, apiCreateTestContext } from '../../fixtures/api-seeds';
import { apiSignin } from '../../fixtures/authentication';
import { bytesOfColumn, resealAsAdmin, seedTemplate, textOf, waitForStatus } from '../../fixtures/orphan-document-data';
import { FORM_FIELDS_PDF, FORM_VALUES, signV1AsRecipientInBrowser } from '../../fixtures/protected-pdfs';
import { signSignaturePad } from '../../fixtures/signature';
import {
  buildMarkerPdf,
  keyOfUploadUrl,
  putPdf,
  readObject,
  sha256,
  uniqueMarker,
} from '../../fixtures/two-step-upload';

test.describe.configure({ mode: 'parallel' });

const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();
const V1 = `${WEBAPP_URL}/api/v1`;
const V2 = `${WEBAPP_URL}/api/v2-beta`;
const IS_S3 = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT === 's3';
const SKIP_REASON = `Two-step template creation exists only under the S3 upload transport; NEXT_PUBLIC_UPLOAD_TRANSPORT is ${JSON.stringify(process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT ?? null)}.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonBearer = (token: string) => ({ ...bearer(token), 'Content-Type': 'application/json' });

const uniqueEmail = (label: string) => `${label}-${uniqueMarker('r').slice(2)}@test.documenso.com`;

const expectOk = async (res: Awaited<ReturnType<APIRequestContext['post']>>, what: string) =>
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);

type TwoStepTemplate = {
  ctx: ApiSeedContext;
  templateId: number;
  envelopeId: string;
  recipientId: number;
  fieldId: number;
  uploadUrl: string;
  uploadKey: string;
  /** Every key the template's DocumentData rows name. */
  templateKeys: string[];
  original: Buffer;
  marker: string;
};

/**
 * POST /api/v1/templates, PUT the PDF to the returned URL, then give the
 * template one signer with one signature field through API v2 (v1 has no
 * template recipient or field routes).
 */
const createTwoStepTemplate = async (
  request: APIRequestContext,
  label: string,
  options: { file?: Buffer; marker?: string } = {},
): Promise<TwoStepTemplate> => {
  const ctx = await apiCreateTestContext(label);
  const marker = options.marker ?? uniqueMarker('ORIGINAL');
  const original = options.file ?? buildMarkerPdf(marker, 2);

  const res = await request.post(`${V1}/templates`, { headers: jsonBearer(ctx.token), data: { title: label } });
  const text = await res.text();

  expect(res.status(), `POST /api/v1/templates: ${text}`).toBe(200);

  const body = JSON.parse(text) as { uploadUrl: string; template: { id: number; envelopeId: string } };

  await putPdf(request, body.uploadUrl, original);

  const recipientRes = await request.post(`${V2}/envelope/recipient/create-many`, {
    headers: jsonBearer(ctx.token),
    data: {
      envelopeId: body.template.envelopeId,
      data: [{ email: uniqueEmail('template-role'), name: 'Template Signer', role: 'SIGNER' }],
    },
  });

  await expectOk(recipientRes, 'adding the template recipient');

  const recipientId = ((await recipientRes.json()) as { data: Array<{ id: number }> }).data[0].id;

  const fieldRes = await request.post(`${V2}/envelope/field/create-many`, {
    headers: jsonBearer(ctx.token),
    data: {
      envelopeId: body.template.envelopeId,
      data: [{ recipientId, type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 60, width: 30, height: 8 }],
    },
  });

  await expectOk(fieldRes, 'adding the template field');

  const fieldId = ((await fieldRes.json()) as { data: Array<{ id: number }> }).data[0].id;

  const uploadKey = keyOfUploadUrl(body.uploadUrl);
  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId: body.template.envelopeId },
    include: { documentData: true },
  });

  expect(items, 'premise: the template has one item').toHaveLength(1);
  expect(
    { data: items[0].documentData.data, initialData: items[0].documentData.initialData },
    'premise: both columns of the template row name the key its upload URL writes',
  ).toEqual({ data: uploadKey, initialData: uploadKey });

  const stored = await readObject(uploadKey);

  expect(stored.status, 'premise: the upload landed').toBe(200);
  expect(sha256((stored as { bytes: Buffer }).bytes), 'premise: the template object is the upload').toBe(
    sha256(original),
  );

  return {
    ctx,
    templateId: body.template.id,
    envelopeId: body.template.envelopeId,
    recipientId,
    fieldId,
    uploadUrl: body.uploadUrl,
    uploadKey,
    templateKeys: [...new Set([uploadKey, ...items.flatMap((i) => [i.documentData.data, i.documentData.initialData])])],
    original,
    marker,
  };
};

/** The one DOCUMENT envelope the test's fresh team owns. */
const theDocument = async (teamId: number) => {
  const docs = await prisma.envelope.findMany({
    where: { teamId, type: EnvelopeType.DOCUMENT },
    include: { recipients: true, fields: true, envelopeItems: { include: { documentData: true } } },
  });

  expect(docs, 'premise: exactly one document was created from the template').toHaveLength(1);

  return docs[0];
};

const objectBytes = async (key: string, what: string) => {
  const read = await readObject(key);

  expect(read.status, `${what}: MinIO holds an object at ${key}`).toBe(200);

  return (read as { bytes: Buffer }).bytes;
};

type Snapshot = Array<{ rowId: string; data: string; initialData: string; dataSha: string; initialSha: string }>;

/** The new document's rows with the sha256 of the bytes MinIO holds under each column. */
const snapshotDocument = async (teamId: number): Promise<Snapshot> => {
  const doc = await theDocument(teamId);

  return await Promise.all(
    doc.envelopeItems.map(async (item) => ({
      rowId: item.documentData.id,
      data: item.documentData.data,
      initialData: item.documentData.initialData,
      dataSha: sha256(await objectBytes(item.documentData.data, 'data')),
      initialSha: sha256(await objectBytes(item.documentData.initialData, 'initialData')),
    })),
  );
};

/** F1: neither column of any of the new document's rows names a key the template's rows or upload URL name. */
const expectKeysOutsideTemplate = async (tpl: TwoStepTemplate, snapshot: Snapshot, context: string) => {
  for (const row of snapshot) {
    expect.soft(tpl.templateKeys, `${context}: data names none of the template's keys`).not.toContain(row.data);
    expect
      .soft(tpl.templateKeys, `${context}: initialData names none of the template's keys`)
      .not.toContain(row.initialData);
  }

  const docRowIds = snapshot.map((row) => row.rowId);
  const namingUploadKey = await prisma.documentData.findMany({
    where: { id: { in: docRowIds }, OR: [{ data: tpl.uploadKey }, { initialData: tpl.uploadKey }] },
  });

  expect.soft(namingUploadKey, `${context}: no row of the document names the presigned upload key`).toEqual([]);
};

/** A different PDF PUT to the template's upload URL, still inside its hour. The PUT itself must land. */
const putReplacement = async (request: APIRequestContext, tpl: TwoStepTemplate) => {
  const replacementMarker = uniqueMarker('REPLACEMENT');
  const replacement = buildMarkerPdf(replacementMarker, 3);

  await putPdf(request, tpl.uploadUrl, replacement);

  expect(
    sha256(await objectBytes(tpl.uploadKey, 'the template key after the PUT')),
    'premise: the PUT replaced the object under the template key',
  ).toBe(sha256(replacement));

  return { replacement, replacementMarker };
};

/** F4: after the PUT, the bytes under both columns are what they were before it. */
const expectBytesSurvivePut = async (teamId: number, before: Snapshot, context: string) => {
  const after = await snapshotDocument(teamId);

  expect(
    after.map((row) => ({ dataSha: row.dataSha, initialSha: row.initialSha })),
    `${context}: the bytes under data and initialData are unchanged by the PUT to the template URL`,
  ).toEqual(before.map((row) => ({ dataSha: row.dataSha, initialSha: row.initialSha })));
};

// ---------------------------------------------------------------------------
// Routes that create a document from a template
// ---------------------------------------------------------------------------

type UseOptions = { email: string; formValues?: Record<string, string | number | boolean> };

type Route = {
  name: string;
  formValues: boolean;
  use: (request: APIRequestContext, page: Page, tpl: TwoStepTemplate, options: UseOptions) => Promise<void>;
};

/** Signs in as the template's owner in the page's context; returns that context's request. */
const sessionOf = async (page: Page, tpl: TwoStepTemplate) => {
  await apiSignin({ page, email: tpl.ctx.user.email });

  return page.context().request;
};

const ROUTES: Route[] = [
  {
    name: 'API v1 create-document',
    formValues: true,
    use: async (request, _page, tpl, { email, formValues }) => {
      const res = await request.post(`${V1}/templates/${tpl.templateId}/create-document`, {
        headers: jsonBearer(tpl.ctx.token),
        data: { title: 'From template', recipients: [{ email, name: 'Signer' }], formValues },
      });

      await expectOk(res, 'POST /api/v1/templates/:id/create-document');
    },
  },
  {
    name: 'API v1 generate-document',
    formValues: true,
    use: async (request, _page, tpl, { email, formValues }) => {
      const res = await request.post(`${V1}/templates/${tpl.templateId}/generate-document`, {
        headers: jsonBearer(tpl.ctx.token),
        data: { title: 'From template', recipients: [{ id: tpl.recipientId, email, name: 'Signer' }], formValues },
      });

      await expectOk(res, 'POST /api/v1/templates/:id/generate-document');
    },
  },
  {
    name: 'tRPC template.createDocumentFromTemplate',
    formValues: true,
    use: async (_request, page, tpl, { email, formValues }) => {
      const session = await sessionOf(page, tpl);
      const res = await session.post(`${WEBAPP_URL}/api/trpc/template.createDocumentFromTemplate`, {
        headers: { 'content-type': 'application/json', 'x-team-id': String(tpl.ctx.team.id) },
        data: JSON.stringify({
          json: { templateId: tpl.templateId, recipients: [{ id: tpl.recipientId, email }], formValues },
        }),
      });

      await expectOk(res, 'tRPC template.createDocumentFromTemplate');
    },
  },
  {
    name: 'API v2 template/use',
    formValues: true,
    use: async (request, _page, tpl, { email, formValues }) => {
      const res = await request.post(`${V2}/template/use`, {
        headers: jsonBearer(tpl.ctx.token),
        data: { templateId: tpl.templateId, recipients: [{ id: tpl.recipientId, email }], formValues },
      });

      await expectOk(res, 'POST /api/v2-beta/template/use');
    },
  },
  {
    name: 'API v2 envelope/use',
    formValues: true,
    use: async (request, _page, tpl, { email, formValues }) => {
      const formData = new FormData();

      formData.append(
        'payload',
        JSON.stringify({ envelopeId: tpl.envelopeId, recipients: [{ id: tpl.recipientId, email }], formValues }),
      );

      const res = await request.post(`${V2}/envelope/use`, { headers: bearer(tpl.ctx.token), multipart: formData });

      await expectOk(res, 'POST /api/v2-beta/envelope/use');
    },
  },
  {
    name: 'bulk send',
    formValues: false,
    use: async (_request, page, tpl, { email }) => {
      const session = await sessionOf(page, tpl);
      const csv = ['recipient_1_email,recipient_1_name', `${email},Bulk Recipient`].join('\n');
      const res = await session.post(`${WEBAPP_URL}/api/trpc/template.uploadBulkSend`, {
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          json: { templateId: tpl.templateId, teamId: tpl.ctx.team.id, csv, sendImmediately: false },
        }),
      });

      await expectOk(res, 'tRPC template.uploadBulkSend');

      // The bulk send job runs in the background.
      await expect
        .poll(
          async () => await prisma.envelope.count({ where: { teamId: tpl.ctx.team.id, type: EnvelopeType.DOCUMENT } }),
          { timeout: 60_000, intervals: [500] },
        )
        .toBe(1);
    },
  },
  {
    name: 'direct template signing',
    formValues: false,
    use: async (request, page, tpl, { email }) => {
      const res = await request.post(`${V2}/template/direct/create`, {
        headers: jsonBearer(tpl.ctx.token),
        data: { templateId: tpl.templateId, directRecipientId: tpl.recipientId },
      });

      await expectOk(res, 'POST /api/v2-beta/template/direct/create');

      const { token } = await prisma.templateDirectLink.findFirstOrThrow({ where: { envelopeId: tpl.envelopeId } });

      await signDirectTemplate(page, token, tpl.fieldId, email);
      await page.waitForURL(/\/sign/);
      await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();

      // One signer: the document completes and is sealed. The rows are read once the seal has landed.
      const doc = await theDocument(tpl.ctx.team.id);

      await waitForStatus(doc.id, DocumentStatus.COMPLETED);
    },
  },
];

/** The direct template signing steps, as e2e/templates/protected-pdf-direct-template.spec.ts drives them. */
const signDirectTemplate = async (page: Page, directToken: string, fieldId: number, email: string) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.goto(formatDirectTemplatePath(directToken));
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();

  await page.waitForTimeout(100);
  await page.getByPlaceholder('name@example.com').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();

  await signSignaturePad(page);
  await page.locator(`#field-${fieldId}`).getByRole('button').click();
  await expect(page.locator(`#field-${fieldId}`)).toHaveAttribute('data-inserted', 'true');

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();
};

const slug = (name: string) => name.replace(/\W+/g, '_');

// ---------------------------------------------------------------------------
// Criteria 1, 2 and 4: every route
// ---------------------------------------------------------------------------

test.describe('two-step template', () => {
  test.skip(!IS_S3, SKIP_REASON);

  for (const route of ROUTES) {
    const criterion =
      route.name === 'direct template signing' ? '4' : route.name.startsWith('API v1 create') ? '1' : '2';

    test(`criterion_${criterion}_${slug(route.name)}_names_no_template_key_and_a_put_to_the_template_url_changes_neither_column`, async ({
      request,
      page,
    }) => {
      test.setTimeout(150_000);

      const tpl = await createTwoStepTemplate(request, `t40-${slug(route.name)}`);

      await route.use(request, page, tpl, { email: uniqueEmail('t40-signer') });

      const before = await snapshotDocument(tpl.ctx.team.id);

      await expectKeysOutsideTemplate(tpl, before, route.name);

      // F2: initialData holds the PDF the document was created from, byte for byte.
      for (const row of before) {
        expect(row.initialSha, `${route.name}: initialData holds the template's PDF exactly`).toBe(
          sha256(tpl.original),
        );
      }

      // data holds the template's content (normalised, or sealed for a direct template).
      const doc = await theDocument(tpl.ctx.team.id);

      for (const item of doc.envelopeItems) {
        expect(
          textOf(await objectBytes(item.documentData.data, 'data')),
          `${route.name}: data carries the template's content`,
        ).toContain(tpl.marker);
      }

      await putReplacement(request, tpl);
      await expectBytesSurvivePut(tpl.ctx.team.id, before, route.name);
    });
  }

  // -------------------------------------------------------------------------
  // Criterion 3: form values
  // -------------------------------------------------------------------------

  for (const route of ROUTES.filter((candidate) => candidate.formValues)) {
    test(`criterion_3_${slug(route.name)}_with_form_values_keeps_the_unfilled_template_in_initialData_and_a_put_changes_neither_column`, async ({
      request,
      page,
    }) => {
      test.setTimeout(150_000);

      const tpl = await createTwoStepTemplate(request, `t40-form-${slug(route.name)}`, { file: FORM_FIELDS_PDF });

      await route.use(request, page, tpl, { email: uniqueEmail('t40-form'), formValues: FORM_VALUES });

      const before = await snapshotDocument(tpl.ctx.team.id);

      await expectKeysOutsideTemplate(tpl, before, `${route.name} with form values`);

      const [row] = before;

      expect(row.initialSha, 'initialData is the template PDF without the form values, exactly').toBe(
        sha256(FORM_FIELDS_PDF),
      );
      expect(row.dataSha, 'data is not the unfilled template').not.toBe(sha256(FORM_FIELDS_PDF));
      expect(textOf(await objectBytes(row.data, 'data')), 'data carries the supplied form value').toContain(
        FORM_VALUES.test_text_field,
      );
      expect(textOf(await objectBytes(row.initialData, 'initialData')), 'initialData does not').not.toContain(
        FORM_VALUES.test_text_field,
      );

      await putReplacement(request, tpl);
      await expectBytesSurvivePut(tpl.ctx.team.id, before, `${route.name} with form values`);
    });
  }

  // -------------------------------------------------------------------------
  // A custom upload in place of the template's PDF
  // -------------------------------------------------------------------------

  test('criterion_1_custom_upload_through_API_v2_template_use_keeps_the_upload_in_initialData_and_names_no_template_key', async ({
    request,
    page,
  }) => {
    test.setTimeout(120_000);

    const tpl = await createTwoStepTemplate(request, 't40-custom');
    const customMarker = uniqueMarker('CUSTOM');
    const session = await sessionOf(page, tpl);
    const formData = new FormData();

    formData.append('file', new File([buildMarkerPdf(customMarker, 2)], 'custom.pdf', { type: 'application/pdf' }));

    const upload = await session.post(`${WEBAPP_URL}/api/files/upload-pdf`, { multipart: formData });

    expect(upload.status(), `upload-pdf: ${await upload.text()}`).toBe(200);

    const custom = (await upload.json()) as { id: string; initialData: string };
    const customInitialSha = sha256(await objectBytes(custom.initialData, 'the custom upload'));

    const res = await request.post(`${V2}/template/use`, {
      headers: jsonBearer(tpl.ctx.token),
      data: {
        templateId: tpl.templateId,
        recipients: [{ id: tpl.recipientId, email: uniqueEmail('t40-custom') }],
        customDocumentDataId: custom.id,
      },
    });

    await expectOk(res, 'POST /api/v2-beta/template/use with customDocumentDataId');

    const before = await snapshotDocument(tpl.ctx.team.id);

    await expectKeysOutsideTemplate(tpl, before, 'custom upload');
    expect(before[0].initialSha, 'initialData is the custom upload as stored, exactly').toBe(customInitialSha);
    expect(textOf(await objectBytes(before[0].data, 'data')), 'data is the custom upload, not the template').toContain(
      customMarker,
    );

    await putReplacement(request, tpl);
    await expectBytesSurvivePut(tpl.ctx.team.id, before, 'custom upload');
  });

  // -------------------------------------------------------------------------
  // Criterion 5: send, sign, complete, reseal
  // -------------------------------------------------------------------------

  /** v1 generate-document, PUT a replacement to the template URL, v1 send, sign and complete. */
  const generatePutSendAndComplete = async (request: APIRequestContext, page: Page, label: string) => {
    const tpl = await createTwoStepTemplate(request, label);
    const email = uniqueEmail(label);
    const generated = await request.post(`${V1}/templates/${tpl.templateId}/generate-document`, {
      headers: jsonBearer(tpl.ctx.token),
      data: { title: label, recipients: [{ id: tpl.recipientId, email, name: 'Signer' }] },
    });
    const text = await generated.text();

    expect(generated.status(), `generate-document: ${text}`).toBe(200);

    const { documentId, recipients } = JSON.parse(text) as {
      documentId: number;
      recipients: Array<{ recipientId: number; token: string }>;
    };

    const { replacementMarker } = await putReplacement(request, tpl);

    const send = await request.post(`${V1}/documents/${documentId}/send`, {
      headers: jsonBearer(tpl.ctx.token),
      data: { sendEmail: true },
    });

    expect(send.status(), `send: ${await send.text()}`).toBe(200);

    const doc = await theDocument(tpl.ctx.team.id);
    const fieldIds = doc.fields.filter((f) => f.recipientId === recipients[0].recipientId).map((f) => f.id);

    expect(fieldIds, 'premise: the template field was copied to the document').toHaveLength(1);

    // envelope.field.sign takes only V2 envelopes; a V1 document is signed on the recipient's page.
    await signV1AsRecipientInBrowser({ page, recipientToken: recipients[0].token, fieldId: fieldIds[0] });
    await waitForStatus(doc.id, DocumentStatus.COMPLETED);

    return { tpl, doc, replacementMarker };
  };

  const expectDerivesFromOriginal = (
    sealed: Uint8Array,
    tpl: TwoStepTemplate,
    replacementMarker: string,
    what: string,
  ) => {
    const text = textOf(sealed);

    expect(text, `${what} carries the original's content`).toContain(tpl.marker);
    expect(text, `${what} does not carry the replacement PUT to the template URL`).not.toContain(replacementMarker);
  };

  test('criterion_5_a_put_to_the_template_url_before_the_send_does_not_reach_the_sealed_pdf_or_the_rows', async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000);

    const { tpl, doc, replacementMarker } = await generatePutSendAndComplete(request, page, 't40-c5-seal');
    const [item] = (await theDocument(tpl.ctx.team.id)).envelopeItems;

    expectDerivesFromOriginal(await bytesOfColumn(item.documentData, 'data'), tpl, replacementMarker, 'the sealed PDF');

    const after = await snapshotDocument(tpl.ctx.team.id);

    await expectKeysOutsideTemplate(tpl, after, 'after completion');
    expect(after[0].initialSha, `document ${doc.id}: initialData still holds the original after completion`).toBe(
      sha256(tpl.original),
    );
  });

  test('criterion_5_a_put_to_the_template_url_before_the_send_does_not_reach_a_resealed_pdf', async ({
    request,
    page,
  }) => {
    test.setTimeout(240_000);

    const { tpl, doc, replacementMarker } = await generatePutSendAndComplete(request, page, 't40-c5-reseal');
    const [sealedItem] = (await theDocument(tpl.ctx.team.id)).envelopeItems;
    const { user: admin } = await seedUser({ isAdmin: true });

    await resealAsAdmin(page, admin.email, doc.id, sealedItem.id);

    const [resealedItem] = (await theDocument(tpl.ctx.team.id)).envelopeItems;

    expectDerivesFromOriginal(
      await bytesOfColumn(resealedItem.documentData, 'data'),
      tpl,
      replacementMarker,
      'the resealed PDF',
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: a template made without an upload URL, either transport
// ---------------------------------------------------------------------------

test('criterion_6_a_document_from_a_template_without_an_upload_url_keeps_todays_data_and_initialData', async ({
  request,
}) => {
  const tpl = await seedTemplate(request, 1, { label: 't40-c6' });
  const [templateItem] = await prisma.envelopeItem.findMany({
    where: { envelopeId: tpl.envelopeId },
    include: { documentData: true },
  });
  const email = uniqueEmail('t40-c6');

  const res = await request.post(`${V1}/templates/${tpl.templateId}/generate-document`, {
    headers: jsonBearer(tpl.ctx.token),
    data: { title: 'From template', recipients: [{ id: tpl.recipientId, email, name: 'Signer' }] },
  });

  await expectOk(res, 'POST /api/v1/templates/:id/generate-document');

  const [item] = (await theDocument(tpl.ctx.team.id)).envelopeItems;

  expect(item.documentData.type, 'the new row uses the template row’s storage type').toBe(
    templateItem.documentData.type,
  );
  expect(
    sha256(await bytesOfColumn(item.documentData, 'initialData')),
    'initialData holds the template’s bytes exactly',
  ).toBe(sha256(tpl.items[0].bytes));
  expect(textOf(await bytesOfColumn(item.documentData, 'data')), 'data carries the template’s content').toContain(
    tpl.items[0].marker,
  );

  if (!IS_S3) {
    expect(
      item.documentData.initialData,
      'database transport: initialData is the template’s inline data, as today',
    ).toBe(templateItem.documentData.data);
  }
});
