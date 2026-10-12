/**
 * The one-off cleanup of unattached DocumentData rows (criteria 10, 11, 13, F1, F4, F5, F9).
 *
 * Written from the specification and its Decisions section. The script does not
 * exist yet, so these tests fail until it does. This comment is the interface
 * the implementer follows; it is repeated at the top of the specification file.
 *
 * ## Interface
 *
 * - Path: `packages/prisma/scripts/cleanup-unattached-document-data.ts`, run
 *   from `packages/prisma` as `npx tsx scripts/cleanup-unattached-document-data.ts [flags]`
 *   (an npm script `cleanup:unattached-document-data` in `packages/prisma/package.json`
 *   is welcome and is not tested). It uses the repository's Prisma client and so
 *   the database named by `NEXT_PRIVATE_DATABASE_URL` in its environment.
 * - Flags:
 *   - `--commit`: delete. Without it nothing is written.
 *   - `--older-than-days <N>`: N is a positive integer; the default is 7. A
 *     value that is missing, zero, negative, fractional or not a number makes
 *     the script exit non-zero before it reads or writes anything, with a
 *     message on stderr and no `SUMMARY` line.
 * - A row is deletable when no `EnvelopeItem` holds it and its `createdAt` is
 *   not null and is older than N days at the start of the run. A row with a null
 *   `createdAt` is listed and never deleted. A row held by an envelope item is
 *   never deleted, whatever its age. Rows of every `DocumentData.type` are
 *   handled alike, and only database rows are deleted: no storage object under
 *   S3 or Azure is touched (decision 3).
 * - The delete is one statement that re-checks "no envelope item holds it" and
 *   the age, so a row attached between the scan and the delete survives (F1, F4).
 * - Standard output, in this order:
 *   1. a line `Target database: <host>` where `<host>` is the host and port of
 *      `NEXT_PRIVATE_DATABASE_URL` as `new URL(url).host` prints it (F9). It is
 *      printed before anything is written and before any count that depends on a
 *      write;
 *   2. one line `Null createdAt (not deleted): <id>` for each unattached row
 *      with a null `createdAt`;
 *   3. in `--commit` mode, a line `Deleted <n> row(s)` once the delete is done;
 *   4. a last line `SUMMARY ` followed by one line of JSON:
 *      `{ "mode": "report" | "commit", "host": "<host>", "olderThanDays": N,
 *        "unattached": n, "deletable": n, "tooYoung": n, "nullCreatedAt": n,
 *        "byType": { "<DocumentDataType>": { "deletable": n, "tooYoung": n, "nullCreatedAt": n } },
 *        "deleted": n }`.
 *   The counts are the unattached rows found at the start; `deleted` is 0 in
 *   report mode. `unattached = deletable + tooYoung + nullCreatedAt`.
 * - Exit code 0 on success. Running it twice with `--commit` deletes nothing the
 *   second time.
 *
 * ## Tests
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | report mode writes nothing, prints host and counts by class        | 10       | F9            |
 * | --commit deletes exactly the old unattached rows; a second run     | 10       | F5            |
 * |   deletes nothing                                                  |          |               |
 * | the default is 7 days and --older-than-days changes it            | 10       |               |
 * | a bad --older-than-days refuses and writes nothing                 | 10       | F9            |
 * | the host line comes before any deletion                            | 10       | F9            |
 * | a held row older than N survives, and items, fields and archive    | 11       | F1            |
 * |   records are unchanged                                            |          |               |
 * | N boundary: just inside N survives, just outside is deleted        | 13       | F4            |
 * | an upload made just before a run and attached just after it        | 13       | F4            |
 * |   survives the run and the attach succeeds                         |          |               |
 *
 * The group runs with --workers=1, so its tests run one at a time: the script sees the whole
 * database, so a parallel test creating rows would change the global counts the
 * summary is compared with. Every expected count is read with Prisma just before
 * the run, so the comparison does not depend on what other specs left behind.
 */
// First, so the shared database is chosen before @documenso/prisma connects.
import '../../fixtures/shared-database';

import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../fixtures/authentication';
import {
  buildMarkerPdf,
  type CleanupSummary,
  DAY_MS,
  databaseHost,
  documentsFor,
  itemsOfEnvelope,
  itemsWithoutRow,
  ownerOf,
  runCleanup,
  seedDraft,
  seedTemplate,
  seedUnattachedRow,
  USE_CALLERS,
  uniqueEmail,
  uniqueMarker,
  uploadPdf,
} from '../../fixtures/orphan-document-data';

