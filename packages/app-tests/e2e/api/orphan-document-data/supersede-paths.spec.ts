/**
 * Paths that replace the PDF of an item must not leave the old row behind (criteria 5, 6, 7, F6).
 *
 * Written from the specification before the fix.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | send of a DRAFT with formValues: prefilled, one row, none          | 5        |               |
 * |   unattached                                                       |          |               |
 * | placeholders, first call: whitened PDF held, none unattached       | 6        |               |
 * | placeholders, second call: the same again                         | 6        |               |
 * | placeholder call that fails: item keeps its row and bytes,         | 6        | F6            |
 * |   nothing unattached by the request                                |          |               |
 * | replace the PDF of an item: new bytes held, nothing unattached     | 7        |               |
 * | delete an envelope item: nothing unattached                        | 7        |               |
 * | S3 only: after replace and after delete no object is gone          | 7        |               |
 *
 * Criteria 5 and 6 fail on the unfixed server, which leaves the superseded
 * row. Criterion 7 describes behaviour that must not change (the specification
 * says replace and delete leave no row today), so those tests pass before the
 * fix and guard against the fix deleting an object. The failing placeholder
 * request is the one in which an item must still point at a row that exists;
 * on the unfixed server it passes, and it fails a change that deletes the old
 * row before the transaction that repoints the item has committed.
 *
 * "Whitened" is judged by rendering the page with poppler and counting ink in
 * the placeholder's own rectangle, as the placeholder specs do.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../fixtures/authentication';
import {
  bytesOfColumn,
  distribute,
  IS_S3,
  itemsOfEnvelope,
  jsonBearer,
  listObjects,
  rowCount,
  seedDraft,
  textOf,
  unattachedCount,
  V2,
  WEBAPP_URL,
} from '../../fixtures/orphan-document-data';
import {
  buildPlaceholderPdf,
  createFields,
  inkInRect,
  PLACEHOLDER_A,
  PLACEHOLDER_B,
  placeholderField,
  uniqueMarker as placeholderMarker,
  readCurrentItemPdf,
  renderPageGrey,
  seedPlaceholderDraft,
} from '../../fixtures/placeholder-fields';
import { assertVerifierToolsPresent, FORM_FIELDS_PDF, FORM_VALUES } from '../../fixtures/protected-pdfs';
import { buildMarkerPdf, uniqueMarker } from '../../fixtures/two-step-upload';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

test('criterion_5_sending_a_draft_with_formValues_leaves_no_unattached_row', async ({ request }) => {
  const draft = await seedDraft(request, 1, {
    label: 'send-formvalues',
    files: [FORM_FIELDS_PDF],
    formValues: FORM_VALUES,
  });
  const before = { rows: await rowCount(draft.owner), unattached: await unattachedCount(draft.owner) };

  await distribute(request, draft.ctx.token, draft.envelopeId);

  const [item] = await itemsOfEnvelope(draft.envelopeId);

  expect(textOf(await bytesOfColumn(item.documentData, 'data')), 'the item holds the prefilled PDF').toContain(
    FORM_VALUES.test_text_field,
  );
  expect(await unattachedCount(draft.owner), 'the send leaves no row without an envelope item').toBe(before.unattached);
  expect(await rowCount(draft.owner), "the item's row is the only row for it").toBe(before.rows);
});

const rectOfFieldFor = async (envelopeId: string, type: string) =>
  await prisma.field.findFirstOrThrow({ where: { envelopeId, type: type as never } });

test('criterion_6_placeholder_fields_leave_no_unattached_row_on_the_first_call_and_the_second', async ({ request }) => {
  const marker = placeholderMarker();
  const seeded = await seedPlaceholderDraft(request, 'placeholder-orphan', await buildPlaceholderPdf(marker));
  const owner = { userId: seeded.user.id, teamId: seeded.team.id };
  const [item] = await itemsOfEnvelope(seeded.envelopeId);
  const before = { rows: await rowCount(owner), unattached: await unattachedCount(owner) };

  const first = await createFields(request, seeded.token, seeded.envelopeId, [
    placeholderField(seeded.recipientId, PLACEHOLDER_A),
  ]);

  expect(first.ok(), `first placeholder call: ${await first.text()}`).toBeTruthy();

  const afterFirst = await readCurrentItemPdf(item.id);
  const fieldA = await rectOfFieldFor(seeded.envelopeId, 'SIGNATURE');

  expect(inkInRect(renderPageGrey(afterFirst.bytes), fieldA), 'placeholder A is whitened out').toBe(0);
  expect(await unattachedCount(owner), 'first call: no unattached row').toBe(before.unattached);
  expect(await rowCount(owner), 'first call: one row for the one item').toBe(before.rows);

  const second = await createFields(request, seeded.token, seeded.envelopeId, [
    placeholderField(seeded.recipientId, PLACEHOLDER_B),
  ]);

  expect(second.ok(), `second placeholder call: ${await second.text()}`).toBeTruthy();

  const afterSecond = await readCurrentItemPdf(item.id);
  const fieldB = await rectOfFieldFor(seeded.envelopeId, 'INITIALS');

  expect(inkInRect(renderPageGrey(afterSecond.bytes), fieldB), 'placeholder B is whitened out').toBe(0);
  expect(inkInRect(renderPageGrey(afterSecond.bytes), fieldA), 'placeholder A is still whitened out').toBe(0);
  expect(await unattachedCount(owner), 'second call: no unattached row').toBe(before.unattached);
  expect(await rowCount(owner), 'second call: still one row for the one item').toBe(before.rows);
});

test('criterion_6_a_failed_placeholder_request_leaves_the_item_on_a_row_that_exists_with_its_bytes', async ({
  request,
}) => {
  const marker = placeholderMarker();
  const seeded = await seedPlaceholderDraft(request, 'placeholder-failed', await buildPlaceholderPdf(marker));
  const [item] = await itemsOfEnvelope(seeded.envelopeId);
  const before = await readCurrentItemPdf(item.id);

  // A placeholder that is found, and a field for a recipient who is not on the envelope.
  const res = await createFields(request, seeded.token, seeded.envelopeId, [
    placeholderField(seeded.recipientId, PLACEHOLDER_A),
    { recipientId: 2_000_000_000, type: 'SIGNATURE', placeholder: PLACEHOLDER_B },
  ]);

  expect(res.ok(), 'premise: the request is refused').toBe(false);

  const after = await readCurrentItemPdf(item.id);
  const row = await prisma.documentData.findUnique({ where: { id: after.documentDataId } });

  expect(row, 'the item points at a row that exists').not.toBeNull();
  expect(after.documentDataId, 'the item still points at the row it had').toBe(before.documentDataId);
  expect(Buffer.from(after.bytes).equals(Buffer.from(before.bytes)), 'and its bytes are unchanged').toBe(true);
});

test('criterion_7_replacing_the_pdf_of_an_item_leaves_nothing_unattached_and_no_object_is_deleted', async ({
  page,
  request,
}) => {
  const draft = await seedDraft(request, 1, { label: 'replace-pdf' });
  const marker = uniqueMarker('REPLACED');
  const objectsBefore = IS_S3 ? await listObjects() : [];
  const before = { rows: await rowCount(draft.owner), unattached: await unattachedCount(draft.owner) };

  await apiSignin({ page, email: draft.ctx.user.email });

  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId: draft.envelopeId, envelopeItemId: draft.items[0].id }));
  formData.append('file', new File([buildMarkerPdf(marker, 2)], 'replacement.pdf', { type: 'application/pdf' }));

  const res = await page.request.post(`${WEBAPP_URL}/api/trpc/envelope.item.replacePdf`, {
    headers: { 'x-team-id': String(draft.owner.teamId) },
    multipart: formData,
  });

  expect(res.ok(), `envelope.item.replacePdf: ${res.status()} ${await res.text()}`).toBeTruthy();

  const [item] = await itemsOfEnvelope(draft.envelopeId);

  expect(textOf(await bytesOfColumn(item.documentData, 'data')), "the item holds the new file's bytes").toContain(
    marker,
  );
  expect(await unattachedCount(draft.owner), 'nothing is left unattached').toBe(before.unattached);
  expect(await rowCount(draft.owner), 'one row for the one item').toBe(before.rows);

  if (IS_S3) {
    const after = new Set((await listObjects()).map((object) => object.key));

    expect(
      objectsBefore.filter((object) => !after.has(object.key)).map((object) => object.key),
      'no object that existed before the replace is gone',
    ).toEqual([]);
  }
});

test('criterion_7_deleting_an_envelope_item_leaves_nothing_unattached_and_no_object_is_deleted', async ({
  request,
}) => {
  const draft = await seedDraft(request, 2, { label: 'delete-item' });
  const objectsBefore = IS_S3 ? await listObjects() : [];
  const before = { rows: await rowCount(draft.owner), unattached: await unattachedCount(draft.owner) };

  const res = await request.post(`${V2}/envelope/item/delete`, {
    headers: jsonBearer(draft.ctx.token),
    data: { envelopeId: draft.envelopeId, envelopeItemId: draft.items[1].id },
  });

  expect(res.ok(), `envelope/item/delete: ${res.status()} ${await res.text()}`).toBeTruthy();

  const items = await itemsOfEnvelope(draft.envelopeId);

  expect(
    items.map((item) => item.id),
    'the other item is held',
  ).toEqual([draft.items[0].id]);
  expect(await unattachedCount(draft.owner), 'nothing is left unattached').toBe(before.unattached);
  expect(await rowCount(draft.owner), "the deleted item's row goes with it").toBe(before.rows - 1);

  if (IS_S3) {
    const after = new Set((await listObjects()).map((object) => object.key));

    expect(
      objectsBefore.filter((object) => !after.has(object.key)).map((object) => object.key),
      'no object that existed before the delete is gone',
    ).toEqual([]);
  }
});

/**
 * Criterion 5b (review). A DRAFT send with formValues must not overwrite an item
 * whose PDF changed after the send read it. Against a concurrent PDF replacement
 * or a second send, after every round: the item holds exactly one row, that
 * row's bytes are an allowed outcome, and nothing is left unattached. A
 * replacement that was accepted must not be lost to the send.
 */
