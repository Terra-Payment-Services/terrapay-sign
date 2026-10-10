/**
 * Stored revisions after a placeholder field request (criteria 3 and 4).
 *
 * Written from the specification alone, without reading the implementation of
 * create-envelope-fields.ts.
 *
 * A placeholder field request whites out the placeholder and stores the result
 * as a new DocumentData revision of the item. When the request fails after that
 * revision is staged, nothing it created may remain and the item must still
 * point at its previous revision (F3, F4). When it succeeds, it leaves exactly
 * one new revision per item it changed (criterion 4).
 *
 * Criterion 3 asks for a failure after staging, through the public API alone.
 * Each test sends a placeholder field that is found, and would stage a
 * revision on its own, together with a second entry that makes the request
 * fail: a placeholder missing from a second item, a placeholder missing from
 * the same item, a placeholder field for a recipient not on the envelope, or a
 * coordinate field for such a recipient. Without reading the implementation
 * there is no way to know from outside at which step each of these fails, so
 * all four are kept; one that fails before staging passes on any code and is
 * still a valid check of F3 and F4. Each test then sends the found placeholder
 * alone and expects 200, which shows the first entry was valid.
 *
 * On the unfixed code all four answer before anything is staged (red run,
 * 2026-10-07), so they pass there. The one public-API path found that fails a
 * request after staging is a transaction failure: two concurrent placeholder
 * requests on one item (the concurrent-placeholder race) sometimes end with one of them refused
 * with a database deadlock raised from the envelope item update, which is
 * inside the transaction and so after the whiteout PDF was stored. The
 * concurrent test repeats the pair on fresh drafts and, in every round where
 * exactly one request failed, requires that the only new DocumentData row is
 * the revision the surviving request left on the item. A round where both
 * succeed or both fail says nothing about criterion 3 and is not judged here.
 * On the unfixed code about one round in ten fails one request, so the test
 * tries up to 40 rounds and stops after two judged ones.
 * If no round produces a failure (a fix that serialises the requests may
 * never fail one), the test records that in an annotation and passes, since
 * criterion 3 is then not reachable by this path.
 *
 * DocumentData rows belonging to the test are found two ways (see
 * documentDataOfTest): rows owned by the test's user or team, and rows written
 * during the test whose PDF carries the test's unique marker text. A row is
 * "created by the request" when it is in that set after the request and was
 * not before.
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | found placeholder + placeholder missing on a second item       | 3        | F3, F4        |
 * | found placeholder + placeholder missing on the same item       | 3        | F3, F4        |
 * | found placeholder + placeholder field for an unknown recipient | 3        | F3, F4        |
 * | found placeholder + coordinate field for an unknown recipient  | 3        | F3, F4        |
 * | concurrent pair where one request fails in its transaction:    | 3        | F3            |
 * |   only the survivor's revision remains                         |          |               |
 * | two placeholders on one item: one new revision                 | 4        | F3            |
 * | placeholders on two items: one new revision each               | 4        | F3            |
 * | placeholder on one item + coordinate field on another: one     | 4        | F3            |
 * |   new revision, the other item unchanged                       |          |               |
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import {
  buildPlaceholderPdf,
  createFields,
  databaseNow,
  documentDataOfTest,
  PLACEHOLDER_A,
  PLACEHOLDER_B,
  placeholderField,
  seedPlaceholderDraft,
  uniqueMarker,
} from '../../fixtures/placeholder-fields';
import { API_BASE_URL, assertVerifierToolsPresent } from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const NO_SUCH_RECIPIENT_ID = 2_000_000_000;

/** Rounds of the concurrent pair to try, stopping once JUDGED_ROUNDS_WANTED rounds had one failed request. */
const CONCURRENT_ROUNDS = 40;
const JUDGED_ROUNDS_WANTED = 2;

const addItem = async (request: APIRequestContext, token: string, envelopeId: string, file: Buffer) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId }));
  formData.append('files', new File([file], 'second-item.pdf', { type: 'application/pdf' }));

  const res = await request.post(`${API_BASE_URL}/envelope/item/create-many`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });

  expect(res.ok(), `envelope/item/create-many: ${await res.text()}`).toBeTruthy();
};

/**
 * A draft whose first item holds placeholders A and B, and, when asked, a
 * second item holding `secondItemPlaceholders`. Both carry the test's marker.
 */
const seed = async (request: APIRequestContext, label: string, secondItemPlaceholders?: string[]) => {
  const marker = uniqueMarker();
  const context = await seedPlaceholderDraft(request, label, await buildPlaceholderPdf(marker));

  if (secondItemPlaceholders) {
    await addItem(
      request,
      context.token,
      context.envelopeId,
      await buildPlaceholderPdf(marker, secondItemPlaceholders),
    );
  }

  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId: context.envelopeId },
    orderBy: { order: 'asc' },
  });

  expect(items, 'premise: the envelope holds the expected items').toHaveLength(secondItemPlaceholders ? 2 : 1);

  return { ...context, marker, items };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Sends one field request and reports the DocumentData rows it created and where each item points afterwards. */
