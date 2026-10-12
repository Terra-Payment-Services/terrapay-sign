/**
 * Using a template must not leave DocumentData rows that no document holds (criteria 1, 2, 14, F7).
 *
 * Written from the specification before the
 * fix, and without reading the code under test beyond finding the five callers
 * of `createDocumentFromTemplate`.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | per caller [x4]: N items make exactly N rows, none unattached      | 1        |               |
 * | bulk send of K recipients, N items: exactly K x N rows, none       | 1        |               |
 * |   unattached                                                       |          |               |
 * | per caller [x4]: data is the normalised template, initialData is   | 2        | F7            |
 * |   the template's bytes, the recipient is served both               |          |               |
 * | per caller [x4]: with formValues, data is prefilled, initialData   | 2        | F7            |
 * |   is the template's bytes, no unattached row                       |          |               |
 * | API v1 create-document with formValues: 200, prefilled, no        | 4        |               |
|   unattached row                                                   |          |               |
| a template document reseals from its initialData                   | 2        | F7, F8        |
 * | database transport: the new rows hold only what the live rows do  | 14       |               |
 *
 * Measurements are taken from outside the code under test. Rows are counted by
 * the test's own fresh user and team, before and after. The bytes behind
 * `data` are judged by what poppler reads and the page count, because the
 * specification gives no digest for the normalised bytes; the bytes behind
 * `initialData` are compared by sha256 with the template's stored bytes, which
 * the specification fixes.
 *
 * Criterion 2's tests, and the reseal test, describe behaviour that must not
 * change, so they pass on the unfixed server. The row-count tests fail there:
 * each use leaves one unattached row per item.
 *
 * Runs under both upload transports. Under S3 the rows hold object keys and
 * the byte checks read the objects through the server's own reader.
 */
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus } from '@prisma/client';
import {
  bulkSend,
  bytesOfColumn,
  distribute,
  documentsFor,
  IS_S3,
  itemsOfEnvelope,
  pagesOf,
  resealAsAdmin,
  rowCount,
  type SeededTemplate,
  seedTemplate,
  sha256,
  signAndComplete,
  storedCharacters,
  textOf,
  USE_CALLERS,
  unattachedCount,
  unattachedRowsOf,
  uniqueEmail,
  WEBAPP_URL,
  waitForStatus,
} from '../../fixtures/orphan-document-data';
import { assertVerifierToolsPresent, FORM_FIELDS_PDF, FORM_VALUES } from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const itemCountFor = (multiItem: boolean) => (multiItem ? 2 : 1);

/** What the recipient's signing page is served for an item, `current` or `initial`. */
const recipientPdf = async (
  request: APIRequestContext,
  envelope: { id: string },
  recipientToken: string,
  item: { id: string; documentDataId: string },
  version: 'current' | 'initial',
) => {
  const url = `${WEBAPP_URL}/api/files/token/${recipientToken}/envelope/${envelope.id}/envelopeItem/${item.id}/dataId/${item.documentDataId}/${version}/item.pdf`;
  const res = await request.get(url);

  expect(res.status(), `recipient PDF route (${version}): ${res.status()} ${url}`).toBe(200);

  return new Uint8Array(await res.body());
};

const expectDataIsTemplate = (bytes: Uint8Array, item: SeededTemplate['items'][number], context: string) => {
  expect(textOf(bytes), `${context}: data carries the template's text`).toContain(item.marker);
  expect(pagesOf(bytes), `${context}: data has the template's page count`).toBe(item.pages);
};

