import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { generateTwoFactorTokenFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-token-from-email';
import { prefixedId } from '@documenso/lib/universal/id';
import { createDocumentAuthOptions, createRecipientAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

/**
 * "Require account" (ACCOUNT access auth) is enforced on the signing pages and
 * mutations. These tests cover the routes that serve document content by
 * recipient token: the three file routes, the item and attachment tRPC
 * queries, and the embed signing loader (#243, #244).
 */

type Level = 'document' | 'recipient';
type Auth = Array<'ACCOUNT' | 'TWO_FACTOR_AUTH'>;

const LEVELS: Level[] = ['document', 'recipient'];

const ACCOUNT: Auth = ['ACCOUNT'];
const ACCOUNT_AND_CODE: Auth = ['ACCOUNT', 'TWO_FACTOR_AUTH'];

test('[RECIPIENT_TOKEN_ACCESS]: C1 the file routes refuse anonymous callers and other users, and serve the recipient', async ({
  playwright,
}) => {
  for (const level of LEVELS) {
    const s = await seedAccountDocument(`c1-${level}`, level, ACCOUNT);
    const [anon, other, recipient] = await contexts(playwright, s);

    for (const url of fileUrls(s)) {
      for (const [who, request] of [
        ['anonymous', anon],
        ['other user', other],
      ] as const) {
        const res = await request.get(url);

        expect(res.status(), `${level} ${who} ${url}`).toBe(401);
        expect(pdfMagic(await res.body()), `${level} ${who} ${url}`).not.toBe('%PDF');
      }

      const twin = await recipient.get(url);

      expect(twin.status(), `${level} recipient ${url}`).toBe(200);
      expect(pdfMagic(await twin.body()), `${level} recipient ${url}`).toBe('%PDF');
    }

    await disposeAll([anon, other, recipient]);
  }
});

test('[RECIPIENT_TOKEN_ACCESS]: C2 the item and attachment queries refuse anonymous callers and other users, and serve the recipient', async ({
  playwright,
}) => {
  for (const level of LEVELS) {
    const s = await seedAccountDocument(`c2-${level}`, level, ACCOUNT);
    const attachment = await seedAttachment(s.envelopeId);
    const [anon, other, recipient] = await contexts(playwright, s);

    for (const [who, request] of [
      ['anonymous', anon],
      ['other user', other],
    ] as const) {
      const items = await getItems(request, s);
      const itemsBody = await items.text();

      expect(items.status(), `${level} ${who} items`).toBe(401);
      expect(itemsBody, `${level} ${who} items`).not.toContain(s.itemId);
      expect(itemsBody, `${level} ${who} items`).not.toContain(s.documentDataId);

      const attachments = await findAttachments(request, s);
      const attachmentsBody = await attachments.text();

      expect(attachments.status(), `${level} ${who} attachments`).toBe(401);
      expect(attachmentsBody, `${level} ${who} attachments`).not.toContain(attachment.label);
      expect(attachmentsBody, `${level} ${who} attachments`).not.toContain(attachment.data);
    }

    const items = await getItems(recipient, s);

    expect(items.status(), `${level} recipient items`).toBe(200);
    expect(await items.text(), `${level} recipient items`).toContain(s.itemId);

    const attachments = await findAttachments(recipient, s);

    expect(attachments.status(), `${level} recipient attachments`).toBe(200);
    expect(await attachments.text(), `${level} recipient attachments`).toContain(attachment.label);

    await disposeAll([anon, other, recipient]);
  }
});

test('[RECIPIENT_TOKEN_ACCESS]: C3 the embed signing loader refuses anonymous callers and other users, and serves the recipient', async ({
  playwright,
}) => {
  for (const level of LEVELS) {
    const s = await seedAccountDocument(`c3-${level}`, level, ACCOUNT);
    const [anon, other, recipient] = await contexts(playwright, s);

    const urls = [`${WEBAPP_BASE_URL}/embed/sign/${s.token}`, `${WEBAPP_BASE_URL}/embed/sign/${s.token}.data`];

    for (const url of urls) {
      for (const [who, request] of [
        ['anonymous', anon],
        ['other user', other],
      ] as const) {
        const res = await request.get(url);
        const body = await res.text();

        expect(res.status(), `${level} ${who} ${url}`).toBe(401);
        expect(body, `${level} ${who} ${url}`).toContain('embed-authentication-required');
        expect(body, `${level} ${who} ${url}`).not.toContain(s.envelopeId);
        expect(body, `${level} ${who} ${url}`).not.toContain(s.itemId);
        expect(body, `${level} ${who} ${url}`).not.toContain(s.documentDataId);
      }
    }

    const twin = await recipient.get(`${WEBAPP_BASE_URL}/embed/sign/${s.token}.data`);

    expect(twin.status(), `${level} recipient`).toBe(200);
    expect(await twin.text(), `${level} recipient`).toContain(s.itemId);

    await disposeAll([anon, other, recipient]);
  }
});

test('[RECIPIENT_TOKEN_ACCESS]: C4 with account plus emailed code, the recipient needs both on the file routes and queries', async ({
  playwright,
}) => {
  for (const level of LEVELS) {
    const s = await seedAccountDocument(`c4-${level}`, level, ACCOUNT_AND_CODE);
    const attachment = await seedAttachment(s.envelopeId);
    const [anon, other, recipient] = await contexts(playwright, s);
    const [anonWithCode] = await contexts(playwright, s, 'anon-only');

    // Signed in as the recipient, no access cookie.
    await expectRefusedEverywhere(recipient, s, attachment, `${level} account without code`);

    // Access cookie, but not signed in.
    await verifyAccessCode(anonWithCode, s);
    await expectRefusedEverywhere(anonWithCode, s, attachment, `${level} code without account`);

    // Both.
    await verifyAccessCode(recipient, s);

    for (const url of fileUrls(s)) {
      const res = await recipient.get(url);

      expect(res.status(), `${level} both ${url}`).toBe(200);
      expect(pdfMagic(await res.body()), `${level} both ${url}`).toBe('%PDF');
    }

    const items = await getItems(recipient, s);

    expect(items.status(), `${level} both items`).toBe(200);
    expect(await items.text(), `${level} both items`).toContain(s.itemId);

    const attachments = await findAttachments(recipient, s);

    expect(attachments.status(), `${level} both attachments`).toBe(200);
    expect(await attachments.text(), `${level} both attachments`).toContain(attachment.label);

    await disposeAll([anon, other, recipient, anonWithCode]);
  }
});

/**
 * Control: a document with no access auth is served to a link holder.
 */
test('[RECIPIENT_TOKEN_ACCESS]: C5 with no access auth, every route serves a link holder', async ({ playwright }) => {
  const s = await seedAccountDocument('c5', 'document', []);
  const attachment = await seedAttachment(s.envelopeId);
  const anon = await playwright.request.newContext();

  for (const url of fileUrls(s)) {
    const res = await anon.get(url);

    expect(res.status(), url).toBe(200);
    expect(pdfMagic(await res.body()), url).toBe('%PDF');
  }

  const items = await getItems(anon, s);

  expect(items.status()).toBe(200);
  expect(await items.text()).toContain(s.itemId);

  const attachments = await findAttachments(anon, s);

  expect(attachments.status()).toBe(200);
  expect(await attachments.text()).toContain(attachment.label);

  const embed = await anon.get(`${WEBAPP_BASE_URL}/embed/sign/${s.token}.data`);

  expect(embed.status()).toBe(200);
  expect(await embed.text()).toContain(s.itemId);

  await anon.dispose();
});

/**
 * Control: the QR link serves a completed document without a cookie, even when
 * the document asks for an account.
 */
test('[RECIPIENT_TOKEN_ACCESS]: C6 the QR link still serves a completed document to an anonymous caller', async ({
  request,
}) => {
  const { user, team } = await seedUser();
  const qrToken = prefixedId('qr');

  const document = await seedCompletedDocument(user, team.id, [uniqueEmail('c6')], {
    createDocumentOptions: {
      qrToken,
      authOptions: createDocumentAuthOptions({ globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] }),
    },
  });
  const item = document.envelopeItems[0];

  for (const url of [
    `${WEBAPP_BASE_URL}/api/files/token/${qrToken}/envelopeItem/${item.id}`,
    `${WEBAPP_BASE_URL}/api/files/token/${qrToken}/envelopeItem/${item.id}/download/signed`,
  ]) {
    const res = await request.get(url);

    expect(res.status(), url).toBe(200);
    expect(pdfMagic(await res.body()), url).toBe('%PDF');
  }
});

/**
 * Direct templates use a placeholder recipient. ACCOUNT on a direct template
 * means any signed-in user, so the PDF the /d/:token page fetches by token must
 * be served to an ordinary signed-in user who is not the owner.
 */
const seedDirectTemplateWithAuth = async (accessAuth: Auth, internalVersion: 1 | 2) => {
  const { user, team } = await seedUser();
  const { user: visitor } = await seedUser();

  const template = await seedDirectTemplate({
    title: `C8 direct template ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion,
    createTemplateOptions: {
      authOptions: createDocumentAuthOptions({ globalAccessAuth: accessAuth, globalActionAuth: [] }),
    },
  });

  const directRecipient = template.recipients.find((r) => r.id === template.directLink?.directTemplateRecipientId)!;
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

  return {
    directToken: template.directLink!.token,
    visitorEmail: visitor.email,
    pdfUrl: `${WEBAPP_BASE_URL}/api/files/token/${directRecipient.token}/envelope/${template.id}/envelopeItem/${item.id}/dataId/${item.documentDataId}/current/item.pdf`,
  };
};

for (const version of [1, 2] as const) {
  test(`[RECIPIENT_TOKEN_ACCESS]: C8 V${version} ACCOUNT direct template renders its PDF for an ordinary signed-in user`, async ({
    page,
  }) => {
    const s = await seedDirectTemplateWithAuth(ACCOUNT, version);
    const pdfResponses: Array<{ url: string; status: number }> = [];

    page.on('response', (res) => {
      if (/\/api\/files\/token\/.+item\.pdf/.test(res.url())) {
        pdfResponses.push({ url: res.url(), status: res.status() });
      }
    });

    await apiSignin({ page, email: s.visitorEmail });
    await page.goto(`${WEBAPP_BASE_URL}/d/${s.directToken}`);

    await expect(page.getByText('Authentication required')).toHaveCount(0);
    await expect.poll(() => pdfResponses.length, { timeout: 20_000 }).toBeGreaterThan(0);

    expect(
      pdfResponses.filter((r) => r.status !== 200),
      JSON.stringify(pdfResponses),
    ).toEqual([]);
    await expect(page.locator('[data-pdf-content], canvas, .react-pdf__Page').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/unable to load|failed to load|something went wrong/i)).toHaveCount(0);
  });
}

test('[RECIPIENT_TOKEN_ACCESS]: C8 the direct template PDF route answers 200 to a signed-in user and 401 to anonymous', async ({
  playwright,
}) => {
  const s = await seedDirectTemplateWithAuth(ACCOUNT, 1);
  const anon = await playwright.request.newContext();
  const visitor = await playwright.request.newContext();

  await signIn(visitor, s.visitorEmail);

  const anonRes = await anon.get(s.pdfUrl);

  expect(anonRes.status(), 'anonymous').toBe(401);
  expect(pdfMagic(await anonRes.body())).not.toBe('%PDF');

  const res = await visitor.get(s.pdfUrl);

  expect(res.status(), 'signed-in non-owner').toBe(200);
  expect(pdfMagic(await res.body())).toBe('%PDF');

  await disposeAll([anon, visitor]);
});

test('[RECIPIENT_TOKEN_ACCESS]: C8 a direct template with no access auth serves its PDF to anonymous', async ({
  playwright,
  page,
}) => {
  const s = await seedDirectTemplateWithAuth([], 1);
  const anon = await playwright.request.newContext();
  const res = await anon.get(s.pdfUrl);

  expect(res.status()).toBe(200);
  expect(pdfMagic(await res.body())).toBe('%PDF');

  await page.goto(`${WEBAPP_BASE_URL}/d/${s.directToken}`);
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();

  await anon.dispose();
});

type Seeded = Awaited<ReturnType<typeof seedAccountDocument>>;

const uniqueEmail = (prefix: string) =>
  `recipient-token-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@documenso.com`;

/**
 * A pending document whose first recipient is a real user, with the given
 * access auth set on the document or on that recipient.
 */
const seedAccountDocument = async (prefix: string, level: Level, accessAuth: Auth) => {
  const { user, team } = await seedUser();
  const { user: recipientUser } = await seedUser();
  const { user: otherUser } = await seedUser();

  const documentAuth =
    level === 'document'
      ? { authOptions: createDocumentAuthOptions({ globalAccessAuth: accessAuth, globalActionAuth: [] }) }
      : {};

  const seeded = await seedPendingDocument(user, team.id, [recipientUser, uniqueEmail(prefix)], {
    createDocumentOptions: documentAuth,
  });

  const recipient = seeded.recipients.find((r) => r.email === recipientUser.email)!;

  if (level === 'recipient') {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { authOptions: createRecipientAuthOptions({ accessAuth, actionAuth: [] }) },
    });
  }

  const item = seeded.envelopeItems[0];

  return {
    token: recipient.token,
    recipientEmail: recipientUser.email,
    otherEmail: otherUser.email,
    envelopeId: seeded.id,
    itemId: item.id,
    documentDataId: item.documentDataId,
  };
};

const seedAttachment = (envelopeId: string) =>
  prisma.envelopeAttachment.create({
    data: {
      envelopeId,
      type: 'link',
      label: `Attachment ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      data: `https://example.com/attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });

/** S1, S2 and S3. */
const fileUrls = (s: Seeded) => {
  const base = `${WEBAPP_BASE_URL}/api/files/token/${s.token}`;

  return [
    `${base}/envelopeItem/${s.itemId}`,
    `${base}/envelopeItem/${s.itemId}/download/signed`,
    `${base}/envelope/${s.envelopeId}/envelopeItem/${s.itemId}/dataId/${s.documentDataId}/current/item.pdf`,
  ];
};

/** S4. */
const getItems = (request: APIRequestContext, s: Seeded) => {
  const input = encodeURIComponent(
    JSON.stringify({ json: { envelopeId: s.envelopeId, access: { type: 'recipient', token: s.token } } }),
  );

  return request.get(`${WEBAPP_BASE_URL}/api/trpc/envelope.item.getManyByToken?input=${input}`);
};

/** S5. */
const findAttachments = (request: APIRequestContext, s: Seeded) => {
  const input = encodeURIComponent(JSON.stringify({ json: { envelopeId: s.envelopeId, token: s.token } }));

  return request.get(`${WEBAPP_BASE_URL}/api/trpc/envelope.attachment.find?input=${input}`);
};

const expectRefusedEverywhere = async (
  request: APIRequestContext,
  s: Seeded,
  attachment: { label: string; data: string },
  label: string,
) => {
  for (const url of fileUrls(s)) {
    const res = await request.get(url);

    expect(res.status(), `${label} ${url}`).toBe(401);
    expect(pdfMagic(await res.body()), `${label} ${url}`).not.toBe('%PDF');
  }

  const items = await getItems(request, s);
  const itemsBody = await items.text();

  expect(items.status(), `${label} items`).toBe(401);
  expect(itemsBody, `${label} items`).not.toContain(s.itemId);

  const attachments = await findAttachments(request, s);
  const attachmentsBody = await attachments.text();

  expect(attachments.status(), `${label} attachments`).toBe(401);
  expect(attachmentsBody, `${label} attachments`).not.toContain(attachment.label);
  expect(attachmentsBody, `${label} attachments`).not.toContain(attachment.data);
};

const signIn = async (request: APIRequestContext, email: string) => {
  const csrf = await (await request.get(`${WEBAPP_BASE_URL}/api/auth/csrf`)).json();

  const res = await request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/authorize`, {
    data: { email, password: 'password', csrfToken: csrf.csrfToken },
  });

  expect(res.ok(), `sign in ${email}`).toBeTruthy();

  const session = await (await request.get(`${WEBAPP_BASE_URL}/api/auth/session`)).json();

  expect(session.isAuthenticated, `session ${email}`).toBe(true);
};

/** Anonymous, signed in as another user, signed in as the recipient. */
const contexts = async (
  playwright: { request: { newContext: () => Promise<APIRequestContext> } },
  s: Seeded,
  only?: 'anon-only',
) => {
  const anon = await playwright.request.newContext();

  if (only) {
    return [anon];
  }

  const other = await playwright.request.newContext();
  const recipient = await playwright.request.newContext();

  await signIn(other, s.otherEmail);
  await signIn(recipient, s.recipientEmail);

  return [anon, other, recipient];
};

const disposeAll = async (requests: APIRequestContext[]) => {
  for (const request of requests) {
    await request.dispose();
  }
};

const verifyAccessCode = async (request: APIRequestContext, s: Seeded): Promise<APIResponse> => {
  const code = await generateTwoFactorTokenFromEmail({ email: s.recipientEmail, envelopeId: s.envelopeId });

  const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.verify2FA`, {
    headers: { 'content-type': 'application/json', origin: new URL(WEBAPP_BASE_URL).origin },
    data: JSON.stringify({
      json: { token: s.token, authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code } },
    }),
  });

  expect(res.ok()).toBeTruthy();

  return res;
};

const pdfMagic = (body: Buffer) => body.subarray(0, 4).toString('latin1');
