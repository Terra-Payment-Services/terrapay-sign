import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { createTeam } from '@documenso/lib/server-only/team/create-team';
import { nanoid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({
  mode: 'parallel',
});

/**
 * One person who belongs to two teams, an API token for the first, and a
 * draft in each. A presign token minted from the first team's API token used
 * to open the second team's draft too, because the file routes checked only
 * that the token's user could see the envelope.
 */
const seedTwoTeamsOneUser = async () => {
  const { owner, team: tokenTeam, organisation } = await seedTeam();

  const otherTeamUrl = `presign-other-${nanoid()}`;

  await createTeam({
    userId: owner.id,
    teamName: 'Other team',
    teamUrl: otherTeamUrl,
    organisationId: organisation.id,
    inheritMembers: true,
  });

  const otherTeam = await prisma.team.findFirstOrThrow({ where: { url: otherTeamUrl } });

  const { token: apiToken } = await createApiToken({
    userId: owner.id,
    teamId: tokenTeam.id,
    tokenName: 'presign-team-binding',
    expiresIn: null,
  });

  const { token: presignToken } = await createEmbeddingPresignToken({ apiToken });

  const ownDraft = await seedBlankDocument(owner, tokenTeam.id);
  const otherDraft = await seedBlankDocument(owner, otherTeam.id);

  const itemOf = async (envelopeId: string) => await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  return {
    owner,
    presignToken,
    ownDraft,
    ownItem: await itemOf(ownDraft.id),
    otherDraft,
    otherItem: await itemOf(otherDraft.id),
  };
};

const pdfUrl = (envelopeId: string, item: { id: string; documentDataId: string }) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${item.id}/dataId/${item.documentDataId}/current/item.pdf`;

const fileUrl = (envelopeId: string, itemId: string) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${itemId}`;

// The file routes take a presign token from the Authorization header only.
const bearer = (presignToken: string) => ({ headers: { Authorization: `Bearer ${presignToken}` } });

test.describe('Presign tokens are bound to the API token team', () => {
  test('the user behind the token can open the other team envelope with a session', async ({ page }) => {
    // The control for the refusals below: the user may see this envelope, so
    // a 404 through the presign token comes from the team binding alone.
    const { owner, otherDraft, otherItem } = await seedTwoTeamsOneUser();

    await apiSignin({ page, email: owner.email });

    const res = await page.request.get(
      `${WEBAPP_BASE_URL}/api/files/envelope/${otherDraft.id}/envelopeItem/${otherItem.id}/dataId/${otherItem.documentDataId}/current/item.pdf`,
    );

    expect(res.status()).toBe(200);
  });

  test('item.pdf serves the token team envelope', async ({ request }) => {
    const { presignToken, ownDraft, ownItem } = await seedTwoTeamsOneUser();

    const res = await request.get(pdfUrl(ownDraft.id, ownItem), bearer(presignToken));

    expect(res.status()).toBe(200);
  });

  test('item.pdf refuses an envelope in another team of the same user', async ({ request }) => {
    const { presignToken, otherDraft, otherItem } = await seedTwoTeamsOneUser();

    const res = await request.get(pdfUrl(otherDraft.id, otherItem), bearer(presignToken));

    expect(res.status()).toBe(404);
  });

  test('the envelope item file route serves the token team envelope', async ({ request }) => {
    const { presignToken, ownDraft, ownItem } = await seedTwoTeamsOneUser();

    const res = await request.get(fileUrl(ownDraft.id, ownItem.id), bearer(presignToken));

    expect(res.status()).toBe(200);
  });

  test('the envelope item file route refuses an envelope in another team of the same user', async ({ request }) => {
    const { presignToken, otherDraft, otherItem } = await seedTwoTeamsOneUser();

    const res = await request.get(fileUrl(otherDraft.id, otherItem.id), bearer(presignToken));

    expect(res.status()).toBe(404);
  });
});

/**
 * Two drafts in one team and a presign token scoped to the first. The update
 * routes held a scoped token to its envelope, but the file routes did not, so
 * it read every envelope in the team.
 */
const seedScopedToken = async () => {
  const { owner, team } = await seedTeam();

  const { token: apiToken } = await createApiToken({
    userId: owner.id,
    teamId: team.id,
    tokenName: 'presign-scope',
    expiresIn: null,
  });

  const scopedDraft = await seedBlankDocument(owner, team.id);
  const siblingDraft = await seedBlankDocument(owner, team.id);

  const { token: presignToken } = await createEmbeddingPresignToken({
    apiToken,
    scope: `envelopeId:${scopedDraft.id}`,
  });

  const itemOf = async (envelopeId: string) => await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  return {
    presignToken,
    scopedDraft,
    scopedItem: await itemOf(scopedDraft.id),
    siblingDraft,
    siblingItem: await itemOf(siblingDraft.id),
  };
};

test.describe('Scoped presign tokens are bound to their envelope', () => {
  test('item.pdf serves the scoped envelope', async ({ request }) => {
    const { presignToken, scopedDraft, scopedItem } = await seedScopedToken();

    const res = await request.get(pdfUrl(scopedDraft.id, scopedItem), bearer(presignToken));

    expect(res.status()).toBe(200);
  });

  test('item.pdf refuses another envelope in the same team', async ({ request }) => {
    const { presignToken, siblingDraft, siblingItem } = await seedScopedToken();

    const res = await request.get(pdfUrl(siblingDraft.id, siblingItem), bearer(presignToken));

    expect(res.status()).toBe(404);
  });

  test('the envelope item file route serves the scoped envelope', async ({ request }) => {
    const { presignToken, scopedDraft, scopedItem } = await seedScopedToken();

    const res = await request.get(fileUrl(scopedDraft.id, scopedItem.id), bearer(presignToken));

    expect(res.status()).toBe(200);
  });

  test('the envelope item file route refuses another envelope in the same team', async ({ request }) => {
    const { presignToken, siblingDraft, siblingItem } = await seedScopedToken();

    const res = await request.get(fileUrl(siblingDraft.id, siblingItem.id), bearer(presignToken));

    expect(res.status()).toBe(404);
  });
});

/**
 * A presign token is a bearer credential. In a query string it is written to
 * access logs and browser history, so the file routes no longer read it there.
 * Each request below carries a token that the header form accepts.
 */
test.describe('Presign tokens in the query string are refused', () => {
  test('item.pdf refuses a token in the query string', async ({ request }) => {
    const { presignToken, ownDraft, ownItem } = await seedTwoTeamsOneUser();

    const res = await request.get(`${pdfUrl(ownDraft.id, ownItem)}?presignToken=${presignToken}`);

    expect(res.status()).toBe(404);
  });

  test('the envelope item file route refuses a token in the query string', async ({ request }) => {
    const { presignToken, ownDraft, ownItem } = await seedTwoTeamsOneUser();

    const res = await request.get(`${fileUrl(ownDraft.id, ownItem.id)}?token=${presignToken}`);

    expect(res.status()).toBe(401);
  });

  test('upload refuses a token in the query string', async ({ request }) => {
    const { presignToken } = await seedTwoTeamsOneUser();

    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf?token=${presignToken}`);

    expect(res.status()).toBe(401);
  });
});
