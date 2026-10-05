import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { generateTwoFactorTokenFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-token-from-email';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * A recipient whose access auth is an emailed code used to see the whole
 * document before entering it; the code was only asked for at completion.
 * The page and the token file routes now hold the document back until the
 * code has been verified.
 */
test('[DOCUMENT_AUTH]: withholds the document until the emailed access code is entered', async ({ page }) => {
  const { user, team } = await seedUser();

  const document = await seedPendingDocument(user, team.id, [`access-2fa-gate-${Date.now()}@documenso.com`], {
    createDocumentOptions: {
      authOptions: createDocumentAuthOptions({
        globalAccessAuth: ['TWO_FACTOR_AUTH'],
        globalActionAuth: [],
      }),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });

  const fileUrl = `${WEBAPP_BASE_URL}/api/files/token/${recipient.token}/envelopeItem/${envelopeItem.id}`;

  await page.goto(`/sign/${recipient.token}`);

  await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign Document' })).not.toBeVisible();

  expect((await page.context().request.get(fileUrl)).status()).toBe(401);

  const code = await generateTwoFactorTokenFromEmail({ email: recipient.email, envelopeId: document.id });

  // Sent through the page's own cookie jar, as the gate's form does, so the
  // cookie it sets applies to the page.
  const verifyRes = await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.verify2FA`, {
    headers: { 'content-type': 'application/json', origin: new URL(WEBAPP_BASE_URL).origin },
    data: JSON.stringify({
      json: { token: recipient.token, authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code } },
    }),
  });

  expect(verifyRes.ok()).toBeTruthy();

  await page.reload();

  await expect(page.getByRole('heading', { name: 'Sign Document' })).toBeVisible();

  expect((await page.context().request.get(fileUrl)).status()).toBe(200);
});

test('[DOCUMENT_AUTH]: refuses a wrong access code and keeps the document back', async ({ page }) => {
  const { user, team } = await seedUser();

  const document = await seedPendingDocument(user, team.id, [`access-2fa-wrong-${Date.now()}@documenso.com`], {
    createDocumentOptions: {
      authOptions: createDocumentAuthOptions({
        globalAccessAuth: ['TWO_FACTOR_AUTH'],
        globalActionAuth: [],
      }),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  const verifyRes = await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.verify2FA`, {
    headers: { 'content-type': 'application/json', origin: new URL(WEBAPP_BASE_URL).origin },
    data: JSON.stringify({
      json: { token: recipient.token, authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: '000000' } },
    }),
  });

  expect(verifyRes.ok()).toBeFalsy();

  await page.goto(`/sign/${recipient.token}`);

  await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
});

/**
 * The first test covers the token view route. The token download route and the
 * token item.pdf route serve the same bytes, so each must refuse them until the
 * code has been entered. Both are then fetched again with the code's cookie to
 * show that the refusal came from the gate and not from a malformed URL.
 */
test('[DOCUMENT_AUTH]: withholds the download and item.pdf bytes until the emailed access code is entered', async ({
  page,
}) => {
  const { user, team } = await seedUser();

  const document = await seedPendingDocument(user, team.id, [`access-2fa-bytes-${Date.now()}@documenso.com`], {
    createDocumentOptions: {
      authOptions: createDocumentAuthOptions({
        globalAccessAuth: ['TWO_FACTOR_AUTH'],
        globalActionAuth: [],
      }),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });

  const tokenBase = `${WEBAPP_BASE_URL}/api/files/token/${recipient.token}`;

  const byteUrls = [
    `${tokenBase}/envelopeItem/${envelopeItem.id}/download/original`,
    `${tokenBase}/envelope/${document.id}/envelopeItem/${envelopeItem.id}/dataId/${envelopeItem.documentDataId}/initial/item.pdf`,
  ];

  const { request } = page.context();

  for (const url of byteUrls) {
    const res = await request.get(url);

    expect(res.status(), url).toBe(401);
    expect((await res.body()).subarray(0, 4).toString('latin1'), url).not.toBe('%PDF');
  }

  const code = await generateTwoFactorTokenFromEmail({ email: recipient.email, envelopeId: document.id });

  const verifyRes = await request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.verify2FA`, {
    headers: { 'content-type': 'application/json', origin: new URL(WEBAPP_BASE_URL).origin },
    data: JSON.stringify({
      json: { token: recipient.token, authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code } },
    }),
  });

  expect(verifyRes.ok()).toBeTruthy();

  for (const url of byteUrls) {
    const res = await request.get(url);

    expect(res.status(), url).toBe(200);
    expect((await res.body()).subarray(0, 4).toString('latin1'), url).toBe('%PDF');
  }
});

/**
 * The tRPC query document.getDocumentByToken used to return the item's
 * documentData, the PDF itself under the database transport, to a signed-in
 * recipient without asking for the code. Nothing called it, so it was removed.
 */
test('[DOCUMENT_AUTH]: gives a signed-in recipient no document data over tRPC before the access code', async ({
  page,
}) => {
  const { user, team } = await seedUser();
  const { user: recipientUser } = await seedUser();

  const document = await seedPendingDocument(user, team.id, [recipientUser], {
    createDocumentOptions: {
      authOptions: createDocumentAuthOptions({
        globalAccessAuth: ['TWO_FACTOR_AUTH'],
        globalActionAuth: [],
      }),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  await apiSignin({ page, email: recipientUser.email });

  const input = encodeURIComponent(JSON.stringify({ json: { token: recipient.token } }));

  const res = await page
    .context()
    .request.get(`${WEBAPP_BASE_URL}/api/trpc/document.getDocumentByToken?input=${input}`);

  expect(res.ok()).toBeFalsy();
  expect(await res.text()).not.toContain('documentData');
});