/** The classes of unattached row as the database holds them, for a cutoff of `days`. */
const expectedClasses = async (days: number) => {
  const cutoff = new Date(Date.now() - days * DAY_MS);
  const rows = await prisma.documentData.findMany({
    where: { envelopeItem: null },
    select: { id: true, type: true, createdAt: true },
  });

  const byType: CleanupSummary['byType'] = {};
  const deletableIds: string[] = [];

  for (const row of rows) {
    byType[row.type] = byType[row.type] ?? { deletable: 0, tooYoung: 0, nullCreatedAt: 0 };
    const bucket = byType[row.type];

    if (row.createdAt === null) {
      bucket.nullCreatedAt += 1;
    } else if (row.createdAt < cutoff) {
      bucket.deletable += 1;
      deletableIds.push(row.id);
    } else {
      bucket.tooYoung += 1;
    }
  }

  const sum = (key: 'deletable' | 'tooYoung' | 'nullCreatedAt') =>
    Object.values(byType).reduce((total, bucket) => total + bucket[key], 0);

  return {
    unattached: rows.length,
    deletable: sum('deletable'),
    tooYoung: sum('tooYoung'),
    nullCreatedAt: sum('nullCreatedAt'),
    byType,
    deletableIds,
  };
};

const tableCounts = async () => ({
  documentData: await prisma.documentData.count(),
  envelopeItem: await prisma.envelopeItem.count(),
  field: await prisma.field.count(),
  envelopeArchive: await prisma.envelopeArchive.count(),
});

const exists = async (id: string) => (await prisma.documentData.findUnique({ where: { id } })) !== null;

/** The four rows of criterion 10: a held row, and unattached rows that are old, young and null-dated. */
const seedFourRows = async (request: Parameters<typeof seedDraft>[0], oldAgeDays = 30, youngAgeDays = 1) => {
  const draft = await seedDraft(request, 1, { label: 'cleanup-four' });
  const owner = ownerOf(draft.ctx);
  const held = (await itemsOfEnvelope(draft.envelopeId))[0].documentData;

  await prisma.documentData.update({ where: { id: held.id }, data: { createdAt: new Date(Date.now() - 60 * DAY_MS) } });

  return {
    draft,
    owner,
    held,
    old: await seedUnattachedRow(owner, oldAgeDays * DAY_MS),
    young: await seedUnattachedRow(owner, youngAgeDays * DAY_MS),
    nullDated: await seedUnattachedRow(owner, null),
  };
};

test('criterion_10_without_commit_nothing_is_written_and_the_host_and_counts_by_class_are_printed', async ({
  request,
}) => {
  const rows = await seedFourRows(request);
  const expected = await expectedClasses(7);
  const before = await tableCounts();

  const run = await runCleanup([]);

  expect(run.code, `the script ran: ${run.stderr}`).toBe(0);
  expect(await tableCounts(), 'a run without --commit changes no row count').toEqual(before);
  expect(await exists(rows.old.id), 'the old unattached row is still there').toBe(true);

  expect(run.stdout, 'the target database host is printed').toContain(`Target database: ${databaseHost()}`);
  expect(run.stdout, 'a null-dated row is listed by id').toContain(rows.nullDated.id);

  expect(run.summary, `a SUMMARY line is printed: ${run.stdout}`).not.toBeNull();
  expect(run.summary).toMatchObject({
    mode: 'report',
    host: databaseHost(),
    olderThanDays: 7,
    unattached: expected.unattached,
    deletable: expected.deletable,
    tooYoung: expected.tooYoung,
    nullCreatedAt: expected.nullCreatedAt,
    byType: expected.byType,
    deleted: 0,
  });
  expect(expected.deletable, 'premise: the seeded old row is counted as deletable').toBeGreaterThanOrEqual(1);
});

