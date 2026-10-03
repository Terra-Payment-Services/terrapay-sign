import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { DocumentVisibility, TeamMemberRole } from '@documenso/prisma/client';
import { seedCompletedDocument, seedDraftDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({
  mode: 'parallel',
});

const downloadUrl = (envelopeId: string, envelopeItemId: string, version: 'original' | 'signed' | 'pending') =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${envelopeItemId}/download/${version}`;

/** %PDF, the magic bytes every served file has to start with. */
const expectPdfBody = (body: Buffer) => {
  expect(Array.from(body.subarray(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
};

/** An admin-only contract in a team that also has a member and a recipient. */
const seedRestrictedContract = async () => {
  const { team, owner } = await seedTeam();

  const member = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MEMBER });
  const admin = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.ADMIN });

  const envelope = await seedCompletedDocument(owner, team.id, ['signer@test.documenso.com'], {
    createDocumentOptions: { visibility: DocumentVisibility.ADMIN },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  return { team, owner, member, admin, envelope, envelopeItem: envelope.envelopeItems[0], recipient };
};

const seedOwnerWithDraft = async () => {
  const owner = await seedUser();

  const draft = await seedDraftDocument(owner.user, owner.team.id, [], {
    createDocumentOptions: { title: 'File Download Auth Test' },
  });

  return { owner, draft, draftItem: draft.envelopeItems[0] };
};

test.describe('Envelope item file download endpoint authorization', () => {
  test('rejects an unauthenticated download request', async ({ request }) => {
    const { draft, draftItem } = await seedOwnerWithDraft();

    const res = await request.get(downloadUrl(draft.id, draftItem.id, 'original'));

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(401);
  });

  test('rejects a download request from a user outside the organisation', async ({ page }) => {
    const { draft, draftItem } = await seedOwnerWithDraft();
    const { user: outsider } = await seedUser();

    await apiSignin({ page, email: outsider.email });

    const res = await page.request.get(downloadUrl(draft.id, draftItem.id, 'original'));

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(403);
  });

  test('returns 404 for a nonexistent envelope', async ({ page }) => {
    const { user } = await seedUser();

    await apiSignin({ page, email: user.email });

    const res = await page.request.get(
      downloadUrl('envelope_does_not_exist', 'envelope_item_does_not_exist', 'original'),
    );

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(404);
  });

  test('rejects a pending version download for a draft envelope', async ({ page }) => {
    const { owner, draft, draftItem } = await seedOwnerWithDraft();

    await apiSignin({ page, email: owner.user.email });

    const res = await page.request.get(downloadUrl(draft.id, draftItem.id, 'pending'));

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(400);
  });

  test('rejects a pending version download for a legacy envelope', async ({ page }) => {
    const owner = await seedUser();
    const { user: recipient } = await seedUser();

    // Default internalVersion is 1 (legacy).
    const pendingDocument = await seedPendingDocument(owner.user, owner.team.id, [recipient], {
      createDocumentOptions: { title: 'Legacy Pending Download Test' },
    });

    const envelopeItem = pendingDocument.envelopeItems[0];

    await apiSignin({ page, email: owner.user.email });

    const res = await page.request.get(downloadUrl(pendingDocument.id, envelopeItem.id, 'pending'));

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(400);
  });

  test('allows the owner to download their own document', async ({ page }) => {
    const { owner, draft, draftItem } = await seedOwnerWithDraft();

    await apiSignin({ page, email: owner.user.email });

    const res = await page.request.get(downloadUrl(draft.id, draftItem.id, 'original'));

    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('application/pdf');

    const body = await res.body();

    // %PDF magic bytes.
    expect(Array.from(body.subarray(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  // The advisory. Team membership used to be the whole check, so the lowest
  // role in the team could pull the bytes of a contract restricted to admins.
  test('rejects a download from a team member below the document visibility', async ({ page }) => {
    const { member, envelope, envelopeItem } = await seedRestrictedContract();

    await apiSignin({ page, email: member.email });

    const res = await page.request.get(downloadUrl(envelope.id, envelopeItem.id, 'original'));

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(403);
  });

  test('allows a team admin to download the same restricted document', async ({ page }) => {
    const { admin, envelope, envelopeItem } = await seedRestrictedContract();

    await apiSignin({ page, email: admin.email });

    const res = await page.request.get(downloadUrl(envelope.id, envelopeItem.id, 'original'));

    expect(res.ok()).toBeTruthy();
    expectPdfBody(await res.body());
  });

  // Signing has to keep working. A recipient holds no role in the team and
  // would fail the visibility rule, which is why the token routes resolve the
  // item by token instead of going through the team check at all.
  test('allows a recipient holding a valid signing token to download a restricted document', async ({ request }) => {
    const { envelopeItem, recipient } = await seedRestrictedContract();

    const res = await request.get(
      `${WEBAPP_BASE_URL}/api/files/token/${recipient.token}/envelopeItem/${envelopeItem.id}/download/original`,
    );

    expect(res.ok()).toBeTruthy();
    expectPdfBody(await res.body());
  });

  test('rejects a recipient-token download with an invalid token', async ({ request }) => {
    const { draftItem } = await seedOwnerWithDraft();

    const res = await request.get(
      `${WEBAPP_BASE_URL}/api/files/token/invalid-token-12345/envelopeItem/${draftItem.id}/download/original`,
    );

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(404);
  });
});
