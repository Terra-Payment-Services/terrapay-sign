/**
 * Backfill `DocumentData.userId` and `DocumentData.teamId` from the envelope
 * that holds the bytes.
 *
 * Run after the `add_document_data_owner` migration, on every deployment.
 * Until it has run, every row written before the migration carries no owner,
 * and `assertDocumentDataAccess` refuses an unheld row with no owner to
 * everybody.
 *
 *   npm run backfill:document-data-owner              # reports, writes nothing
 *   npm run backfill:document-data-owner -- --commit  # writes
 *
 * The owner comes from `EnvelopeItem -> Envelope`, which is the only record of
 * provenance the old schema kept. A row no envelope item holds has no owner
 * anywhere in the data. It is listed rather than guessed at, because guessing a
 * plausible team is the hole these columns exist to close.
 *
 * Running it twice is harmless. It looks only at rows where both columns are
 * null, and it writes only to a row that is still null when the write lands.
 */
import { prisma } from '../index';

/** How many rows to pull per round trip. */
const PAGE_SIZE = 500;

/**
 * A one line reason from whatever the database threw.
 *
 * Prisma's messages start with blank lines and carry the useful part several
 * lines down, so the first line on its own tells an operator nothing.
 */
const describeWriteFailure = (err: unknown): string => {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : null;

  if (code === 'P2003') {
    return 'The envelope names a user or team that no longer exists.';
  }

  const message = err instanceof Error ? err.message : String(err);
  const firstUseful = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstUseful ?? 'The write failed and said nothing.';
};

type UnresolvableRow = {
  id: string;
  type: string;
  reason: string;
};

const main = async () => {
  const commit = process.argv.includes('--commit');

  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  let alreadyStamped = 0;

  const unresolvable: UnresolvableRow[] = [];
  const teamCounts = new Map<number, number>();

  for (;;) {
    const rows = await prisma.documentData.findMany({
      where: { userId: null, teamId: null },
      select: {
        id: true,
        type: true,
        envelopeItem: {
          select: {
            envelope: {
              select: {
                userId: true,
                teamId: true,
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (rows.length === 0) {
      break;
    }

    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      scanned += 1;

      const envelope = row.envelopeItem?.envelope;

      if (!envelope) {
        unresolvable.push({
          id: row.id,
          type: row.type,
          reason: 'No envelope item holds it, so nothing records who uploaded it.',
        });

        continue;
      }

      teamCounts.set(envelope.teamId, (teamCounts.get(envelope.teamId) ?? 0) + 1);

      if (!commit) {
        updated += 1;

        continue;
      }

      try {
        // Scoped to rows that are still unowned, so a write from the running
        // application keeps what it put there.
        const written = await prisma.documentData.updateMany({
          where: { id: row.id, userId: null, teamId: null },
          data: { userId: envelope.userId, teamId: envelope.teamId },
        });

        if (written.count === 1) {
          updated += 1;
        } else {
          alreadyStamped += 1;
        }
      } catch (err) {
        unresolvable.push({
          id: row.id,
          type: row.type,
          reason: describeWriteFailure(err),
        });
      }
    }
  }

  console.log('');
  console.log(
    commit
      ? 'Backfilling DocumentData.userId and DocumentData.teamId'
      : 'Backfilling DocumentData.userId and DocumentData.teamId (dry run, pass --commit to write)',
  );
  console.log(`  rows with no owner    ${scanned}`);
  console.log(`  ${commit ? 'updated' : 'would update'}         ${updated}`);

  if (alreadyStamped > 0) {
    console.log(`  stamped by the application while this ran   ${alreadyStamped}`);
  }

  if (teamCounts.size > 0) {
    console.log('');
    console.log('Owners derived, by team. Check the spread is what you expect:');

    for (const [teamId, count] of [...teamCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`  team ${teamId}  ->  ${count} row(s)`);
    }
  }

  if (unresolvable.length > 0) {
    console.log('');
    console.log(`${unresolvable.length} row(s) cannot be resolved from data. Each one needs a decision:`);

    for (const row of unresolvable) {
      console.log(`  documentData ${row.id}  type ${row.type}  ${row.reason}`);
    }

    console.log('');
    console.log('An unheld row is an upload nobody finished with. There is no query that will find its owner.');
    console.log('Delete it, or ask the person who uploaded it and stamp it by hand. Do not pick a likely team.');
    console.log('Until then it stays unowned, and every caller is refused it.');
  }

  console.log('');

  return unresolvable.length;
};

main()
  .then(async (unresolvableCount) => {
    await prisma.$disconnect();

    process.exit(unresolvableCount > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);

    await prisma.$disconnect();

    process.exit(1);
  });
