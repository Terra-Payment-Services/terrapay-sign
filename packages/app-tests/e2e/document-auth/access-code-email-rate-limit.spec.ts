import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';

import { addressFor, NO_MAIL_WINDOW_MS, readMailbox, uniqueLocalPart, waitForMail } from '../fixtures/send-path';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/** request2FAEmail allows five requests per recipient token in a window. */
const LIMIT = 5;

/**
 * A distinct client address per test. The limiter also counts requests per IP
 * across every token, so tests sharing 127.0.0.1 would exhaust each other.
 */
const uniqueIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Date.now() % 250}`;

const seedGatedRecipient = async (options: { twoFactor: boolean }) => {
  const { user, team } = await seedUser();
  const localPart = uniqueLocalPart('f215');

  const document = await seedPendingDocument(user, team.id, [addressFor(localPart)], {
    createDocumentOptions: {
      authOptions: createDocumentAuthOptions({
        globalAccessAuth: options.twoFactor ? ['TWO_FACTOR_AUTH'] : [],
        globalActionAuth: [],
      }),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  return { localPart, token: recipient.token };
};

const requestCode = async (request: APIRequestContext, ip: string, token: string) => {
  const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.request2FAEmail`, {
    headers: {
      'content-type': 'application/json',
      origin: new URL(WEBAPP_BASE_URL).origin,
      'x-forwarded-for': ip,
    },
    data: JSON.stringify({ json: { token } }),
  });

  const body = JSON.parse(await res.text());

  return {
    status: res.status(),
    retryAfter: res.headers()['retry-after'],
    headerValues: (name: string) =>
      res
        .headersArray()
        .filter((header) => header.name.toLowerCase() === name.toLowerCase())
        .map((header) => header.value),
    errorCode: body?.error?.json?.data?.code as string | undefined,
    expiresAt: body?.result?.data?.json?.expiresAt as string | undefined,
  };
};

test.describe('[DOCUMENT_AUTH]: access code email request limit (#215)', () => {
  test.skip(process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true', 'Rate limits are bypassed');

  test('C1: the request after the limit answers 429 TOO_MANY_REQUESTS with Retry-After and sends no email', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const ip = uniqueIp();
    const { localPart, token } = await seedGatedRecipient({ twoFactor: true });

    for (let i = 0; i < LIMIT; i++) {
      expect((await requestCode(request, ip, token)).status, `request ${i + 1} is under the limit`).toBe(200);
    }

    await waitForMail(request, localPart, LIMIT);

    const limited = await requestCode(request, ip, token);

    expect(limited.status).toBe(429);
    expect(limited.errorCode).toBe('TOO_MANY_REQUESTS');
    expect(limited.retryAfter, 'Retry-After header').toMatch(/^[1-9]\d*$/);

    // Nothing is sent for the limited request: wait out the mail window and recount.
    await new Promise((resolve) => setTimeout(resolve, NO_MAIL_WINDOW_MS));

    expect(await readMailbox(request, localPart)).toHaveLength(LIMIT);
  });

  test('C2: requests under the limit each send one code email and answer 200 with expiresAt', async ({ request }) => {
    test.setTimeout(120_000);

    const ip = uniqueIp();
    const { localPart, token } = await seedGatedRecipient({ twoFactor: true });

    for (let i = 1; i <= LIMIT; i++) {
      const res = await requestCode(request, ip, token);

      expect(res.status, `request ${i}`).toBe(200);
      expect(Number.isNaN(Date.parse(res.expiresAt ?? '')), `request ${i} expiresAt`).toBe(false);

      await waitForMail(request, localPart, i);

      expect(await readMailbox(request, localPart), `emails after request ${i}`).toHaveLength(i);
    }
  });

  test('C3: a token that matches no document answers NOT_FOUND', async ({ request }) => {
    const res = await requestCode(request, uniqueIp(), `no-such-token-${Date.now()}`);

    expect(res.status).toBe(404);
    expect(res.errorCode).toBe('NOT_FOUND');
  });

  test('C3: a recipient without access 2FA answers BAD_REQUEST', async ({ request }) => {
    const { localPart, token } = await seedGatedRecipient({ twoFactor: false });

    const res = await requestCode(request, uniqueIp(), token);

    expect(res.status).toBe(400);
    expect(res.errorCode).toBe('BAD_REQUEST');
    expect(await readMailbox(request, localPart)).toHaveLength(0);
  });

  test('C4: the signing page gate says too many codes were requested, not the unknown-error text', async ({ page }) => {
    test.setTimeout(120_000);

    const { token } = await seedGatedRecipient({ twoFactor: true });

    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': uniqueIp() });
    await page.goto(`/sign/${token}`);

    await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();

    const waitForRequest = async () =>
      await page.waitForResponse((res) => res.url().includes('document.accessAuth.request2FAEmail'));

    // The first request comes from choosing email; the next four from "Resend code".
    let response = waitForRequest();

    await page.getByRole('button', { name: /Email verification/ }).click();

    expect((await response).status()).toBe(200);

    const resend = page.getByRole('button', { name: 'Resend code' });

    for (let i = 2; i <= LIMIT; i++) {
      await expect(resend).toBeEnabled();

      response = waitForRequest();
      await resend.click();

      expect((await response).status(), `request ${i}`).toBe(200);
    }

    await expect(resend).toBeEnabled();
    await resend.click();

    await expect(page.getByText(/too many/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/wait|try again/i).first()).toBeVisible();
    await expect(page.getByText(/unknown error/i)).toHaveCount(0);
  });

  test('C5: the 429 carries exactly one value for each X-RateLimit header', async ({ request }) => {
    test.setTimeout(120_000);

    const ip = uniqueIp();
    const { token } = await seedGatedRecipient({ twoFactor: true });

    for (let i = 0; i < LIMIT; i++) {
      expect((await requestCode(request, ip, token)).status, `request ${i + 1}`).toBe(200);
    }

    const limited = await requestCode(request, ip, token);

    expect(limited.status).toBe(429);
    expect(limited.headerValues('x-ratelimit-limit')).toEqual([String(LIMIT)]);
    expect(limited.headerValues('x-ratelimit-remaining')).toEqual(['0']);

    const reset = limited.headerValues('x-ratelimit-reset');

    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatch(/^\d+$/);
  });

  test('C4b: the gate says too many codes when the first request is the limited one', async ({ page, request }) => {
    test.setTimeout(120_000);

    const ip = uniqueIp();
    const { token } = await seedGatedRecipient({ twoFactor: true });

    for (let i = 0; i < LIMIT; i++) {
      expect((await requestCode(request, ip, token)).status, `request ${i + 1}`).toBe(200);
    }

    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip });
    await page.goto(`/sign/${token}`);

    await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();

    const response = page.waitForResponse((res) => res.url().includes('document.accessAuth.request2FAEmail'));

    await page.getByRole('button', { name: /Email verification/ }).click();

    expect((await response).status()).toBe(429);

    await expect(page.getByText(/too many/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/unknown error/i)).toHaveCount(0);
  });
});