for (const caller of USE_CALLERS) {
  const itemCount = itemCountFor(caller.multiItem);

  test(`criterion_1_${caller.name.replace(/\W+/g, '_')}_makes_exactly_one_row_per_item_and_none_unattached`, async ({
    request,
  }) => {
    const tpl = await seedTemplate(request, itemCount, { label: 'use-count' });
    const email = uniqueEmail('use-count');
    const before = { rows: await rowCount(tpl.owner), unattached: await unattachedCount(tpl.owner) };

    await caller.use(request, tpl, { email });

    const [doc] = await documentsFor(tpl.ctx.team.id, email);

    expect(doc, 'premise: the document exists').toBeTruthy();
    expect(doc.envelopeItems, 'premise: one envelope item per template item').toHaveLength(itemCount);

    expect(await rowCount(tpl.owner), `${itemCount} item(s) make exactly ${itemCount} new row(s)`).toBe(
      before.rows + itemCount,
    );
    expect(
      await unattachedCount(tpl.owner),
      `no row is left without an envelope item: ${JSON.stringify((await unattachedRowsOf(tpl.owner)).map((row) => row.id))}`,
    ).toBe(before.unattached);
  });

  test(`criterion_2_${caller.name.replace(/\W+/g, '_')}_stores_the_template_bytes_and_serves_both_versions`, async ({
    request,
  }) => {
    const tpl = await seedTemplate(request, itemCount, { label: 'use-bytes' });
    const email = uniqueEmail('use-bytes');

    await caller.use(request, tpl, { email });

    const [doc] = await documentsFor(tpl.ctx.team.id, email);
    const recipientToken = doc.recipients[0].token;

    for (const [index, item] of doc.envelopeItems.entries()) {
      const templateItem = tpl.items[index];
      const context = `item ${index} via ${caller.name}`;

      expectDataIsTemplate(await bytesOfColumn(item.documentData, 'data'), templateItem, context);
      expect(
        sha256(await bytesOfColumn(item.documentData, 'initialData')),
        `${context}: initialData is the template's bytes, exactly`,
      ).toBe(sha256(templateItem.bytes));

      const current = await recipientPdf(request, doc, recipientToken, item, 'current');
      const initial = await recipientPdf(request, doc, recipientToken, item, 'initial');

      expectDataIsTemplate(current, templateItem, `${context}, served current`);
      expect(sha256(initial), `${context}: the recipient is served the template's bytes as the initial version`).toBe(
        sha256(templateItem.bytes),
      );
    }
  });

  // API v1 create-document with formValues is criterion 4 (P2) and has its own test below.
  if (caller.name === 'API v1 create-document') {
    continue;
  }

  test(`criterion_2_${caller.name.replace(/\W+/g, '_')}_with_formValues_prefills_data_and_keeps_initialData_and_leaves_no_row`, async ({
    request,
  }) => {
    const form = FORM_FIELDS_PDF;
    const tpl = await seedTemplate(request, 1, { label: 'use-form', files: [form] });
    const email = uniqueEmail('use-form');
    const before = { rows: await rowCount(tpl.owner), unattached: await unattachedCount(tpl.owner) };

    await caller.use(request, tpl, { email, formValues: FORM_VALUES });

    const [doc] = await documentsFor(tpl.ctx.team.id, email);
    const [item] = doc.envelopeItems;
    const data = await bytesOfColumn(item.documentData, 'data');
    const initial = await bytesOfColumn(item.documentData, 'initialData');

    expect(sha256(initial), 'initialData is the template, exactly').toBe(sha256(tpl.items[0].bytes));
    expect(sha256(data), 'data is not the unfilled template').not.toBe(sha256(tpl.items[0].bytes));
    expect(textOf(data), 'data shows the prefilled value').toContain(FORM_VALUES.test_text_field);

    expect(await rowCount(tpl.owner), 'one row for the one item').toBe(before.rows + 1);
    expect(await unattachedCount(tpl.owner), 'no unattached row, with or without the prefill step').toBe(
      before.unattached,
    );
  });
}

/**
 * Criterion 4 (P2). The specification says this route "leaves one unattached row".
 * The unfixed server answers it with 401 instead, and still creates the document: its
 * handler updates `EnvelopeItem` with the id of the item's DocumentData row, so
 * Prisma throws P2025 and the middleware turns every thrown error into
 * `401 Unauthorized`. The test requires a 200 with a prefilled document, which is
 * what the criterion describes, so it fails twice over on the unfixed server.
 */
