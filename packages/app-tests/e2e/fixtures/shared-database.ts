/**
 * Puts a spec back on the shared e2e database when it runs after the
 * directory-sync project.
 *
 * Playwright hands the environment a dependency's worker ended with on to the
 * workers of the projects that depend on it. A directory-sync worker ends with
 * NEXT_PRIVATE_DATABASE_URL naming its own database, dropped by then, and with
 * the shared one kept in DIRSYNC_HARNESS_DATABASE_URL (pipeline 54637).
 *
 * IMPORT THIS MODULE FIRST: `@documenso/prisma` fixes its connection string
 * when it is first imported.
 */
const harnessUrl = process.env.DIRSYNC_HARNESS_DATABASE_URL;

if (harnessUrl) {
  process.env.NEXT_PRIVATE_DATABASE_URL = harnessUrl;
  process.env.NEXT_PRIVATE_DIRECT_DATABASE_URL = harnessUrl;
}
