import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * Issue 56, as amended on 13 October 2026. Every case answers HTTP 404 and the
 * page depends only on the team URL, never on the document: an unknown team or
 * a team the user is not in shows "Team not found", a team the user belongs to
 * shows the document-not-found page. Paired cases must match each other.
 * Each case reads the HTTP status of the document request, then the heading.
 */

test.describe.configure({
  mode: 'parallel',
});

const MISSING_NUMERIC_ID = '2000000000';
const MISSING_ENVELOPE_ID = 'envelope_zzzzzzzzzzzzzzzz';
const MISSING_TEAM_URL = 'no-such-team-56';

const seedScenario = async () => {
  const { user: owner, team: ownerTeam } = await seedUser();
  const { user: viewer, team: viewerTeam } = await seedUser();

  const envelope = await seedBlankDocument(owner, ownerTeam.id);

  return {
    owner,
    ownerTeam,
    viewer,
    viewerTeam,
    envelopeId: envelope.id,
    numericId: String(mapSecondaryIdToDocumentId(envelope.secondaryId)),
  };
};

const openDocumentUrl = async (page: Page, path: string) => {
  const response = await page.goto(`${NEXT_PUBLIC_WEBAPP_URL()}${path}`);

  return response?.status();
};

type Observed = { status: number | undefined; heading: string | null };

/**
 * Opens the URL and reads its HTTP status and h1 text. The h1 is null when none
 * appears within five seconds.
 */
const observe = async (page: Page, path: string): Promise<Observed> => {
  const status = await openDocumentUrl(page, path);
  const h1 = page.getByRole('heading', { level: 1 }).first();
  const heading = await h1.waitFor({ timeout: 5000 }).then(
    async () => await h1.innerText(),
    () => null,
  );

  return { status, heading };
};

/** The existing "Team not found" page, shown for an unknown team or a team the user is not in. */
const expectTeamNotFound = async (page: Page, path: string): Promise<Observed> => {
  const observed = await observe(page, path);

  expect.soft(observed.status, `HTTP status of ${path}`).toBe(404);
  expect.soft(observed.heading, `heading of ${path}`).toBe('Team not found');

  return observed;
};

/** The document-not-found page, shown under a team the user belongs to. */
const expectDocumentNotFound = async (page: Page, path: string): Promise<Observed> => {
  const observed = await observe(page, path);

  expect.soft(observed.status, `HTTP status of ${path}`).toBe(404);
  expect.soft(observed.heading, `heading of ${path}`).toBe('Oops! Something went wrong.');
  await expect.soft(page.getByText('404 Document not found'), `sub-heading of ${path}`).toBeVisible();

  return observed;
};

test.describe('Document URL under the wrong team', () => {
  // A red run waits out several soft assertions per URL, so the default 60 s is too tight.
  test.beforeEach(() => {
    test.setTimeout(150_000);
  });

  test('1. numeric id under a team the user belongs to that does not hold the document answers 404, same as a missing id (case 4)', async ({
    page,
  }) => {
    const { viewer, viewerTeam, numericId } = await seedScenario();

    await apiSignin({ page, email: viewer.email, redirectPath: `/t/${viewerTeam.url}/documents` });

    const existing = await expectDocumentNotFound(page, `/t/${viewerTeam.url}/documents/${numericId}`);
    const missing = await expectDocumentNotFound(page, `/t/${viewerTeam.url}/documents/${MISSING_NUMERIC_ID}`);

    expect.soft(existing, 'existing id and missing id must look identical').toEqual(missing);
  });

  test('2. numeric id under a team URL that does not exist answers 404 Team not found, same as case 3', async ({
    page,
  }) => {
    const { viewer, viewerTeam, ownerTeam, numericId } = await seedScenario();

    await apiSignin({ page, email: viewer.email, redirectPath: `/t/${viewerTeam.url}/documents` });

    const unknownTeam = await expectTeamNotFound(page, `/t/${MISSING_TEAM_URL}/documents/${numericId}`);
    const foreignTeam = await expectTeamNotFound(page, `/t/${ownerTeam.url}/documents/${numericId}`);

    expect.soft(unknownTeam, 'unknown team and foreign team must look identical').toEqual(foreignTeam);
  });

  test('3. numeric id under a team that exists but the user does not belong to answers 404 Team not found', async ({
    page,
  }) => {
    const { viewer, viewerTeam, ownerTeam, numericId } = await seedScenario();

    await apiSignin({ page, email: viewer.email, redirectPath: `/t/${viewerTeam.url}/documents` });

    await expectTeamNotFound(page, `/t/${ownerTeam.url}/documents/${numericId}`);
    await expectTeamNotFound(page, `/t/${ownerTeam.url}/documents/${MISSING_NUMERIC_ID}`);
  });

  test('4. numeric id that does not exist under a team the user belongs to answers 404 Document not found', async ({
    page,
  }) => {
    const { viewer, viewerTeam } = await seedScenario();

    await apiSignin({ page, email: viewer.email, redirectPath: `/t/${viewerTeam.url}/documents` });

    await expectDocumentNotFound(page, `/t/${viewerTeam.url}/documents/${MISSING_NUMERIC_ID}`);
  });

  test('5. the same four cases with the envelope id answer 404 with the same pages', async ({ page }) => {
    const { viewer, viewerTeam, ownerTeam, envelopeId } = await seedScenario();

    await apiSignin({ page, email: viewer.email, redirectPath: `/t/${viewerTeam.url}/documents` });

    // Cases 1 and 4: a team the user belongs to, existing and missing envelope.
    const ownExisting = await expectDocumentNotFound(page, `/t/${viewerTeam.url}/documents/${envelopeId}`);
    const ownMissing = await expectDocumentNotFound(page, `/t/${viewerTeam.url}/documents/${MISSING_ENVELOPE_ID}`);

    expect.soft(ownExisting, 'existing and missing envelope id must look identical').toEqual(ownMissing);

    // Cases 2 and 3: a team URL that does not exist, and a team the user is not in.
    const unknownTeam = await expectTeamNotFound(page, `/t/${MISSING_TEAM_URL}/documents/${envelopeId}`);
    const foreignTeam = await expectTeamNotFound(page, `/t/${ownerTeam.url}/documents/${envelopeId}`);

    expect.soft(unknownTeam, 'unknown team and foreign team must look identical').toEqual(foreignTeam);
  });

  test('6. numeric id under the team that holds the document redirects 302 to the envelope URL, which answers 200', async ({
    page,
  }) => {
    const { owner, ownerTeam, numericId, envelopeId } = await seedScenario();

    await apiSignin({ page, email: owner.email, redirectPath: `/t/${ownerTeam.url}/documents` });

    const redirect = await page.request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/t/${ownerTeam.url}/documents/${numericId}`, {
      maxRedirects: 0,
    });

    expect(redirect.status()).toBe(302);
    expect(redirect.headers().location).toContain(`/t/${ownerTeam.url}/documents/${envelopeId}`);

    const status = await openDocumentUrl(page, `/t/${ownerTeam.url}/documents/${envelopeId}`);

    expect(status).toBe(200);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  });
});
