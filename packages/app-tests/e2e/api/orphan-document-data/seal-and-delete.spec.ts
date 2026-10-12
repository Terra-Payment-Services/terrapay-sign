/**
 * Sealing and deleting (criteria 8 and 9, F1, F8).
 *
 * Written from the specification and its Decisions section before the fix.
 *
 * Decision 1 settles criterion 8 in its approved form: the unsealed superseded
 * row of a completed document is deleted at seal. Decision 2 settles criterion
 * 9 as a pin: a hard delete keeps the rows today, and a test says so.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | seal of a two-item document: no unattached row, the item holds     | 8        | F8            |
 * |   the sealed bytes in data and the original in initialData, the    |          |               |
 * |   unsealed row is gone                                             |          |               |
 * | reseal: the same again, and the PDF it makes is validly signed     | 8        | F8            |
 * | hard delete of a DRAFT keeps every row its items held (pinned)     | 9        |               |
 * | hard delete of a PENDING document keeps every row (pinned)         | 9        |               |
 * | hard delete of a template keeps its rows (pinned)                  | 9        |               |
 * | soft delete of a COMPLETED document keeps every row, attached      | 9        | F1            |
 * | other documents and templates are untouched by a delete (pinned)   | 9        | F1            |
 *
 * Criterion 8 names the SharePoint filing job. The filing job needs a real
 * SharePoint target and an end-to-end test cannot give it one, so what is
 * observed is what the job reads: `archive-envelope.handler.ts` reads each
 * item's DocumentData row `data` through `getFileServerSide`. The test asserts
 * that row holds the sealed bytes, that is the same bytes the signed download
 * serves, and that the row is not deleted. An `EnvelopeArchive` row is created
 * by Prisma for the item before the seal and must survive it (F1).
 *
 * Criterion 8 fails on the unfixed server, which leaves the superseded row at
 * each seal and reseal. The criterion 9 tests pass there by design; they fail
 * a change that starts deleting rows on a hard delete, which decision 2 does
 * not approve.
 */
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { DocumentStatus } from '@prisma/client';

