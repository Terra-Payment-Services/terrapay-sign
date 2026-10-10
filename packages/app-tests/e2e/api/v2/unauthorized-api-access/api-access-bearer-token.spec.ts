import { createHmac } from 'node:crypto';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const OWN_ORIGIN = new URL(WEBAPP_BASE_URL).origin;

test.describe.configure({
  mode: 'parallel',
});

/**
 * The file routes once accepted an embedding presign token as a bearer header.
 * Embedded authoring and presign tokens are removed, so a bearer header must
 * open nothing: the routes answer it as they answer a request with no
 * credential at all, and only a session opens the file. Each check is made
 * with an API token and with a presign token signed as the removed code signed
 * one, so a verifier that came back would be caught accepting a valid token.
 */
const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Signs a presign token as the removed createEmbeddingPresignToken did: HS256,
 * keyed with the API token row's stored `token` column, naming the API token in
 * `sub` and its team in `aud`, valid for an hour.
 */
const signLegacyPresignToken = (apiTokenRow: {
  id: number;
  token: string;
  teamId: number | null;
  userId: number | null;
}) => {
  const now = Math.floor(Date.now() / 1000);

  const signingInput = [
    base64Url({ alg: 'HS256' }),
    base64Url({
      aud: String(apiTokenRow.teamId ?? apiTokenRow.userId),
      sub: String(apiTokenRow.id),
      iat: now,
      exp: now + 3600,
    }),
  ].join('.');

  const signature = createHmac('sha256', apiTokenRow.token).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
};

const seedDraftWithApiToken = async () => {
  const { user, team } = await seedUser();

  const { token: apiToken } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'bearer-token-refusal',
    expiresIn: null,
  });

  const apiTokenRow = await prisma.apiToken.findFirstOrThrow({
    where: { userId: user.id, name: 'bearer-token-refusal' },
  });

  const draft = await seedBlankDocument(user, team.id);
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: draft.id } });

  return { user, apiToken, presignToken: signLegacyPresignToken(apiTokenRow), draft, item };
};

const CREDENTIALS = ['apiToken', 'presignToken'] as const;

// The procedures and endpoints embedded authoring used. Only getMultiSignDocument, which embedded signing uses, stays.
const REMOVED_TRPC_PROCEDURES = [
  'createEmbeddingPresignToken',
  'verifyEmbeddingPresignToken',
  'createEmbeddingEnvelope',
  'createEmbeddingDocument',
  'createEmbeddingTemplate',
  'updateEmbeddingEnvelope',
  'updateEmbeddingDocument',
  'updateEmbeddingTemplate',
];

const REMOVED_API_PATHS = ['/embedding/create-presign-token', '/embedding/verify-presign-token'];

const API_PREFIXES = ['/api/v2', '/api/v2-beta'];

const REMOVED_AUTHORING_PAGES = [
  '/embed/v1/authoring/document/create',
  '/embed/v1/authoring/template/create',
  '/embed/v2/authoring/envelope/create',
];

const pdfUrl = (envelopeId: string, item: { id: string; documentDataId: string }) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${item.id}/dataId/${item.documentDataId}/current/item.pdf`;

const fileUrl = (envelopeId: string, itemId: string) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${itemId}`;

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

test.describe('File routes refuse a bearer token as they refuse no credential', () => {
  test('the owner opens both routes with a session', async ({ page }) => {
    const { user, draft, item } = await seedDraftWithApiToken();

    await apiSignin({ page, email: user.email });

    expect((await page.request.get(pdfUrl(draft.id, item))).status()).toBe(200);
    expect((await page.request.get(fileUrl(draft.id, item.id))).status()).toBe(200);
  });

  for (const credential of CREDENTIALS) {
    test(`item.pdf answers ${credential} as it answers an anonymous request`, async ({ request }) => {
      const seeded = await seedDraftWithApiToken();
      const { draft, item } = seeded;

      const anonymous = await request.get(pdfUrl(draft.id, item));
      const withBearer = await request.get(pdfUrl(draft.id, item), bearer(seeded[credential]));

      expect(anonymous.status()).toBe(404);
      expect(withBearer.status()).toBe(anonymous.status());
    });

    test(`the envelope item file route answers ${credential} as it answers an anonymous request`, async ({
      request,
    }) => {
      const seeded = await seedDraftWithApiToken();
      const { draft, item } = seeded;

      const anonymous = await request.get(fileUrl(draft.id, item.id));
      const withBearer = await request.get(fileUrl(draft.id, item.id), bearer(seeded[credential]));

      expect(anonymous.status()).toBe(401);
      expect(withBearer.status()).toBe(anonymous.status());
    });

    test(`upload-pdf refuses ${credential}`, async ({ request }) => {
      const seeded = await seedDraftWithApiToken();

      const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
        headers: { Authorization: `Bearer ${seeded[credential]}` },
        multipart: { file: { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') } },
      });

      expect(res.status()).toBe(401);
    });
  }

  for (const prefix of API_PREFIXES) {
    for (const apiPath of REMOVED_API_PATHS) {
      test(`${prefix}${apiPath} no longer exists`, async ({ request }) => {
        const { apiToken, presignToken } = await seedDraftWithApiToken();

        for (const credential of [apiToken, presignToken]) {
          const res = await request.post(`${WEBAPP_BASE_URL}${prefix}${apiPath}`, {
            headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
            data: { token: presignToken },
          });

          expect([401, 404]).toContain(res.status());
        }
      });
    }
  }

  for (const procedure of REMOVED_TRPC_PROCEDURES) {
    test(`the tRPC procedure embeddingPresign.${procedure} no longer exists`, async ({ request }) => {
      const { presignToken } = await seedDraftWithApiToken();

      const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/embeddingPresign.${procedure}`, {
        headers: { Authorization: `Bearer ${presignToken}`, 'Content-Type': 'application/json', origin: OWN_ORIGIN },
        data: JSON.stringify({ json: { token: presignToken } }),
      });

      expect([401, 404]).toContain(res.status());
    });
  }

  test('the embedded authoring pages no longer exist', async ({ request }) => {
    const { presignToken } = await seedDraftWithApiToken();

    for (const page of REMOVED_AUTHORING_PAGES) {
      const res = await request.get(`${WEBAPP_BASE_URL}${page}?token=${presignToken}`);

      expect(res.status(), page).toBe(404);
    }
  });
});