const ROUNDS = 8;

test('criterion_5b_a_send_racing_a_pdf_replacement_never_loses_the_newer_pdf_or_leaves_a_row', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  const first = await seedDraft(request, 1, {
    label: 'race-replace',
    files: [FORM_FIELDS_PDF],
    formValues: FORM_VALUES,
  });

  await apiSignin({ page, email: first.ctx.user.email });

  const failures: string[] = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    const draft =
      round === 0
        ? first
        : await seedDraft(request, 1, {
            ctx: first.ctx,
            label: 'race-replace',
            files: [FORM_FIELDS_PDF],
            formValues: FORM_VALUES,
          });
    const marker = uniqueMarker('NEWER');
    const before = { rows: await rowCount(draft.owner), unattached: await unattachedCount(draft.owner) };
    const formData = new FormData();

    formData.append('payload', JSON.stringify({ envelopeId: draft.envelopeId, envelopeItemId: draft.items[0].id }));
    formData.append('file', new File([buildMarkerPdf(marker, 2)], 'newer.pdf', { type: 'application/pdf' }));

    const [send, replace] = await Promise.all([
      request.post(`${V2}/envelope/distribute`, {
        headers: jsonBearer(draft.ctx.token),
        data: { envelopeId: draft.envelopeId },
      }),
      page.request.post(`${WEBAPP_URL}/api/trpc/envelope.item.replacePdf`, {
        headers: { 'x-team-id': String(draft.owner.teamId) },
        multipart: formData,
      }),
    ]);

    const items = await itemsOfEnvelope(draft.envelopeId);
    const text = textOf(await bytesOfColumn(items[0].documentData, 'data'));
    const context = `round ${round}: send ${send.status()}, replace ${replace.status()}`;
    const unattached = await unattachedCount(draft.owner);
    const rows = await rowCount(draft.owner);

    if (items.length !== 1) {
      failures.push(`${context}: ${items.length} items`);
    }
    if (unattached !== before.unattached) {
      failures.push(`${context}: unattached ${before.unattached} -> ${unattached}`);
    }
    if (rows !== before.rows) {
      failures.push(`${context}: rows ${before.rows} -> ${rows}`);
    }
    // An accepted replacement is the newer PDF and must be what the item holds.
    if (replace.ok() && !text.includes(marker)) {
      failures.push(`${context}: the accepted replacement was lost`);
    }
    // Otherwise the item holds the original, prefilled if the send finished.
    if (!replace.ok() && !text.includes(FORM_VALUES.test_text_field) && send.ok()) {
      failures.push(`${context}: the send succeeded and the item is not prefilled`);
    }
  }

  expect(failures, 'every round ends consistent').toEqual([]);
});

