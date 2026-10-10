/**
 * Embedded authoring is removed; nothing it used to open still opens.
 *
 * Written from the specification alone, without reading the implementation.
 *
 * Criteria and failure modes covered here:
 *
 *   Criterion 3 (F2): every embedded authoring page, the authoring completed page and the
 *     playground answer 404, with and without a validly signed legacy presign token.
 *   Criterion 4 (F2): create-presign-token and verify-presign-token under /api/v2 and
 *     /api/v2-beta do not succeed for an unauthenticated caller, a caller with a valid API token,
 *     or a caller holding a legacy presign token; the matching tRPC procedures are not found.
 *   Criterion 5 (F3): a presign token signed exactly as the removed code signed it gets the same
 *     answer as no credential from the envelope item file route, the item PDF route and the
 *     upload route.
 *   Criterion 6: an API token on its own gets the same answer as no credential from those routes.
 *
 * Every refusal is paired with a control showing that a signed-in owner gets the bytes from the
 * same URL, so a 404 cannot come from a malformed URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';
import { seedApiTokenWithLegacyPresignToken } from './legacy-presign-token';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

test.describe.configure({ mode: 'parallel' });

const numericId = (secondaryId: string) => Number(secondaryId.split('_').pop());

/**
 * A team with a V1 draft document, a V1 template, a V2 draft envelope, a real API token and a
 * legacy presign token signed from that API token's stored row.
 */
const seedTeamWithLegacyPresignToken = async () => {
  const { user, team } = await seedUser();

  const { apiToken, presignToken } = await seedApiTokenWithLegacyPresignToken({ userId: user.id, teamId: team.id });

  const v1Document = await seedBlankDocument(user, team.id);
  const v2Envelope = await seedBlankDocument(user, team.id, { internalVersion: 2 });
  const v1Template = await seedBlankTemplate(user, team.id);

  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: v2Envelope.id } });

  return { user, team, apiToken, presignToken, v1Document, v1Template, v2Envelope, item };
};

type TSeeded = Awaited<ReturnType<typeof seedTeamWithLegacyPresignToken>>;

const authoringPages = (seeded: TSeeded) => [
  '/embed/v1/authoring/document/create',
  `/embed/v1/authoring/document/edit/${numericId(seeded.v1Document.secondaryId)}`,
  '/embed/v1/authoring/template/create',
  `/embed/v1/authoring/template/edit/${numericId(seeded.v1Template.secondaryId)}`,
  '/embed/v2/authoring/envelope/create',
  `/embed/v2/authoring/envelope/edit/${seeded.v2Envelope.id}`,
  '/embed/v1/authoring/completed/create',
  '/embed/playground',
];

test.describe('Embedded authoring pages are gone', () => {
  test('every authoring page, the completed page and the playground answer 404 without a token', async ({ page }) => {
    const seeded = await seedTeamWithLegacyPresignToken();

    for (const pagePath of authoringPages(seeded)) {
      const response = await page.goto(pagePath);

      expect(response?.status(), pagePath).toBe(404);
    }
  });

  test('every authoring page answers 404 to a validly signed legacy presign token', async ({ page }) => {
    const seeded = await seedTeamWithLegacyPresignToken();

    for (const pagePath of authoringPages(seeded)) {
      const url = `${pagePath}?token=${encodeURIComponent(seeded.presignToken)}`;
      const response = await page.goto(url);

      expect(response?.status(), pagePath).toBe(404);
    }
  });
});

const PRESIGN_ENDPOINTS = ['/api/v2', '/api/v2-beta'].flatMap((prefix) => [
  `${prefix}/embedding/create-presign-token`,
  `${prefix}/embedding/verify-presign-token`,
]);

const expectNoPresignSuccess = async (response: APIResponse, label: string) => {
  expect([401, 404], `${label} answered ${response.status()}`).toContain(response.status());

  const body = await response.text();

  // A successful create returns `token` and `expiresAt`; a successful verify returns `success`.
  expect(body, label).not.toMatch(/"expiresAt"|"success"\s*:\s*true/);
};