const sendAndObserve = async (request: APIRequestContext, seeded: Seeded, data: Array<Record<string, unknown>>) => {
  const owner = { userId: seeded.user.id, teamId: seeded.team.id, marker: seeded.marker };
  const since = await databaseNow();
  const before = await documentDataOfTest({ ...owner, since });

  const res = await createFields(request, seeded.token, seeded.envelopeId, data);
  const text = await res.text();

  const after = await documentDataOfTest({ ...owner, since });
  const created = [...after].filter((id) => !before.has(id));
  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId: seeded.envelopeId },
    orderBy: { order: 'asc' },
  });

  test.info().annotations.push({
    type: 'field request',
    description: JSON.stringify({ status: res.status(), body: text.slice(0, 400), created }),
  });

  return { res, text, created, items };
};

const expectNothingLeftBehind = async (seeded: Seeded, observed: Awaited<ReturnType<typeof sendAndObserve>>) => {
  const { res, text, created, items } = observed;

  expect(res.ok(), `premise: the request must fail: ${text}`).toBeFalsy();
  expect(await prisma.field.count({ where: { envelopeId: seeded.envelopeId } }), 'no field is saved').toBe(0);

  // F3: an orphaned revision.
  expect(created, 'no DocumentData row created by the failed request remains').toEqual([]);

  // F4: the item moved to a new revision anyway.
  for (const [index, item] of items.entries()) {
    expect(item.documentDataId, `item ${index + 1} still points at its previous revision`).toBe(
      seeded.items[index].documentDataId,
    );
  }
};

const expectFoundPlaceholderAloneSucceeds = async (request: APIRequestContext, seeded: Seeded) => {
  const control = await createFields(request, seeded.token, seeded.envelopeId, [
    placeholderField(seeded.recipientId, PLACEHOLDER_A),
  ]);

  expect(control.status(), `control: the found placeholder alone is accepted: ${await control.text()}`).toBe(200);
};

test('criterion_3_request_failing_on_a_placeholder_missing_from_a_second_item_leaves_no_document_data_and_keeps_the_revision', async ({
  request,
}) => {
  const seeded = await seed(request, 'pf-fail-second-item', []);

  const observed = await sendAndObserve(request, seeded, [
    { ...placeholderField(seeded.recipientId, PLACEHOLDER_A), envelopeItemId: seeded.items[0].id },
    { ...placeholderField(seeded.recipientId, PLACEHOLDER_B), envelopeItemId: seeded.items[1].id },
  ]);

  await expectNothingLeftBehind(seeded, observed);
  await expectFoundPlaceholderAloneSucceeds(request, seeded);
});

test('criterion_3_request_failing_on_a_placeholder_missing_from_the_same_item_leaves_no_document_data_and_keeps_the_revision', async ({
  request,
}) => {
  const seeded = await seed(request, 'pf-fail-same-item');

  const observed = await sendAndObserve(request, seeded, [
    placeholderField(seeded.recipientId, PLACEHOLDER_A),
    { recipientId: seeded.recipientId, type: FieldType.TEXT, placeholder: '{{nonexistent}}' },
  ]);

  await expectNothingLeftBehind(seeded, observed);
  await expectFoundPlaceholderAloneSucceeds(request, seeded);
});

test('criterion_3_request_failing_on_a_placeholder_field_for_an_unknown_recipient_leaves_no_document_data_and_keeps_the_revision', async ({
  request,
}) => {
  const seeded = await seed(request, 'pf-fail-recipient-placeholder');

  const observed = await sendAndObserve(request, seeded, [
    placeholderField(seeded.recipientId, PLACEHOLDER_A),
    placeholderField(NO_SUCH_RECIPIENT_ID, PLACEHOLDER_B),
  ]);

  await expectNothingLeftBehind(seeded, observed);
  await expectFoundPlaceholderAloneSucceeds(request, seeded);
});

test('criterion_3_request_failing_on_a_coordinate_field_for_an_unknown_recipient_leaves_no_document_data_and_keeps_the_revision', async ({
  request,
}) => {
  const seeded = await seed(request, 'pf-fail-recipient-coordinate');

  const observed = await sendAndObserve(request, seeded, [
    placeholderField(seeded.recipientId, PLACEHOLDER_A),
    {
      recipientId: NO_SUCH_RECIPIENT_ID,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: 10,
      positionY: 80,
      width: 15,
      height: 5,
    },
  ]);

  await expectNothingLeftBehind(seeded, observed);
  await expectFoundPlaceholderAloneSucceeds(request, seeded);
});