import {
  bytesOfColumn,
  distribute,
  itemsOfEnvelope,
  jsonBearer,
  resealAsAdmin,
  rowCount,
  type SeededTemplate,
  seedDraft,
  seedTemplate,
  sha256,
  signAndComplete,
  unattachedCount,
  V2,
  waitForStatus,
} from '../../fixtures/orphan-document-data';
import {
  assertVerifierToolsPresent,
  downloadEnvelopeItem,
  readSignaturesWithPdfsig,
  SIGNATURE_VALID,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const legacyIdOf = async (envelopeId: string) =>
  Number((await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).secondaryId.replace('document_', ''));

/** Distributes the draft, signs every field and waits until each item has been sealed (its row has changed). */
const completeAndSeal = async (request: Parameters<typeof distribute>[0], draft: SeededTemplate) => {
  const before = await itemsOfEnvelope(draft.envelopeId);
  const { recipients } = await distribute(request, draft.ctx.token, draft.envelopeId);
  const fields = await prisma.field.findMany({ where: { envelopeId: draft.envelopeId } });

  await signAndComplete(
    request,
    recipients[0].token,
    fields.map((field) => field.id),
    await legacyIdOf(draft.envelopeId),
  );
  await waitForStatus(draft.envelopeId, DocumentStatus.COMPLETED);

  await expect
    .poll(
      async () =>
        (await itemsOfEnvelope(draft.envelopeId)).every(
          (item, index) => item.documentDataId !== before[index].documentDataId,
        ),
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(true);

  return { before };
};

const expectSealedItems = async (
  request: Parameters<typeof distribute>[0],
  draft: SeededTemplate,
  supersededRowIds: string[],
  context: string,
) => {
  const items = await itemsOfEnvelope(draft.envelopeId);

  for (const [index, item] of items.entries()) {
    const signed = await downloadEnvelopeItem(request, draft.ctx.token, item.id, 'signed');

    expect(
      sha256(await bytesOfColumn(item.documentData, 'data')),
      `${context}: item ${index} holds the sealed bytes in data, the bytes the signed download serves`,
    ).toBe(sha256(signed));
    expect(
      sha256(await bytesOfColumn(item.documentData, 'initialData')),
      `${context}: item ${index} keeps the original in initialData`,
    ).toBe(sha256(draft.items[index].bytes));
  }

  expect(await unattachedCount(draft.owner), `${context}: no unattached row is left by the seal`).toBe(0);

  const survivors = await prisma.documentData.findMany({ where: { id: { in: supersededRowIds } } });

  expect(
    survivors.map((row) => row.id),
    `${context}: the unsealed superseded rows are deleted`,
  ).toEqual([]);
};

test('criterion_8_a_seal_leaves_no_unattached_row_and_the_item_holds_the_sealed_bytes', async ({ request }) => {
  test.setTimeout(180_000);

  const draft = await seedDraft(request, 2, { label: 'seal-orphan' });
  const itemsBefore = await itemsOfEnvelope(draft.envelopeId);

  for (const item of itemsBefore) {
    await prisma.envelopeArchive.create({
      data: { id: `archive_${item.id}`, envelopeId: draft.envelopeId, envelopeItemId: item.id },
    });
  }

  const { before } = await completeAndSeal(request, draft);

  await expectSealedItems(
    request,
    draft,
    before.map((item) => item.documentDataId),
    'seal',
  );

  expect(
    await prisma.envelopeArchive.count({ where: { envelopeId: draft.envelopeId } }),
    'the archive records survive the seal',
  ).toBe(2);
  expect(await prisma.envelopeItem.count({ where: { envelopeId: draft.envelopeId } }), 'both items survive').toBe(2);
});

test('criterion_8_a_reseal_leaves_no_unattached_row_and_signs_validly', async ({ page, request }) => {
  test.setTimeout(240_000);

  const draft = await seedDraft(request, 2, { label: 'reseal-orphan' });

  await completeAndSeal(request, draft);

  const afterSeal = await itemsOfEnvelope(draft.envelopeId);
  const { user: admin } = await seedUser({ isAdmin: true });

  await resealAsAdmin(page, admin.email, draft.envelopeId, afterSeal[0].id);

  await expect
    .poll(
      async () =>
        (await itemsOfEnvelope(draft.envelopeId)).every(
          (item, index) => item.documentDataId !== afterSeal[index].documentDataId,
        ),
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(true);

  await expectSealedItems(
    request,
    draft,
    afterSeal.map((item) => item.documentDataId),
    'reseal',
  );

  for (const item of await itemsOfEnvelope(draft.envelopeId)) {
    const signed = await downloadEnvelopeItem(request, draft.ctx.token, item.id, 'signed');
    const signatures = readSignaturesWithPdfsig(signed).filter((signature) => signature.validation !== '');

    expect(signatures.length, 'the resealed PDF carries a signature').toBeGreaterThanOrEqual(1);

    for (const signature of signatures) {
      expect(signature.validation).toBe(SIGNATURE_VALID);
    }
  }
});

const rowIdsOf = async (envelopeId: string) =>
  (await itemsOfEnvelope(envelopeId)).map((item) => item.documentDataId).sort();

const expectRowsKeptButUnattached = async (rowIds: string[], context: string) => {
  const rows = await prisma.documentData.findMany({ where: { id: { in: rowIds } }, include: { envelopeItem: true } });

  expect(rows.map((row) => row.id).sort(), `${context}: every row the items held still exists`).toEqual(rowIds);
  expect(
    rows.filter((row) => row.envelopeItem !== null),
    `${context}: and no envelope item holds it any longer`,
  ).toEqual([]);
};

const deleteEnvelope = async (request: Parameters<typeof distribute>[0], token: string, envelopeId: string) => {
  const res = await request.post(`${V2}/envelope/delete`, { headers: jsonBearer(token), data: { envelopeId } });

  expect(res.ok(), `envelope/delete: ${res.status()} ${await res.text()}`).toBeTruthy();
};

test('criterion_9_pinned_a_hard_delete_of_a_draft_keeps_its_rows_and_touches_no_other_document', async ({
  request,
}) => {
  const draft = await seedDraft(request, 2, { label: 'delete-draft' });
  const other = await seedDraft(request, 1, { label: 'delete-draft-other', ctx: draft.ctx });
  const template = await seedTemplate(request, 1, { label: 'delete-draft-template', ctx: draft.ctx });
  const rowIds = await rowIdsOf(draft.envelopeId);
  const otherRows = await rowIdsOf(other.envelopeId);
  const templateRows = await rowIdsOf(template.envelopeId);
  const before = { rows: await rowCount(draft.owner), unattached: await unattachedCount(draft.owner) };

  await deleteEnvelope(request, draft.ctx.token, draft.envelopeId);

  expect(await prisma.envelope.findUnique({ where: { id: draft.envelopeId } }), 'the draft is hard deleted').toBeNull();
  await expectRowsKeptButUnattached(rowIds, 'draft');
  expect(await rowCount(draft.owner), 'no row is deleted').toBe(before.rows);
  expect(await unattachedCount(draft.owner), 'the two rows become unattached').toBe(before.unattached + 2);
  expect(await rowIdsOf(other.envelopeId), 'another document is untouched').toEqual(otherRows);
  expect(await rowIdsOf(template.envelopeId), 'a template is untouched').toEqual(templateRows);
});

test('criterion_9_pinned_a_hard_delete_of_a_pending_document_keeps_its_rows', async ({ request }) => {
  const doc = await seedDraft(request, 1, { label: 'delete-pending' });

  await distribute(request, doc.ctx.token, doc.envelopeId);

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: doc.envelopeId } })).status).toBe(
    DocumentStatus.PENDING,
  );

  const rowIds = await rowIdsOf(doc.envelopeId);

  await deleteEnvelope(request, doc.ctx.token, doc.envelopeId);

  expect(
    await prisma.envelope.findUnique({ where: { id: doc.envelopeId } }),
    'the document is hard deleted',
  ).toBeNull();
  await expectRowsKeptButUnattached(rowIds, 'pending document');
});

