/**
 * A stand-in for one directory-sync test worker, run as a child process by
 * harness-databases.spec.ts: it takes this process's databases the way a
 * worker does, reports their names and whether Postgres has them, and then
 * releases them the way a worker does when it shuts down.
 */
import { PrismaClient } from '@prisma/client';

const main = async () => {
  const databases = await import('./worker-database');
  const harness = new PrismaClient({ datasourceUrl: process.env.DIRSYNC_HARNESS_DATABASE_URL });

  const exists = async (name: string) =>
    (await harness.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname = '${name}'`)).length > 0;

  await databases.resetWorkerDatabase(
    async () => {},
    async () => databases.workerDatabaseName,
  );

  const report = {
    pid: process.pid,
    database: databases.workerDatabaseName,
    template: databases.templateDatabaseName,
    existedWhileInUse: (await exists(databases.workerDatabaseName)) && (await exists(databases.templateDatabaseName)),
  };

  await databases.releaseWorkerDatabases();
  await harness.$disconnect();

  process.stdout.write(`${JSON.stringify(report)}\n`);
};

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
