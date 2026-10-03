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

const pdfUrl = (envelopeId: string, item: { id: string; documentDataId: string }, presignToken: string) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${item.id}/dataId/${item.documentDataId}/current/item.pdf?presignToken=${presignToken}`;

const fileUrl = (envelopeId: string, itemId: string, presignToken: string) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${itemId}?token=${presignToken}`;

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

    const res = await request.get(pdfUrl(ownDraft.id, ownItem, presignToken));

    expect(res.status()).toBe(200);
  });

  test('item.pdf refuses an envelope in another team of the same user', async ({ request }) => {
    const { presignToken, otherDraft, otherItem } = await seedTwoTeamsOneUser();

    const res = await request.get(pdfUrl(otherDraft.id, otherItem, presignToken));

    expect(res.status()).toBe(404);
  });

  test('the envelope item file route serves the token team envelope', async ({ request }) => {
    const { presignToken, ownDraft, ownItem } = await seedTwoTeamsOneUser();

    const res = await request.get(fileUrl(ownDraft.id, ownItem.id, presignToken));

    expect(res.status()).toBe(200);
  });

  test('the envelope item file route refuses an envelope in another team of the same user', async ({ request }) => {
    const { presignToken, otherDraft, otherItem } = await seedTwoTeamsOneUser();

    const res = await request.get(fileUrl(otherDraft.id, otherItem.id, presignToken));

    expect(res.status()).toBe(404);
  });
});