test('criterion_10_commit_deletes_exactly_the_old_unattached_rows_and_a_second_run_deletes_nothing', async ({
  request,
}) => {
  const rows = await seedFourRows(request);
  const s3Old = await seedUnattachedRow(rows.owner, 30 * DAY_MS, { type: 'S3_PATH' });
  const expected = await expectedClasses(7);
  const before = await tableCounts();

  const first = await runCleanup(['--commit']);

  expect(first.code, `the first run: ${first.stderr}`).toBe(0);
  expect(first.summary, `a SUMMARY line is printed: ${first.stdout}`).toMatchObject({
    mode: 'commit',
    host: databaseHost(),
    deletable: expected.deletable,
    deleted: expected.deletable,
  });

  expect(await exists(rows.old.id), 'the old unattached BYTES_64 row is deleted').toBe(false);
  expect(await exists(s3Old.id), 'the old unattached S3_PATH row is deleted').toBe(false);
  expect(await exists(rows.held.id), 'the held row is kept, however old').toBe(true);
  expect(await exists(rows.young.id), 'the young unattached row is kept').toBe(true);
  expect(await exists(rows.nullDated.id), 'the row with a null createdAt is kept (F5)').toBe(true);

  const after = await tableCounts();

  expect(after.documentData, 'only the deletable rows are gone').toBe(before.documentData - expected.deletable);
  expect({ ...after, documentData: 0 }, 'items, fields and archive records are untouched').toEqual({
    ...before,
    documentData: 0,
  });

  const second = await runCleanup(['--commit']);

  expect(second.code, `the second run: ${second.stderr}`).toBe(0);
  expect(second.summary, 'the second run finds nothing to delete').toMatchObject({ deletable: 0, deleted: 0 });
  expect(await tableCounts(), 'and writes nothing').toEqual(after);
});

test('criterion_10_the_default_is_seven_days_and_older_than_days_moves_the_cutoff', async ({ request }) => {
  const draft = await seedDraft(request, 1, { label: 'cleanup-days' });
  const owner = ownerOf(draft.ctx);
  const sixDays = await seedUnattachedRow(owner, 6 * DAY_MS);
  const eightDays = await seedUnattachedRow(owner, 8 * DAY_MS);
  const twoDays = await seedUnattachedRow(owner, 2 * DAY_MS);
  const halfDay = await seedUnattachedRow(owner, DAY_MS / 2);

  const byDefault = await runCleanup(['--commit']);

  expect(byDefault.code, byDefault.stderr).toBe(0);
  expect(byDefault.summary?.olderThanDays, 'the default is 7 days').toBe(7);
  expect(await exists(eightDays.id), 'a row 8 days old is deleted by default').toBe(false);
  expect(await exists(sixDays.id), 'a row 6 days old is kept by default').toBe(true);

  const oneDay = await runCleanup(['--older-than-days', '1', '--commit']);

  expect(oneDay.code, oneDay.stderr).toBe(0);
  expect(oneDay.summary?.olderThanDays).toBe(1);
  expect(await exists(sixDays.id), 'with 1 day a row 6 days old is deleted').toBe(false);
  expect(await exists(twoDays.id), 'with 1 day a row 2 days old is deleted').toBe(false);
  expect(await exists(halfDay.id), 'with 1 day a row 12 hours old is kept').toBe(true);
});

for (const bad of [['0'], ['-3'], ['1.5'], ['abc'], []]) {
  test(`criterion_10_older_than_days_${bad.length === 0 ? 'with_no_value' : bad[0]}_is_refused_and_nothing_is_written`, async ({
    request,
  }) => {
    const draft = await seedDraft(request, 1, { label: 'cleanup-bad-days' });
    const old = await seedUnattachedRow(ownerOf(draft.ctx), 400 * DAY_MS);
    const before = await tableCounts();

    const run = await runCleanup(['--commit', '--older-than-days', ...bad]);

    expect(run.code, 'a bad value exits non-zero').not.toBe(0);
    expect(run.stderr, 'and says why on stderr, naming the flag').toContain('older-than-days');
    expect(run.summary, 'no SUMMARY line is printed').toBeNull();
    expect(await exists(old.id), 'nothing was deleted').toBe(true);
    expect(await tableCounts(), 'no row count changed').toEqual(before);

    const control = await runCleanup(['--older-than-days', '7']);

    expect(
      control.code,
      `control: a valid report run works, so the refusal above was the script's own: ${control.stderr}`,
    ).toBe(0);
  });
}