test('criterion_3_request_failing_in_its_transaction_under_concurrency_leaves_no_document_data', async ({
  request,
}) => {
  test.setTimeout(240_000);

  const violations: string[] = [];
  let judgedRounds = 0;

  for (let round = 1; round <= CONCURRENT_ROUNDS; round += 1) {
    const seeded = await seed(request, `pf-fail-concurrent-${round}`);
    const owner = { userId: seeded.user.id, teamId: seeded.team.id, marker: seeded.marker };
    const since = await databaseNow();
    const before = await documentDataOfTest({ ...owner, since });

    const responses = await Promise.all(
      [PLACEHOLDER_A, PLACEHOLDER_B].map(
        async (placeholder) =>
          await createFields(request, seeded.token, seeded.envelopeId, [
            placeholderField(seeded.recipientId, placeholder as typeof PLACEHOLDER_A | typeof PLACEHOLDER_B),
          ]),
      ),
    );

    const after = await documentDataOfTest({ ...owner, since });
    const created = [...after].filter((id) => !before.has(id));
    const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: seeded.items[0].id } });
    const failed = responses.filter((res) => !res.ok());

    test.info().annotations.push({
      type: `round ${round}`,
      description: JSON.stringify({
        statuses: responses.map((res) => res.status()),
        created,
        item: item.documentDataId,
      }),
    });

    if (failed.length !== 1) {
      continue;
    }

    judgedRounds += 1;

    const failure = (await failed[0].text()).slice(0, 200);

    // F3: the failed request's staged revision is still stored.
    if (JSON.stringify(created) !== JSON.stringify([item.documentDataId])) {
      violations.push(
        `round ${round}: one request failed (${failed[0].status()} ${failure}); new DocumentData rows ${JSON.stringify(created)}, but only the survivor's revision ${item.documentDataId} may remain`,
      );
    }

    if (judgedRounds >= JUDGED_ROUNDS_WANTED) {
      break;
    }
  }

  test.info().annotations.push({
    type: 'rounds judged',
    description:
      judgedRounds === 0
        ? `no round out of ${CONCURRENT_ROUNDS} tried had exactly one failed request, so criterion 3 was not exercised by this path`
        : `${judgedRounds} judged rounds had exactly one failed request`,
  });

  expect(violations, 'DocumentData left behind by a request that failed in its transaction').toEqual([]);
});

test('criterion_4_two_placeholders_on_one_item_leave_exactly_one_new_revision', async ({ request }) => {
  const seeded = await seed(request, 'pf-ok-one-item');

  const { res, text, created, items } = await sendAndObserve(request, seeded, [
    placeholderField(seeded.recipientId, PLACEHOLDER_A),
    placeholderField(seeded.recipientId, PLACEHOLDER_B),
  ]);

  expect(res.status(), text).toBe(200);
  expect(items[0].documentDataId, 'the item moved to a new revision').not.toBe(seeded.items[0].documentDataId);
  expect(created, 'exactly one new DocumentData row, the one the item now points at').toEqual([
    items[0].documentDataId,
  ]);
});

test('criterion_4_placeholders_on_two_items_leave_exactly_one_new_revision_each', async ({ request }) => {
  const seeded = await seed(request, 'pf-ok-two-items', [PLACEHOLDER_B]);

  const { res, text, created, items } = await sendAndObserve(request, seeded, [
    { ...placeholderField(seeded.recipientId, PLACEHOLDER_A), envelopeItemId: seeded.items[0].id },
    { ...placeholderField(seeded.recipientId, PLACEHOLDER_B), envelopeItemId: seeded.items[1].id },
  ]);

  expect(res.status(), text).toBe(200);

  for (const [index, item] of items.entries()) {
    expect(item.documentDataId, `item ${index + 1} moved to a new revision`).not.toBe(
      seeded.items[index].documentDataId,
    );
  }

  expect(created.sort(), 'exactly one new DocumentData row per changed item, and no others').toEqual(
    items.map((item) => item.documentDataId).sort(),
  );
});

test('criterion_4_placeholder_on_one_item_and_coordinate_field_on_another_leave_one_new_revision', async ({
  request,
}) => {
  const seeded = await seed(request, 'pf-ok-mixed', []);

  const { res, text, created, items } = await sendAndObserve(request, seeded, [
    { ...placeholderField(seeded.recipientId, PLACEHOLDER_A), envelopeItemId: seeded.items[0].id },
    {
      recipientId: seeded.recipientId,
      envelopeItemId: seeded.items[1].id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: 10,
      positionY: 80,
      width: 15,
      height: 5,
    },
  ]);

  expect(res.status(), text).toBe(200);
  expect(items[1].documentDataId, 'the item with only a coordinate field is unchanged').toBe(
    seeded.items[1].documentDataId,
  );
  expect(created, 'exactly one new DocumentData row, for the item whose placeholder was whited out').toEqual([
    items[0].documentDataId,
  ]);
});