test('criterion_9_pinned_deleting_a_template_keeps_its_rows', async ({ request }) => {
  const template = await seedTemplate(request, 2, { label: 'delete-template' });
  const rowIds = await rowIdsOf(template.envelopeId);

  await deleteEnvelope(request, template.ctx.token, template.envelopeId);

  expect(
    await prisma.envelope.findUnique({ where: { id: template.envelopeId } }),
    'the template is deleted',
  ).toBeNull();
  await expectRowsKeptButUnattached(rowIds, 'template');
});

test('criterion_9_a_soft_delete_of_a_completed_document_keeps_every_row_attached', async ({ request }) => {
  test.setTimeout(180_000);

  const draft = await seedDraft(request, 1, { label: 'delete-completed' });

  await completeAndSeal(request, draft);

  const rowIds = await rowIdsOf(draft.envelopeId);
  const before = { rows: await rowCount(draft.owner), unattached: await unattachedCount(draft.owner) };

  await deleteEnvelope(request, draft.ctx.token, draft.envelopeId);

  const envelope = await prisma.envelope.findUnique({ where: { id: draft.envelopeId } });

  expect(envelope?.deletedAt, 'the completed document is soft deleted').not.toBeNull();
  expect(await rowIdsOf(draft.envelopeId), 'its items still hold the same rows').toEqual(rowIds);
  expect(await rowCount(draft.owner), 'no row is deleted').toBe(before.rows);
  expect(await unattachedCount(draft.owner), 'no row becomes unattached').toBe(before.unattached);
});