test('criterion_4_api_v1_create_document_with_formValues_answers_200_prefilled_and_leaves_no_unattached_row', async ({
  request,
}) => {
  const tpl = await seedTemplate(request, 1, { label: 'v1-formvalues', files: [FORM_FIELDS_PDF] });
  const email = uniqueEmail('v1-formvalues');
  const before = { rows: await rowCount(tpl.owner), unattached: await unattachedCount(tpl.owner) };
  const creator = USE_CALLERS.find((candidate) => candidate.name === 'API v1 create-document');

  await creator?.use(request, tpl, { email, formValues: FORM_VALUES });

  const [doc] = await documentsFor(tpl.ctx.team.id, email);
  const [item] = doc.envelopeItems;
  const data = await bytesOfColumn(item.documentData, 'data');

  expect(textOf(data), 'the recipient is served the prefilled PDF').toContain(FORM_VALUES.test_text_field);
  expect(sha256(await bytesOfColumn(item.documentData, 'initialData')), 'initialData is the template, exactly').toBe(
    sha256(tpl.items[0].bytes),
  );
  expect(await rowCount(tpl.owner), 'one row for the one item').toBe(before.rows + 1);
  expect(await unattachedCount(tpl.owner), 'unattached count unchanged').toBe(before.unattached);
});

test('criterion_1_bulk_send_makes_one_row_per_item_per_recipient_and_none_unattached', async ({ page, request }) => {
  test.setTimeout(150_000);

  const itemCount = 2;
  const tpl = await seedTemplate(request, itemCount, { label: 'bulk' });
  const emails = [uniqueEmail('bulk-a'), uniqueEmail('bulk-b')];
  const before = { rows: await rowCount(tpl.owner), unattached: await unattachedCount(tpl.owner) };

  await bulkSend(page, tpl, emails);

  expect(await rowCount(tpl.owner), `K x N = ${emails.length} x ${itemCount} new rows`).toBe(
    before.rows + emails.length * itemCount,
  );
  expect(await unattachedCount(tpl.owner), 'no row is left without an envelope item').toBe(before.unattached);
});

test('criterion_14_the_new_rows_hold_only_what_the_live_rows_hold', async ({ request }) => {
  test.skip(IS_S3, 'Under S3 rows hold object keys, so their length says nothing about stored bytes.');

  const tpl = await seedTemplate(request, 2, { label: 'weight' });
  const email = uniqueEmail('weight');
  const rowsBefore = new Set(
    (await prisma.documentData.findMany({ select: { id: true }, where: { teamId: tpl.owner.teamId } })).map(
      (row) => row.id,
    ),
  );

  await USE_CALLERS[2].use(request, tpl, { email });

  const [doc] = await documentsFor(tpl.ctx.team.id, email);
  const newRows = (await prisma.documentData.findMany({ where: { teamId: tpl.owner.teamId } })).filter(
    (row) => !rowsBefore.has(row.id),
  );
  const live = doc.envelopeItems.map((item) => item.documentDataId);

  expect(await storedCharacters(newRows.map((row) => row.id)), 'characters in the new rows').toBe(
    await storedCharacters(live),
  );
});

test('criterion_2_a_template_document_reseals_from_its_initial_data', async ({ page, request }) => {
  test.setTimeout(180_000);

  const tpl = await seedTemplate(request, 1, { label: 'reseal' });
  const email = uniqueEmail('reseal');

  await USE_CALLERS[2].use(request, tpl, { email });

  const [doc] = await documentsFor(tpl.ctx.team.id, email);
  const item = doc.envelopeItems[0];

  await distribute(request, tpl.ctx.token, doc.id);

  const fields = await prisma.field.findMany({ where: { envelopeId: doc.id } });

  await signAndComplete(
    request,
    doc.recipients[0].token,
    fields.map((field) => field.id),
    Number(doc.secondaryId.replace('document_', '')),
  );
  await waitForStatus(doc.id, DocumentStatus.COMPLETED);

  const { user: admin } = await seedUser({ isAdmin: true });

  await resealAsAdmin(page, admin.email, doc.id, item.id);

  const [after] = await itemsOfEnvelope(doc.id);
  const initial = await bytesOfColumn(after.documentData, 'initialData');

  expect(sha256(initial), 'after the reseal the item still keeps the template bytes as its initial version').toBe(
    sha256(tpl.items[0].bytes),
  );
  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(DocumentStatus.COMPLETED);
});
