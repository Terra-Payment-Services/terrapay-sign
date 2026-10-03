/**
 * Backfill `Account.issuer` from the ID token already stored on each row.
 *
 * Run after the `add_account_issuer` migration, on every deployment, before
 * anybody thinks about dropping the old (provider, providerAccountId) unique
 * constraint.
 *
 *   npm run backfill:account-issuer              # reports, writes nothing
 *   npm run backfill:account-issuer -- --commit  # writes
 *
 * It calls no authority and reads no configuration. The issuer comes out of the
 * `iss` claim of the token the row was created from, which is the only place
 * that records what happened. Reading the provider label and looking up
 * whatever URL is configured against it today would reintroduce the assumption
 * this column exists to remove, so a row whose token is missing or unparseable
 * is listed for a person rather than guessed at.
 *
 * Running it twice is harmless. It only looks at rows where `issuer` is null,
 * and it only writes to a row that is still null when the write lands.
 */
import { readIssuerFromIdToken } from '@documenso/lib/utils/account-issuer';

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

  if (code === 'P2002') {
    return 'Another row already holds this issuer and subject. One person is linked twice.';
  }

  const message = err instanceof Error ? err.message : String(err);
  const firstUseful = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstUseful ?? 'The write failed and said nothing.';
};

type UnbackfillableRow = {
  id: string;
  provider: string;
  providerAccountId: string;
  userId: number;
  reason: string;
};

const main = async () => {
  const commit = process.argv.includes('--commit');

  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  let alreadyStamped = 0;

  const unbackfillable: UnbackfillableRow[] = [];
  const issuersByProvider = new Map<string, Map<string, number>>();

  for (;;) {
    const rows = await prisma.account.findMany({
      where: { issuer: null },
      select: {
        id: true,
        userId: true,
        provider: true,
        providerAccountId: true,
        id_token: true,
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

      const result = readIssuerFromIdToken(row.id_token);

      if (!result.ok) {
        unbackfillable.push({
          id: row.id,
          provider: row.provider,
          providerAccountId: row.providerAccountId,
          userId: row.userId,
          reason: result.reason,
        });

        continue;
      }

      const seen = issuersByProvider.get(row.provider) ?? new Map<string, number>();

      seen.set(result.issuer, (seen.get(result.issuer) ?? 0) + 1);
      issuersByProvider.set(row.provider, seen);

      if (!commit) {
        updated += 1;

        continue;
      }

      try {
        // Scoped to rows that are still null so a sign in that stamped this row
        // while the script was running keeps what it wrote.
        const written = await prisma.account.updateMany({
          where: { id: row.id, issuer: null },
          data: { issuer: result.issuer },
        });

        if (written.count === 1) {
          updated += 1;
        } else {
          alreadyStamped += 1;
        }
      } catch (err) {
        // The likeliest failure is the new unique index: two rows already hold
        // this subject at this authority under different provider labels, which
        // is one person linked twice and a decision for somebody who knows the
        // estate.
        unbackfillable.push({
          id: row.id,
          provider: row.provider,
          providerAccountId: row.providerAccountId,
          userId: row.userId,
          reason: describeWriteFailure(err),
        });
      }
    }
  }

  console.log('');
  console.log(commit ? 'Backfilling Account.issuer' : 'Backfilling Account.issuer (dry run, pass --commit to write)');
  console.log(`  rows with no issuer   ${scanned}`);
  console.log(`  ${commit ? 'updated' : 'would update'}         ${updated}`);

  if (alreadyStamped > 0) {
    console.log(`  stamped by a sign in while this ran   ${alreadyStamped}`);
  }

  if (issuersByProvider.size > 0) {
    console.log('');
    console.log('Issuers found, by provider label. Check these are the authorities you expect:');

    for (const [provider, issuers] of issuersByProvider) {
      for (const [issuer, count] of issuers) {
        console.log(`  ${provider}  ->  ${issuer}  (${count})`);
      }
    }
  }

  if (unbackfillable.length > 0) {
    console.log('');
    console.log(`${unbackfillable.length} row(s) cannot be backfilled from data. Each one needs a decision:`);

    for (const row of unbackfillable) {
      console.log(
        `  account ${row.id}  user ${row.userId}  provider ${row.provider}  subject ${row.providerAccountId}  ${row.reason}`,
      );
    }

    console.log('');
    console.log('Do not infer the issuer from the provider label and the current configuration.');
    console.log('Either confirm with the person who owns the account which authority linked it, or unlink the row.');
  }

  console.log('');

  return unbackfillable.length;
};

main()
  .then(async (unbackfillableCount) => {
    await prisma.$disconnect();

    process.exit(unbackfillableCount > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);

    await prisma.$disconnect();

    process.exit(1);
  });