test('criterion_10_the_host_is_printed_before_any_deletion', async ({ request }) => {
  const draft = await seedDraft(request, 1, { label: 'cleanup-order' });

  await seedUnattachedRow(ownerOf(draft.ctx), 30 * DAY_MS);

  const run = await runCleanup(['--commit']);
  const lines = run.stdout.split('\n');
  const hostLine = lines.findIndex((line) => line.startsWith('Target database: '));
  const deletedLine = lines.findIndex((line) => line.startsWith('Deleted '));

  expect(run.code, run.stderr).toBe(0);
  expect(hostLine, 'a Target database line is printed').toBeGreaterThanOrEqual(0);
  expect(deletedLine, 'a Deleted line is printed in commit mode').toBeGreaterThanOrEqual(0);
  expect(hostLine, 'the host line comes before the Deleted line').toBeLessThan(deletedLine);
  expect(lines.at(-2) ?? lines.at(-1), 'the SUMMARY is the last line').toBeDefined();
  expect(
    lines
      .filter((line) => line.length > 0)
      .at(-1)
      ?.startsWith('SUMMARY '),
    'the SUMMARY is the last line',
  ).toBe(true);
});

test('criterion_11_a_run_leaves_items_fields_and_archive_records_alone_and_a_held_old_row_survives', async ({
  request,
}) => {
  const rows = await seedFourRows(request, 45);
  const items = await itemsOfEnvelope(rows.draft.envelopeId);

  for (const item of items) {
    await prisma.envelopeArchive.create({
      data: { id: `archive_${item.id}`, envelopeId: rows.draft.envelopeId, envelopeItemId: item.id },
    });
  }

  const scope = async () => ({
    items: await prisma.envelopeItem.count({ where: { envelopeId: rows.draft.envelopeId } }),
    fields: await prisma.field.count({ where: { envelopeId: rows.draft.envelopeId } }),
    archives: await prisma.envelopeArchive.count({ where: { envelopeId: rows.draft.envelopeId } }),
    rowIds: (await itemsOfEnvelope(rows.draft.envelopeId)).map((item) => item.documentDataId),
  });
  const before = await scope();

  expect(before.items, 'premise: the envelope has an item').toBe(1);
  expect(before.fields, 'premise: and a field').toBeGreaterThanOrEqual(1);

  const run = await runCleanup(['--commit']);

  expect(run.code, run.stderr).toBe(0);
  expect(await exists(rows.old.id), 'premise: the run did delete an old unattached row').toBe(false);
  expect(await scope(), 'the envelope keeps its items, fields, archive records and rows').toEqual(before);
  expect(await itemsWithoutRow(), 'every envelope item still joins to a DocumentData row').toBe(0);
});

test('criterion_13_a_row_just_inside_the_cutoff_survives_and_one_just_outside_is_deleted', async ({ request }) => {
  const draft = await seedDraft(request, 1, { label: 'cleanup-boundary' });
  const owner = ownerOf(draft.ctx);
  const inside = await seedUnattachedRow(owner, 7 * DAY_MS - 60 * 60 * 1000);
  const outside = await seedUnattachedRow(owner, 7 * DAY_MS + 60 * 60 * 1000);

  const run = await runCleanup(['--commit']);

  expect(run.code, run.stderr).toBe(0);
  expect(await exists(inside.id), 'one hour inside the cutoff: kept').toBe(true);
  expect(await exists(outside.id), 'one hour outside the cutoff: deleted').toBe(false);
});

test('criterion_13_an_upload_made_just_before_a_run_and_attached_just_after_it_survives_and_attaches', async ({
  page,
  request,
}) => {
  const tpl = await seedTemplate(request, 1, { label: 'cleanup-inflight' });
  const marker = uniqueMarker('INFLIGHT');

  await apiSignin({ page, email: tpl.ctx.user.email });

  const uploaded = await uploadPdf(page, buildMarkerPdf(marker, 2));

  const run = await runCleanup(['--commit']);

  expect(run.code, run.stderr).toBe(0);
  expect(await exists(uploaded.id), 'the fresh upload survives the run (F4)').toBe(true);

  const email = uniqueEmail('cleanup-inflight');
  const templateUse = USE_CALLERS.find((caller) => caller.name === 'API v2 template/use');

  await templateUse?.use(request, tpl, { email, customDocumentDataId: uploaded.id });

  const [doc] = await documentsFor(tpl.ctx.team.id, email);

  expect(doc, 'the create call that attaches the upload succeeds').toBeTruthy();
  expect(doc.envelopeItems, 'and made a document with its item').toHaveLength(1);
});
