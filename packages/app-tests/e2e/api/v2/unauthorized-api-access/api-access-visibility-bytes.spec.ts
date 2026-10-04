import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { hashString } from '@documenso/lib/server-only/auth/hash';
import { alphaid } from '@documenso/lib/universal/id';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { DocumentVisibility, TeamMemberRole } from '@documenso/prisma/client';
import { seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { type APIResponse, expect, test } from '@playwright/test';

import { apiSignin } from '../../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const API_BASE_URL = `${WEBAPP_BASE_URL}/api/v2-beta`;

test.describe.configure({ mode: 'parallel' });

/**
 * A team member whose role sits below a document's visibility must not reach
 * the document by any route that takes a team credential. The session download
 * route, the certificate and audit log, and the recipient and field reads are
 * asserted elsewhere. These are the remaining routes that return the envelope
 * or its bytes: the V2 envelope read, the V2 item and document downloads, and
 * the session item.pdf route the viewer uses.
 */

/**
 * Written directly because `createApiToken` refuses a member, who lacks
 * MANAGE_TEAM. That models a token minted before a downgrade, which must still
 * respect visibility at request time.
 */
const seedApiToken = async (userId: number, teamId: number) => {
  const token = `api_${alphaid(16)}`;

  await prisma.apiToken.create({
    data: { name: 'visibility-bytes', token: hashString(token), expires: null, userId, teamId },
  });

  return token;
};

const seedRestrictedContract = async () => {
  const { team, owner } = await seedTeam();

  const member = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MEMBER });
  const admin = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.ADMIN });

  const envelope = await seedCompletedDocument(owner, team.id, ['signer@test.documenso.com'], {
    createDocumentOptions: { visibility: DocumentVisibility.ADMIN },
  });

  const [envelopeItem] = envelope.envelopeItems;

  const memberToken = await seedApiToken(member.id, team.id);
  const adminToken = await seedApiToken(admin.id, team.id);

  return { member, admin, envelope, envelopeItem, memberToken, adminToken };
};

const expectNoPdf = async (res: APIResponse) => {
  expect((await res.body()).subarray(0, 4).toString('latin1')).not.toBe('%PDF');
};

const expectPdf = async (res: APIResponse) => {
  expect((await res.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('[VISIBILITY]: a member below the document visibility cannot read it', () => {
  test('GET /envelope/{envelopeId} hides the envelope from a member', async ({ request }) => {
    const { envelope, memberToken, adminToken } = await seedRestrictedContract();

    const memberRes = await request.get(`${API_BASE_URL}/envelope/${envelope.id}`, { headers: bearer(memberToken) });

    expect(memberRes.status()).toBe(404);

    // Control: the same URL works for a role the visibility admits.
    const adminRes = await request.get(`${API_BASE_URL}/envelope/${envelope.id}`, { headers: bearer(adminToken) });

    expect(adminRes.status()).toBe(200);
  });

  test('GET /envelope/item/{envelopeItemId}/download refuses a member', async ({ request }) => {
    const { envelopeItem, memberToken, adminToken } = await seedRestrictedContract();

    const url = `${API_BASE_URL}/envelope/item/${envelopeItem.id}/download?version=original`;

    const memberRes = await request.get(url, { headers: bearer(memberToken) });

    expect(memberRes.status()).toBe(404);
    await expectNoPdf(memberRes);

    const adminRes = await request.get(url, { headers: bearer(adminToken) });

    expect(adminRes.status()).toBe(200);
    await expectPdf(adminRes);
  });

  test('GET /document/{documentId}/download refuses a member', async ({ request }) => {
    const { envelope, memberToken, adminToken } = await seedRestrictedContract();

    const url = `${API_BASE_URL}/document/${mapSecondaryIdToDocumentId(envelope.secondaryId)}/download`;

    const memberRes = await request.get(url, { headers: bearer(memberToken) });

    expect(memberRes.status()).toBe(404);
    await expectNoPdf(memberRes);

    const adminRes = await request.get(url, { headers: bearer(adminToken) });

    expect(adminRes.status()).toBe(200);
    await expectPdf(adminRes);
  });

  test('session item.pdf refuses a member', async ({ browser }) => {
    const { member, admin, envelope, envelopeItem } = await seedRestrictedContract();

    const url = `${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/envelopeItem/${envelopeItem.id}/dataId/${envelopeItem.documentDataId}/initial/item.pdf`;

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();

    await apiSignin({ page: memberPage, email: member.email });

    const memberRes = await memberPage.request.get(url);

    expect(memberRes.status()).toBe(404);
    await expectNoPdf(memberRes);

    await memberContext.close();

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    await apiSignin({ page: adminPage, email: admin.email });

    const adminRes = await adminPage.request.get(url);

    expect(adminRes.status()).toBe(200);
    await expectPdf(adminRes);

    await adminContext.close();
  });
});
