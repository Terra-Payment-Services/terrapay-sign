import fs from 'node:fs';
import path from 'node:path';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT, NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../../../assets/example.pdf'));

test.describe.configure({
  mode: 'parallel',
});

const createPresignTokenForUser = async (userId: number, teamId: number) => {
  const { token: apiToken } = await createApiToken({
    userId,
    teamId,
    tokenName: 'file-upload-test',
    expiresIn: null,
  });

  const { token: presignToken } = await createEmbeddingPresignToken({ apiToken });

  return presignToken;
};

const buildPdfFormData = () => {
  const formData = new FormData();
  formData.append('file', new File([examplePdf], 'test.pdf', { type: 'application/pdf' }));

  return formData;
};

test.describe('File upload endpoint authorization', () => {
  test('rejects an unauthenticated upload-pdf request', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      multipart: buildPdfFormData(),
    });

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(401);
  });

  test('allows an upload-pdf request authorized by a valid presign token', async ({ request }) => {
    const { user, team } = await seedUser();
    const presignToken = await createPresignTokenForUser(user.id, team.id);

    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      headers: { Authorization: `Bearer ${presignToken}` },
      multipart: buildPdfFormData(),
    });

    expect(res.ok()).toBeTruthy();
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.id).toBeDefined();
  });

  test('refuses an upload larger than the limit before it is parsed or authenticated', async ({ request }) => {
    // One byte past the file limit plus the 1 MiB multipart allowance.
    const oversized = Buffer.alloc((APP_DOCUMENT_UPLOAD_SIZE_LIMIT + 1) * 1024 * 1024 + 1);

    const formData = new FormData();
    formData.append('file', new File([oversized], 'huge.pdf', { type: 'application/pdf' }));

    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      multipart: formData,
    });

    expect(res.status()).toBe(413);
  });

  test('refuses a tRPC JSON body over the 10 MiB limit', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/profile.updateProfile`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ json: { name: 'a'.repeat(11 * 1024 * 1024) } }),
    });

    expect(res.status()).toBe(413);
  });
});
