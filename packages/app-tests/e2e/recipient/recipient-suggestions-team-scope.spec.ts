import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { customAlphabet } from 'nanoid';

import { apiSignin } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 12);

test.describe.configure({ mode: 'parallel' });

type Suggestion = { name: string | null; email: string };

const findSuggestions = async (page: Page, teamId: number, query: string) => {
  const input = encodeURIComponent(JSON.stringify({ json: { query } }));

  const res = await page
    .context()
    .request.get(`${WEBAPP_BASE_URL}/api/trpc/recipient.suggestions.find?input=${input}`, {
      headers: { 'x-team-id': teamId.toString() },
    });

  if (!res.ok()) {
    return { status: res.status(), results: [] as Suggestion[] };
  }

  const body = await res.json();

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { status: res.status(), results: body.result.data.json.results as Suggestion[] };
};

const emailsOf = (results: Suggestion[]) => results.map((result) => result.email.toLowerCase());

const namesOf = (results: Suggestion[]) => results.map((result) => result.name ?? '');

/**
 * Guards C1: naming another organisation's team in x-team-id must not reveal that
 * team's members. A searches TB by part of M's name and by part of M's email; neither M nor
 * TB's owner may appear, whether the server answers with an error or an empty list.
 */
test('[RECIPIENT SUGGESTIONS]: a foreign team header does not reveal that team members', async ({ page }) => {
  const tag = nanoid();

  const { user: userA } = await seedUser();
  const { user: ownerB, team: teamB } = await seedUser({ name: `owner ${nanoid()}` });

  const memberM = await seedTeamMember({ teamId: teamB.id, name: `Mallory ${tag}` });
  const memberMLocalPart = memberM.email.split('@')[0];

  await apiSignin({ page, email: userA.email });

  const foreignEmails = [memberM.email.toLowerCase(), ownerB.email.toLowerCase()];

  for (const query of [tag, memberMLocalPart]) {
    const { results } = await findSuggestions(page, teamB.id, query);

    for (const email of foreignEmails) {
      expect(emailsOf(results)).not.toContain(email);
    }

    expect(namesOf(results)).not.toContain(`Mallory ${tag}`);
    expect(namesOf(results).some((name) => name.includes(tag))).toBe(false);
  }
});

/**
 * Guards C2: naming another organisation's team in x-team-id must not reveal the
 * recipients of that team's documents.
 */
test('[RECIPIENT SUGGESTIONS]: a foreign team header does not reveal that team recipients', async ({ page }) => {
  const tag = nanoid();
  const recipientEmail = `r${tag}@test.documenso.com`;

  const { user: userA } = await seedUser();
  const { user: ownerB, team: teamB } = await seedUser();

  await seedPendingDocument(ownerB, teamB.id, [recipientEmail]);

  await apiSignin({ page, email: userA.email });

  const { results } = await findSuggestions(page, teamB.id, tag);

  expect(emailsOf(results)).not.toContain(recipientEmail);
  expect(emailsOf(results).some((email) => email.includes(tag))).toBe(false);
});

/**
 * Guards C3 (control): a fix that scopes suggestions to the caller's teams must still
 * suggest a member of the caller's own team.
 */
test('[RECIPIENT SUGGESTIONS]: a member of the caller team is still suggested', async ({ page }) => {
  const tag = nanoid();

  const { user: userA, team: teamA } = await seedUser();
  const memberN = await seedTeamMember({ teamId: teamA.id, name: `Nadia ${tag}` });

  await apiSignin({ page, email: userA.email });

  const { status, results } = await findSuggestions(page, teamA.id, tag);

  expect(status).toBe(200);
  expect(emailsOf(results)).toContain(memberN.email.toLowerCase());
});

/**
 * Guards C4 (control): a fix that scopes suggestions to the caller's teams must still
 * suggest a recipient of the caller's own team's documents.
 */
test('[RECIPIENT SUGGESTIONS]: a recipient of the caller team documents is still suggested', async ({ page }) => {
  const tag = nanoid();
  const recipientEmail = `r${tag}@test.documenso.com`;

  const { user: userA, team: teamA } = await seedUser();

  await seedPendingDocument(userA, teamA.id, [recipientEmail]);

  await apiSignin({ page, email: userA.email });

  const { status, results } = await findSuggestions(page, teamA.id, tag);

  expect(status).toBe(200);
  expect(emailsOf(results)).toContain(recipientEmail);
});
