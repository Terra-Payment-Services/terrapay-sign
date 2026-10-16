/**
 * Puts a spec back on the shared e2e database when it runs after the
 * directory-sync project.
 *
 * Playwright hands the environment a dependency's worker ended with on to the
 * workers of the projects that depend on it. A directory-sync worker ends with
 * NEXT_PRIVATE_DATABASE_URL naming its own database, dropped by then, and with
 * the shared one kept in DIRSYNC_HARNESS_DATABASE_URL (pipeline 54637). One
 * that seeds through its own server also ends with the application URLs naming
 * that server, gone by then, with the harness's kept alongside (pipeline 54729).
 *
 * IMPORT THIS MODULE FIRST: `@documenso/prisma` fixes its connection string
 * when it is first imported.
 */
const harnessUrl = process.env.DIRSYNC_HARNESS_DATABASE_URL;

if (harnessUrl) {
  process.env.NEXT_PRIVATE_DATABASE_URL = harnessUrl;
  process.env.NEXT_PRIVATE_DIRECT_DATABASE_URL = harnessUrl;
}

const harnessWebappUrl = process.env.DIRSYNC_HARNESS_WEBAPP_URL;

// An empty value stands for a variable the harness never set.
const restore = (name: string, value: string | undefined) => {
  if (value) {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
};

if (harnessWebappUrl !== undefined) {
  restore('NEXT_PUBLIC_WEBAPP_URL', harnessWebappUrl);
  restore('NEXT_PRIVATE_INTERNAL_WEBAPP_URL', process.env.DIRSYNC_HARNESS_INTERNAL_WEBAPP_URL);
}