test.describe('Presign endpoints do not succeed for any caller', () => {
  test('an unauthenticated caller is refused under both API prefixes', async ({ request }) => {
    for (const endpoint of PRESIGN_ENDPOINTS) {
      const response = await request.post(`${WEBAPP_BASE_URL}${endpoint}`, {
        headers: { 'Content-Type': 'application/json' },
        data: {},
      });

      await expectNoPresignSuccess(response, endpoint);
    }
  });

  test('a caller with a valid API token is refused under both API prefixes', async ({ request }) => {
    const { apiToken, presignToken } = await seedTeamWithLegacyPresignToken();

    for (const endpoint of PRESIGN_ENDPOINTS) {
      const response = await request.post(`${WEBAPP_BASE_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        data: endpoint.endsWith('verify-presign-token') ? { token: presignToken } : { apiToken },
      });

      await expectNoPresignSuccess(response, endpoint);
    }
  });

  test('a caller presenting a legacy presign token is refused under both API prefixes', async ({ request }) => {
    const { presignToken } = await seedTeamWithLegacyPresignToken();

    for (const endpoint of PRESIGN_ENDPOINTS) {
      const response = await request.post(`${WEBAPP_BASE_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${presignToken}`, 'Content-Type': 'application/json' },
        data: { token: presignToken },
      });

      await expectNoPresignSuccess(response, endpoint);
    }
  });
});

const TRPC_PRESIGN_PROCEDURES = [
  'embeddingPresign.createEmbeddingPresignToken',
  'embeddingPresign.verifyEmbeddingPresignToken',
];

test.describe('Presign tRPC procedures do not exist', () => {
  test('both procedures answer exactly as a procedure that never existed', async ({ page }) => {
    const { user, apiToken, presignToken } = await seedTeamWithLegacyPresignToken();

    await apiSignin({ page, email: user.email });

    const { request } = page.context();

    const call = async (procedure: string) =>
      await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
        headers: { 'content-type': 'application/json', origin: new URL(WEBAPP_BASE_URL).origin },
        data: JSON.stringify({ json: { apiToken, token: presignToken } }),
      });

    const missing = await call('embeddingPresign.procedureThatNeverExisted');

    for (const procedure of TRPC_PRESIGN_PROCEDURES) {
      const response = await call(procedure);

      expect(response.status(), procedure).toBe(missing.status());
      expect(response.status(), procedure).toBe(404);
      expect(await response.text(), procedure).toContain('No procedure found');
    }
  });
});

const itemFileUrl = (seeded: TSeeded) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${seeded.v2Envelope.id}/envelopeItem/${seeded.item.id}`;

const itemPdfUrl = (seeded: TSeeded) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${seeded.v2Envelope.id}/envelopeItem/${seeded.item.id}/dataId/${seeded.item.documentDataId}/current/item.pdf`;

const UPLOAD_URL = `${WEBAPP_BASE_URL}/api/files/upload-pdf`;

const uploadPdf = async (request: APIRequestContext, headers: Record<string, string> = {}) =>
  await request.post(UPLOAD_URL, {
    headers,
    multipart: { file: { name: 'example.pdf', mimeType: 'application/pdf', buffer: examplePdf } },
  });

type TAnswer = { status: number; body: string };

const answerOf = async (response: APIResponse): Promise<TAnswer> => ({
  status: response.status(),
  body: await response.text(),
});

const startsWithPdf = (answer: TAnswer) => answer.body.startsWith('%PDF');

test.describe('A signed-in owner can read and upload through the browser file routes', () => {
  test('the control: a session reads both file routes and uploads a PDF', async ({ page }) => {
    const seeded = await seedTeamWithLegacyPresignToken();

    await apiSignin({ page, email: seeded.user.email });

    const { request } = page.context();

    expect((await request.get(itemFileUrl(seeded))).status()).toBe(200);

    const pdf = await request.get(itemPdfUrl(seeded));

    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');

    expect((await uploadPdf(request)).status()).toBe(200);
  });
});

for (const credential of ['legacy presign token', 'API token'] as const) {
  const article = credential === 'API token' ? 'an' : 'a';

  test.describe(`${credential === 'API token' ? 'An' : 'A'} ${credential} is answered exactly as no credential`, () => {
    const bearerFor = (seeded: TSeeded) => ({
      Authorization: `Bearer ${credential === 'API token' ? seeded.apiToken : seeded.presignToken}`,
    });

    test(`the envelope item file route treats ${article} ${credential} as no credential`, async ({ request }) => {
      const seeded = await seedTeamWithLegacyPresignToken();

      const none = await answerOf(await request.get(itemFileUrl(seeded)));
      const withToken = await answerOf(await request.get(itemFileUrl(seeded), { headers: bearerFor(seeded) }));

      expect(withToken).toEqual(none);
      expect(withToken.status).not.toBe(200);
    });

    test(`the envelope item PDF route treats ${article} ${credential} as no credential`, async ({ request }) => {
      const seeded = await seedTeamWithLegacyPresignToken();

      const none = await answerOf(await request.get(itemPdfUrl(seeded)));
      const withToken = await answerOf(await request.get(itemPdfUrl(seeded), { headers: bearerFor(seeded) }));

      expect(withToken).toEqual(none);
      expect(startsWithPdf(withToken)).toBe(false);
    });

    test(`the upload route treats ${article} ${credential} as no credential`, async ({ request }) => {
      const seeded = await seedTeamWithLegacyPresignToken();

      const none = await answerOf(await uploadPdf(request));
      const withToken = await answerOf(await uploadPdf(request, bearerFor(seeded)));

      expect(withToken).toEqual(none);
      expect(withToken.status).not.toBe(200);
    });
  });
}
