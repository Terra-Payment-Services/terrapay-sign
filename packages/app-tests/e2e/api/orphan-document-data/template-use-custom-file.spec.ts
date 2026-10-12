/**
 * Using a template with a custom uploaded file must not leave the upload behind (criterion 3, P1b).
 *
 * Written from the specification before the fix.
 *
 * | Test                                                              | Criteria |
 * | ----------------------------------------------------------------- | -------- |
 * | upload-pdf then template/use with that row: the unattached count    | 3        |
 * |   returns to its value before the upload, initialData is the        |          |
 * |   uploaded bytes, the uploaded row is gone or attached              |          |
 * | envelope/use with a custom file: no unattached row, one row for     | 3        |
 * |   the item, initialData is the upload                               |          |
 * | upload-pdf then template/use, then a second use of the same         | 3        |
 * |   template without the upload: still no unattached row              |          |
 *
 * `POST /api/files/upload-pdf` records the signed-in user and no team, so rows
 * are counted by the test's user or team together. The uploaded row's bytes
 * are read before the use, so "the uploaded file's bytes" is a digest taken
 * from outside, not from the code under test.
 *
 * The unfixed server leaves the uploaded row behind in both routes, and the
 * envelope/use route leaves a second one (the row made by the normalising put,
 * read and never attached).
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../fixtures/authentication';
import {
  bearer,
  buildMarkerPdf,
  bytesOfColumn,
  documentsFor,
  rowCount,
  seedTemplate,
  sha256,
  textOf,
  USE_CALLERS,
  unattachedCount,
  uniqueEmail,
  uniqueMarker,
  uploadPdf,
  V2,
} from '../../fixtures/orphan-document-data';
import { assertVerifierToolsPresent } from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const templateUse = () => {
  const caller = USE_CALLERS.find((candidate) => candidate.name === 'API v2 template/use');

  if (!caller) {
    throw new Error('the template/use caller is missing from USE_CALLERS');
  }

  return caller;
};

test('criterion_3_template_use_with_an_uploaded_row_leaves_nothing_unattached_and_initialData_is_the_upload', async ({
  page,
  request,
}) => {
  const tpl = await seedTemplate(request, 1, { label: 'custom-trpc' });
  const marker = uniqueMarker('CUSTOM');
  const before = { rows: await rowCount(tpl.owner), unattached: await unattachedCount(tpl.owner) };

  await apiSignin({ page, email: tpl.ctx.user.email });

  const uploaded = await uploadPdf(page, buildMarkerPdf(marker, 3));
  const uploadedRow = await prisma.documentData.findUniqueOrThrow({ where: { id: uploaded.id } });
  const uploadedBytes = await bytesOfColumn(uploadedRow, 'data');

  expect(await unattachedCount(tpl.owner), 'premise: the upload is an unattached row until it is used').toBe(
    before.unattached + 1,
  );

  const email = uniqueEmail('custom-trpc');

  await templateUse().use(request, tpl, { email, customDocumentDataId: uploaded.id });

  const [doc] = await documentsFor(tpl.ctx.team.id, email);
  const [item] = doc.envelopeItems;

  expect(
    sha256(await bytesOfColumn(item.documentData, 'initialData')),
    "initialData is the uploaded file's bytes",
  ).toBe(sha256(uploadedBytes));
  expect(textOf(await bytesOfColumn(item.documentData, 'data')), 'data carries the uploaded file').toContain(marker);

  const stillThere = await prisma.documentData.findUnique({
    where: { id: uploaded.id },
    include: { envelopeItem: true },
  });

  expect(
    stillThere === null || stillThere.envelopeItem !== null,
    'the uploaded row is gone or attached to an envelope item',
  ).toBe(true);
  expect(await unattachedCount(tpl.owner), 'unattached count is back to its value before the upload').toBe(
    before.unattached,
  );
  expect(await rowCount(tpl.owner), 'the upload and the use together add one row for the one item').toBe(
    before.rows + 1,
  );
});

test('criterion_3_envelope_use_with_a_custom_file_leaves_no_unattached_row', async ({ request }) => {
  const tpl = await seedTemplate(request, 1, { label: 'custom-envelope-use' });
  const marker = uniqueMarker('CUSTOMFILE');
  const custom = buildMarkerPdf(marker, 3);
  const email = uniqueEmail('custom-envelope-use');
  const before = { rows: await rowCount(tpl.owner), unattached: await unattachedCount(tpl.owner) };

  const formData = new FormData();

  formData.append(
    'payload',
    JSON.stringify({
      envelopeId: tpl.envelopeId,
      recipients: [{ id: tpl.recipientId, email }],
      customDocumentData: [{ identifier: 0, envelopeItemId: tpl.items[0].id }],
    }),
  );
  formData.append('files', new File([custom], 'custom.pdf', { type: 'application/pdf' }));

  const res = await request.post(`${V2}/envelope/use`, { headers: bearer(tpl.ctx.token), multipart: formData });

  expect(res.ok(), `envelope/use with a custom file: ${res.status()} ${await res.text()}`).toBeTruthy();

  const [doc] = await documentsFor(tpl.ctx.team.id, email);
  const [item] = doc.envelopeItems;

  expect(textOf(await bytesOfColumn(item.documentData, 'initialData')), 'initialData is the custom file').toContain(
    marker,
  );
  expect(textOf(await bytesOfColumn(item.documentData, 'data')), 'data is the custom file').toContain(marker);
  expect(await unattachedCount(tpl.owner), 'no row is left without an envelope item').toBe(before.unattached);
  expect(await rowCount(tpl.owner), 'one row for the one item').toBe(before.rows + 1);
});

test('criterion_3_a_second_use_without_the_upload_still_leaves_nothing_unattached', async ({ page, request }) => {
  const tpl = await seedTemplate(request, 1, { label: 'custom-then-plain' });
  const before = await unattachedCount(tpl.owner);

  await apiSignin({ page, email: tpl.ctx.user.email });

  const uploaded = await uploadPdf(page, buildMarkerPdf(uniqueMarker('FIRST'), 2));

  await templateUse().use(request, tpl, { email: uniqueEmail('custom-first'), customDocumentDataId: uploaded.id });
  await templateUse().use(request, tpl, { email: uniqueEmail('custom-second') });

  expect(await unattachedCount(tpl.owner), 'two uses, one with a custom file, leave nothing unattached').toBe(before);
});

/**
 * Criterion 3b (review). An uploaded file's data id stays usable: the same
 * `customDocumentDataId` used for two template uses succeeds both times, each
 * document keeps the uploaded bytes as its initialData, and once both are made
 * the unattached count is back to its value before the upload.
 */
