/**
 * Delete DocumentData rows that no envelope item holds and that are older than
 * a cutoff. A one-off for the rows the application left behind before
 * its supersede paths deleted them.
 *
 *   npm run cleanup:unattached-document-data                                  # reports, writes nothing
 *   npm run cleanup:unattached-document-data -- --commit                      # deletes
 *   npm run cleanup:unattached-document-data -- --older-than-days 30 --commit
 *
 * The cutoff defaults to 7 days, long enough for any upload to be attached by
 * the call that follows it. A row with a null `createdAt` predates the column,
 * so its age is unknown: it is listed and never deleted.
 *
 * Only rows are deleted. Under S3 or Azure several rows can name one object, so
 * no storage object is touched here.
 *
 * The delete is a single statement that re-checks both conditions, so a row
 * attached after the scan survives. Running it twice is harmless.
 */
import { prisma } from '../index';

const DAY_MS = 24 * 60 * 60 * 1000;

type ClassCounts = { deletable: number; tooYoung: number; nullCreatedAt: number };

/** The `--older-than-days` value, the default when absent, or null when it is not a positive integer. */
const parseOlderThanDays = (args: string[]): number | null => {
  const index = args.indexOf('--older-than-days');

  if (index === -1) {
    return 7;
  }

  const value = args[index + 1];

  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    console.error(`--older-than-days needs a positive whole number of days, got ${value ?? 'nothing'}`);

    return null;
  }

  return Number(value);
};

const main = async () => {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const olderThanDays = parseOlderThanDays(args);

  // Refused before anything is read. Exiting through exitCode lets stderr drain.
  if (olderThanDays === null) {
    process.exitCode = 2;

    return;
  }

  const url = process.env.NEXT_PRIVATE_DATABASE_URL;

  if (!url) {
    console.error('NEXT_PRIVATE_DATABASE_URL is not set, so there is no database to clean');

    process.exitCode = 2;

    return;
  }

  const host = new URL(url).host;

  console.log(`Target database: ${host}`);

  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS);

  const rows = await prisma.documentData.findMany({
    where: { envelopeItem: null },
    select: { id: true, type: true, createdAt: true },
    orderBy: { id: 'asc' },
  });

  const byType: Record<string, ClassCounts> = {};
  const totals: ClassCounts = { deletable: 0, tooYoung: 0, nullCreatedAt: 0 };
  const deletableIds: string[] = [];

  for (const row of rows) {
    byType[row.type] = byType[row.type] ?? { deletable: 0, tooYoung: 0, nullCreatedAt: 0 };

    let rowClass: keyof ClassCounts = 'tooYoung';

    if (row.createdAt === null) {
      rowClass = 'nullCreatedAt';

      console.log(`Null createdAt (not deleted): ${row.id}`);
    } else if (row.createdAt < cutoff) {
      rowClass = 'deletable';

      deletableIds.push(row.id);
    }

    byType[row.type][rowClass] += 1;
    totals[rowClass] += 1;
  }

  let deleted = 0;

  if (commit) {
    const result = await prisma.documentData.deleteMany({
      where: {
        id: { in: deletableIds },
        envelopeItem: null,
        createdAt: { not: null, lt: cutoff },
      },
    });

    deleted = result.count;

    console.log(`Deleted ${deleted} row(s)`);
  }

  const summary = {
    mode: commit ? 'commit' : 'report',
    host,
    olderThanDays,
    unattached: rows.length,
    ...totals,
    byType,
    deleted,
  };

  console.log(`SUMMARY ${JSON.stringify(summary)}`);
};

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);

    await prisma.$disconnect();

    process.exitCode = 1;
  });