test('criterion_5b_two_concurrent_sends_leave_one_prefilled_row_and_nothing_unattached', async ({ request }) => {
  test.setTimeout(300_000);

  const first = await seedDraft(request, 1, { label: 'race-send', files: [FORM_FIELDS_PDF], formValues: FORM_VALUES });
  const failures: string[] = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    const draft =
      round === 0
        ? first
        : await seedDraft(request, 1, {
            ctx: first.ctx,
            label: 'race-send',
            files: [FORM_FIELDS_PDF],
            formValues: FORM_VALUES,
          });
    const before = { rows: await rowCount(draft.owner), unattached: await unattachedCount(draft.owner) };
    const send = () =>
      request.post(`${V2}/envelope/distribute`, {
        headers: jsonBearer(draft.ctx.token),
        data: { envelopeId: draft.envelopeId },
      });

    const [a, b] = await Promise.all([send(), send()]);
    const items = await itemsOfEnvelope(draft.envelopeId);
    const text = textOf(await bytesOfColumn(items[0].documentData, 'data'));
    const context = `round ${round}: sends ${a.status()} and ${b.status()}`;
    const unattached = await unattachedCount(draft.owner);
    const rows = await rowCount(draft.owner);

    if (!a.ok() && !b.ok()) {
      failures.push(`${context}: both sends failed`);
    }
    if (items.length !== 1) {
      failures.push(`${context}: ${items.length} items`);
    }
    if (unattached !== before.unattached) {
      failures.push(`${context}: unattached ${before.unattached} -> ${unattached}`);
    }
    if (rows !== before.rows) {
      failures.push(`${context}: rows ${before.rows} -> ${rows}`);
    }
    if (!text.includes(FORM_VALUES.test_text_field)) {
      failures.push(`${context}: the item is not prefilled`);
    }
  }

  expect(failures, 'every round ends consistent').toEqual([]);
});