test('criterion_3b_the_same_uploaded_id_serves_two_template_uses', async ({ page, request }) => {
  const tpl = await seedTemplate(request, 1, { label: 'custom-twice' });
  const marker = uniqueMarker('TWICE');
  const before = await unattachedCount(tpl.owner);

  await apiSignin({ page, email: tpl.ctx.user.email });

  const uploaded = await uploadPdf(page, buildMarkerPdf(marker, 3));
  const uploadedBytes = await bytesOfColumn(
    await prisma.documentData.findUniqueOrThrow({ where: { id: uploaded.id } }),
    'data',
  );

  for (const round of ['first', 'second']) {
    const email = uniqueEmail(`custom-twice-${round}`);

    await templateUse().use(request, tpl, { email, customDocumentDataId: uploaded.id });

    const [doc] = await documentsFor(tpl.ctx.team.id, email);

    expect(doc, `the ${round} use made a document`).toBeTruthy();
    expect(
      sha256(await bytesOfColumn(doc.envelopeItems[0].documentData, 'initialData')),
      `the ${round} document has the uploaded bytes as initialData`,
    ).toBe(sha256(uploadedBytes));
    expect(textOf(await bytesOfColumn(doc.envelopeItems[0].documentData, 'data')), `${round} data`).toContain(marker);
  }

  expect(await unattachedCount(tpl.owner), 'after both uses nothing is unattached').toBe(before);
});
