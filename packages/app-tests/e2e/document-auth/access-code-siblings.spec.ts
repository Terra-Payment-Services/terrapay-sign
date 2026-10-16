import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { generateTwoFactorTokenFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-token-from-email';
import { prefixedId } from '@documenso/lib/universal/id';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const PDF_PAGE_SELECTOR = 'img[data-page-number]';

test.describe.configure({ mode: 'parallel' });

/**
 * The signing page already asks for the emailed access code before it shows the
 * document (access-auth-2fa-gate.spec.ts). These tests cover the paths beside it:
 * the completion page, the QR-token file routes and the attachment list.
 */

test('[DOCUMENT_AUTH]: the completion page gives nothing of the document away before the access code', async ({
  page,
  request,
}) => {
  const { document, recipient, documentDataIds, data } = await seedPendingWithSignedRecipient('c1', true);

  const urls = [
    `${WEBAPP_BASE_URL}/sign/${recipient.token}/complete`,
    `${WEBAPP_BASE_URL}/sign/${recipient.token}/complete.data`,
  ];

  for (const url of urls) {
    const body = await (await request.get(url)).text();

    expect(body, url).not.toContain(document.qrToken);

    for (const id of documentDataIds) {
      expect(body, url).not.toContain(id);
    }

    expect(body, url).not.toContain(data.slice(100, 300));
  }

  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Document Signed' })).not.toBeVisible();
});

/**
 * The gate on the completion page must open once the code is entered, or the
 * fix for the test above would lock the recipient out.
 */
test('[DOCUMENT_AUTH]: the completion page opens once the access code is entered', async ({ page }) => {
  const { document, recipient } = await seedPendingWithSignedRecipient('c2', true);

  await verifyAccessCode(page.context().request, recipient, document.id);

  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
});

/**
 * Control: a recipient with no access auth reaches the completion page without
 * any cookie.
 */
test('[DOCUMENT_AUTH]: the completion page opens without a code for a recipient with no access auth', async ({
  page,
}) => {
  const { recipient } = await seedPendingWithSignedRecipient('c3', false);

  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
});

/**
 * The QR token exists from the moment the envelope is created, but it is meant
 * only for the certificate of a finished document. A pending envelope's file
 * routes must not answer to it, whether or not its recipients need a code.
 */
test('[DOCUMENT_AUTH]: the QR-token file routes refuse a pending document', async ({ request }) => {
  for (const withAccessCode of [true, false]) {
    const { document } = await seedPendingWithSignedRecipient(`c4-${withAccessCode}`, withAccessCode);
    const item = document.envelopeItems[0];

    for (const url of qrFileUrls(document.qrToken, document.id, item)) {
      const res = await request.get(url);

      expect(res.status(), `${withAccessCode} ${url}`).toBe(404);
      expect(pdfMagic(await res.body()), `${withAccessCode} ${url}`).not.toBe('%PDF');
    }
  }
});

/**
 * A deleted document must not stay reachable through the QR link printed on
 * its certificate.
 */
test('[DOCUMENT_AUTH]: the QR-token file routes and share page refuse a deleted completed document', async ({
  page,
  request,
}) => {
  const { document, item, qrToken } = await seedCompletedWithQr('c5', false);

  await prisma.envelope.update({ where: { id: document.id }, data: { deletedAt: new Date() } });

  for (const url of qrFileUrls(qrToken, document.id, item)) {
    const res = await request.get(url);

    expect(res.status(), url).toBe(404);
    expect(pdfMagic(await res.body()), url).not.toBe('%PDF');
  }

  const shareRes = await request.get(`${WEBAPP_BASE_URL}/share/${qrToken}`, { maxRedirects: 0 });

  expect(shareRes.status()).not.toBe(200);

  await page.goto(`/share/${qrToken}`);
  await page.waitForLoadState('networkidle');

  await expect(page.locator(PDF_PAGE_SELECTOR)).toHaveCount(0);
});

/**
 * Control: the QR link serves a completed document to anyone holding the
 * certificate, with no cookie, including one whose recipients needed the code.
 */
test('[DOCUMENT_AUTH]: the QR link still serves a completed document without a cookie', async ({ page, request }) => {
  for (const withAccessCode of [true, false]) {
    const { item, qrToken, document } = await seedCompletedWithQr(`c6-${withAccessCode}`, withAccessCode);

    for (const url of qrFileUrls(qrToken, document.id, item)) {
      const res = await request.get(url);

      expect(res.status(), `${withAccessCode} ${url}`).toBe(200);
      expect(pdfMagic(await res.body()), `${withAccessCode} ${url}`).toBe('%PDF');
    }

    const shareRes = await request.get(`${WEBAPP_BASE_URL}/share/${qrToken}`, { maxRedirects: 0 });

    expect(shareRes.status(), `${withAccessCode}`).toBe(200);

    await page.goto(`/share/${qrToken}`);

    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
  }
});

/**
 * The attachment list is part of the document, so a recipient who needs the
 * code must enter it before the list is returned.
 */
test('[DOCUMENT_AUTH]: the attachment list is withheld until the access code is entered', async ({ playwright }) => {
  const { document, recipient } = await seedPendingWithSignedRecipient('c7', true);
  const attachment = await seedAttachment(document.id);

  const request = await playwright.request.newContext();

  const before = await findAttachments(request, document.id, recipient.token);
  const beforeBody = await before.text();

  expect(before.ok()).toBeFalsy();
  expect(beforeBody).not.toContain(attachment.label);
  expect(beforeBody).not.toContain(attachment.data);

  await verifyAccessCode(request, recipient, document.id);

  const after = await findAttachments(request, document.id, recipient.token);

  expect(after.ok()).toBeTruthy();
  expect(attachmentLabels(await after.json())).toEqual([attachment.label]);

  await request.dispose();
});

/**
 * Control: a recipient with no access auth gets the attachment list without a
 * cookie.
 */
test('[DOCUMENT_AUTH]: the attachment list is returned without a code for a recipient with no access auth', async ({
  request,
}) => {
  const { document, recipient } = await seedPendingWithSignedRecipient('c8', false);
  const attachment = await seedAttachment(document.id);

  const res = await findAttachments(request, document.id, recipient.token);

  expect(res.ok()).toBeTruthy();
  expect(attachmentLabels(await res.json())).toEqual([attachment.label]);
});

/**
 * The rejected page names the document and may show what the recipient typed
 * into it, so it must ask for the code first.
 */
test('[DOCUMENT_AUTH]: the rejected page gives nothing of the document away before the access code', async ({
  page,
  request,
}) => {
  const { document, recipient, customText } = await seedEndedRecipient('c10', true, 'rejected');

  for (const url of endedPageUrls(recipient.token, 'rejected')) {
    const body = await (await request.get(url)).text();

    expect(body, url).not.toContain(document.title);
    expect(body, url).not.toContain(customText);
  }

  await page.goto(`/sign/${recipient.token}/rejected`);

  await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
  await expect(page.getByText('Document Rejected').first()).not.toBeVisible();

  await verifyAccessCode(page.context().request, recipient, document.id);

  await page.goto(`/sign/${recipient.token}/rejected`);

  await expect(page.getByText('Document Rejected').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
});

/**
 * Control: a recipient with no access auth sees the rejected page without a
 * cookie.
 */
test('[DOCUMENT_AUTH]: the rejected page opens without a code for a recipient with no access auth', async ({
  page,
}) => {
  const { recipient } = await seedEndedRecipient('c10-control', false, 'rejected');

  await page.goto(`/sign/${recipient.token}/rejected`);

  await expect(page.getByText('Document Rejected').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
});

/**
 * The expired page names the document, so it must ask for the code first.
 */
test('[DOCUMENT_AUTH]: the expired page withholds the document title before the access code', async ({
  page,
  request,
}) => {
  const { document, recipient } = await seedEndedRecipient('c11', true, 'expired');

  for (const url of endedPageUrls(recipient.token, 'expired')) {
    const body = await (await request.get(url)).text();

    expect(body, url).not.toContain(document.title);
  }

  await page.goto(`/sign/${recipient.token}/expired`);

  await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
  await expect(page.getByText('Signing Deadline Expired')).not.toBeVisible();

  await verifyAccessCode(page.context().request, recipient, document.id);

  await page.goto(`/sign/${recipient.token}/expired`);

  await expect(page.getByText('Signing Deadline Expired')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
});

/**
 * Control: a recipient with no access auth sees the expired page without a
 * cookie.
 */
test('[DOCUMENT_AUTH]: the expired page opens without a code for a recipient with no access auth', async ({ page }) => {
  const { recipient } = await seedEndedRecipient('c11-control', false, 'expired');

  await page.goto(`/sign/${recipient.token}/expired`);

  await expect(page.getByText('Signing Deadline Expired')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
});

const uniqueEmail = (prefix: string) =>
  `access-siblings-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@documenso.com`;

const accessCodeOptions = (withAccessCode: boolean) =>
  withAccessCode
    ? { authOptions: createDocumentAuthOptions({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] }) }
    : {};

/**
 * A pending document with two recipients: the first has signed, so the
 * completion page is the page they would land on; the second has not, so the
 * document stays pending.
 */
const seedPendingWithSignedRecipient = async (prefix: string, withAccessCode: boolean) => {
  const { user, team } = await seedUser();
  const qrToken = prefixedId('qr');

  const seeded = await seedPendingDocument(user, team.id, [uniqueEmail(`${prefix}-a`), uniqueEmail(`${prefix}-b`)], {
    createDocumentOptions: { qrToken, ...accessCodeOptions(withAccessCode) },
  });

  const recipient = seeded.recipients[0];

  await prisma.recipient.update({ where: { id: recipient.id }, data: { signingStatus: SigningStatus.SIGNED } });

  const documentData = seeded.envelopeItems.map((item) => item.documentData);

  return {
    document: { ...seeded, qrToken },
    recipient,
    documentDataIds: documentData.map((d) => d.id),
    data: documentData[0].data,
  };
};

const seedCompletedWithQr = async (prefix: string, withAccessCode: boolean) => {
  const { user, team } = await seedUser();
  const qrToken = prefixedId('qr');

  const document = await seedCompletedDocument(user, team.id, [uniqueEmail(prefix)], {
    createDocumentOptions: { qrToken, ...accessCodeOptions(withAccessCode) },
  });

  return { document, item: document.envelopeItems[0], qrToken };
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

const qrFileUrls = (qrToken: string, envelopeId: string, item: { id: string; documentDataId: string }) => {
  const base = `${WEBAPP_BASE_URL}/api/files/token/${qrToken}`;
  const dataBase = `${base}/envelope/${envelopeId}/envelopeItem/${item.id}/dataId/${item.documentDataId}`;

  return [
    `${base}/envelopeItem/${item.id}`,
    `${base}/envelopeItem/${item.id}/download/original`,
    `${base}/envelopeItem/${item.id}/download/signed`,
    `${dataBase}/current/item.pdf`,
    `${dataBase}/initial/item.pdf`,
  ];
};

const verifyAccessCode = async (
  request: APIRequestContext,
  recipient: { token: string; email: string },
  envelopeId: string,
) => {
  const code = await generateTwoFactorTokenFromEmail({ email: recipient.email, envelopeId });

  const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.verify2FA`, {
    headers: { 'content-type': 'application/json', origin: new URL(WEBAPP_BASE_URL).origin },
    data: JSON.stringify({
      json: { token: recipient.token, authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code } },
    }),
  });

  expect(res.ok()).toBeTruthy();
};

const findAttachments = (request: APIRequestContext, envelopeId: string, token: string) => {
  const input = encodeURIComponent(JSON.stringify({ json: { envelopeId, token } }));

  return request.get(`${WEBAPP_BASE_URL}/api/trpc/envelope.attachment.find?input=${input}`);
};

const attachmentLabels = (body: { result: { data: { json: { data: Array<{ label: string }> } } } }) =>
  body.result.data.json.data.map((a) => a.label);

const pdfMagic = (body: Buffer) => body.subarray(0, 4).toString('latin1');

/**
 * A pending document whose single recipient has either rejected it (the
 * envelope then turns REJECTED) or passed the signing deadline. The recipient
 * has an empty name and a NAME field holding distinctive text, so a leak of
 * the field shows up in the page body.
 */
const seedEndedRecipient = async (prefix: string, withAccessCode: boolean, ending: 'rejected' | 'expired') => {
  const { user, team } = await seedUser();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `Access siblings ${prefix} ${suffix}`;
  const customText = `Typed name ${prefix} ${suffix}`;

  const seeded = await seedPendingDocument(user, team.id, [uniqueEmail(prefix)], {
    createDocumentOptions: { title, ...accessCodeOptions(withAccessCode) },
  });

  const recipient = seeded.recipients[0];

  await prisma.field.updateMany({
    where: { recipientId: recipient.id, type: FieldType.NAME },
    data: { customText },
  });

  if (ending === 'rejected') {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { name: '', signingStatus: SigningStatus.REJECTED, rejectionReason: 'Not for me' },
    });
    await prisma.envelope.update({ where: { id: seeded.id }, data: { status: DocumentStatus.REJECTED } });
  } else {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { name: '', expiresAt: new Date(Date.now() - 60_000) },
    });
  }

  return { document: seeded, recipient, customText };
};

const endedPageUrls = (token: string, ending: 'rejected' | 'expired') => [
  `${WEBAPP_BASE_URL}/sign/${token}/${ending}`,
  `${WEBAPP_BASE_URL}/sign/${token}/${ending}.data`,
];
