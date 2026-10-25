/**
 * #209: the access-2FA cookie must be bound to the signing token it was issued under, so a browser that entered
 * the old mailbox's code is not let through the replacement's new link after an email change rotates the token
 * (#150).
 *
 * | Criterion | Test                                                                                          |
 * | --------- | --------------------------------------------------------------------------------------------- |
 * | C1        | C1 R1/R2, C1 R3, C1 R4, C1 R5, C1 R6, C1 R7 complete, C1 R7 reject                             |
 * | C2        | C2 readers / C2 legacy field sign / C2 reject: the cookie works while the token is unchanged  |
 * | C3        | C3 the cookie value carries no part of the token                                              |
 * | C4        | C4 the reader accepts only the new value format                                               |
 * | C5        | C5 verification races an email change: the new link is never satisfied by the old cookie      |
 *
 * Setup is through real routes: seedEnvelope sends a PENDING envelope with signers A and B through API v2, and the
 * envelope's access auth is then set to TWO_FACTOR_AUTH (email code). The code is generated in-process with
 * generateTwoFactorTokenFromEmail, as the existing access-2FA specs do, and entered through the tRPC route the gate's
 * form calls. The email change is API v1 PATCH of B's recipient, one of the #150 writers.
 *
 * "Refused as with no cookie" compares each reader's answer for the old-token cookie with its answer for a fresh
 * context holding no cookie, through the same new link: the same status and error code, and no change in the
 * database. Assertions print booleans and statuses, never a token or cookie value.
 */
import { generateTwoFactorTokenFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-token-from-email';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { SigningStatus } from '@prisma/client';
import { serializeSigned } from 'hono/utils/cookie';

import {
  complete,
  expectOk,
  keepRecord,
  type Outcome,
  type Reply,
  rateLimited,
  reject,
  runIterations,
  type Seeded,
  type Signer,
  seedEnvelope,
  send,
  signV2,
  trpcRaw,
  WEBAPP_BASE_URL,
} from '../fixtures/reject-seal';
import { addressFor, jsonHeaders, uniqueLocalPart, V1_URL } from '../fixtures/send-path';

test.describe.configure({ mode: 'default' });

const COOKIE_PREFIX = 'recipientAccess2FA-';
const ORIGIN = new URL(WEBAPP_BASE_URL).origin;

type Playwright = Parameters<Parameters<typeof test>[2]>[0]['playwright'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A sent envelope whose recipients need the emailed access code. */
const seedWithAccessCode = async (request: APIRequestContext, options: { v1?: boolean } = {}) => {
  const seeded = await seedEnvelope(request, { emails: { b: addressFor(uniqueLocalPart('a2fa-old')) } });

  await prisma.envelope.update({
    where: { id: seeded.envelopeId },
    data: {
      authOptions: createDocumentAuthOptions({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] }),
      ...(options.v1 ? { internalVersion: 1 } : {}),
    },
  });

  return seeded;
};

/** Enters `signer`'s emailed code through the gate's tRPC route on `request`, whose jar then holds the cookie. */
const verifyRaw = async (request: APIRequestContext, seeded: Seeded, signer: Signer, retry = true) => {
  const code = await generateTwoFactorTokenFromEmail({ email: signer.email, envelopeId: seeded.envelopeId });

  return await send(
    async () =>
      await request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.verify2FA`, {
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        data: JSON.stringify({
          json: { token: signer.token, authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code } },
        }),
      }),
    'verify2FA',
    retry,
  );
};

const verify = async (request: APIRequestContext, seeded: Seeded, signer: Signer) => {
  expectOk(await verifyRaw(request, seeded, signer), 'premise: the access code verifies');
};

/** API v1 PATCH of the recipient's email (#150 W2), which rotates the token. */
const changeEmailRaw = async (request: APIRequestContext, seeded: Seeded, recipientId: number, retry = true) =>
  await send(
    async () =>
      await request.patch(`${V1_URL}/documents/${seeded.documentId}/recipients/${recipientId}`, {
        headers: jsonHeaders(seeded.apiToken),
        data: { email: addressFor(uniqueLocalPart('a2fa-new')) },
      }),
    'API v1 PATCH recipient',
    retry,
  );

/** Changes B's email and returns B with the rotated token. */
const rotate = async (request: APIRequestContext, seeded: Seeded): Promise<Signer> => {
  expectOk(await changeEmailRaw(request, seeded, seeded.b.id), 'premise: the email change applies');

  const row = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.b.id } });

  expect(row.token !== seeded.b.token, 'premise: the email change rotated the token').toBe(true);

  return { ...seeded.b, email: row.email, token: row.token };
};

const fileUrls = (seeded: Seeded, token: string) => {
  const base = `${WEBAPP_BASE_URL}/api/files/token/${token}`;
  const itemId = seeded.itemIds[0];

  return { view: `${base}/envelopeItem/${itemId}`, download: `${base}/envelopeItem/${itemId}/download/original` };
};

const itemPdfUrl = async (seeded: Seeded, token: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: seeded.itemIds[0] } });

  return `${WEBAPP_BASE_URL}/api/files/token/${token}/envelope/${seeded.envelopeId}/envelopeItem/${item.id}/dataId/${item.documentDataId}/initial/item.pdf`;
};

const embedUrl = (token: string) => `${WEBAPP_BASE_URL}/embed/sign/${token}`;

const isPdf = (body: Buffer) => body.subarray(0, 4).toString('latin1') === '%PDF';

const trpcQuery = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  const res = await request.get(`${WEBAPP_BASE_URL}/api/trpc/${procedure}?input=${encoded}`);

  return { status: res.status(), body: await res.text(), retryAfterMs: null } satisfies Reply;
};

const findAttachments = async (request: APIRequestContext, seeded: Seeded, token: string) =>
  await trpcQuery(request, 'envelope.attachment.find', { envelopeId: seeded.envelopeId, token });

const findItems = async (request: APIRequestContext, seeded: Seeded, token: string) =>
  await trpcQuery(request, 'envelope.item.getManyByToken', {
    envelopeId: seeded.envelopeId,
    access: { type: 'recipient', token },
  });

const legacySign = async (request: APIRequestContext, signer: Signer) =>
  await trpcRaw(request, 'field.signFieldWithToken', {
    token: signer.token,
    fieldId: signer.fieldId,
    value: signer.name,
    isBase64: false,
  });

/** The error code in a tRPC error reply (the AppError code, else the tRPC code), or '' when there is none. */
const codeOf = (reply: Reply) => {
  try {
    const data = (JSON.parse(reply.body) as { error?: { json?: { data?: Record<string, unknown> } } }).error?.json
      ?.data;
    const appError = data?.appError as { code?: unknown } | undefined;
    const code = appError?.code ?? data?.code;

    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
};

const isRefused = (reply: Reply) => reply.status >= 400 && reply.status < 500 && reply.status !== 429;

/** The cookie answer equals the no-cookie answer: a refusal with the same status and error code. */
const expectRefusedAsWithoutCookie = (withCookie: Reply, withoutCookie: Reply, what: string) => {
  expect(isRefused(withoutCookie), `premise: ${what} with no cookie is refused (got ${withoutCookie.status})`).toBe(
    true,
  );
  expect.soft(withCookie.status, `${what}: the old-token cookie gets the no-cookie status`).toBe(withoutCookie.status);
  expect
    .soft(codeOf(withCookie), `${what}: the old-token cookie gets the no-cookie error code`)
    .toBe(codeOf(withoutCookie));
};

const fieldInserted = async (fieldId: number) =>
  (await prisma.field.findUniqueOrThrow({ where: { id: fieldId } })).inserted;

const signingStatus = async (recipientId: number) =>
  (await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } })).signingStatus;

/** The access-2FA cookie the jar of `request` holds for `recipientId`, as name and decoded inner value. */
const jarCookie = async (request: APIRequestContext, recipientId: number) => {
  const cookies = (await request.storageState()).cookies.filter((cookie) =>
    cookie.name.endsWith(`${COOKIE_PREFIX}${recipientId}`),
  );

  expect(cookies.length, `premise: one access-2FA cookie for recipient ${recipientId}`).toBe(1);

  const [cookie] = cookies;
  const decoded = decodeURIComponent(cookie.value);
  const dot = decoded.lastIndexOf('.');

  expect(dot > 0, 'premise: the cookie is a signed value <inner>.<signature>').toBe(true);

  return { name: cookie.name, inner: decoded.slice(0, dot), decoded, expires: cookie.expires };
};

/** A cookie header value signed with the app's secret, as hono's setSignedCookie writes it. */
const signedCookieHeader = async (name: string, inner: string) => {
  const secret = process.env.NEXTAUTH_SECRET;

  expect(Boolean(secret), 'NEXTAUTH_SECRET must be set (source the worktree .env)').toBe(true);

  const serialized = await serializeSigned(name, inner, secret ?? '');

  return serialized.split(';')[0];
};

const contextWithCookie = async (playwright: Playwright, cookieHeader: string) =>
  await playwright.request.newContext({ extraHTTPHeaders: { cookie: cookieHeader } });

/** Whether a reader lets `request` through `token`: the file view route and the embed page. */
const oracle = async (request: APIRequestContext, seeded: Seeded, token: string) => {
  const file = await request.get(fileUrls(seeded, token).view);
  const embed = await request.get(embedUrl(token), { maxRedirects: 0 });

  return {
    file: file.status(),
    embed: embed.status(),
    embedShowsDocument: (await embed.text()).includes(seeded.title),
  };
};

/** The embed page opened the document: a 200 whose page carries the envelope's title. */
const expectEmbedOpens = (answer: { embed: number; embedShowsDocument: boolean }, what: string) => {
  expect.soft(answer.embed, `${what}: the embed page answers 200`).toBe(200);
  expect.soft(answer.embedShowsDocument, `${what}: the embed page shows the document title`).toBe(true);
};

/** A never-issued token, for the answer verification gives a token it does not know. */
const unknownToken = () => `unknown${Math.random().toString(36).slice(2, 12)}${Date.now()}`;

// ---------------------------------------------------------------------------
// C1: a cookie issued under the old token satisfies no reader through the new link
// ---------------------------------------------------------------------------

test('C1 R1/R2: the signing page and the embed page through the new link ask for the code again', async ({
  page,
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = page.context().request;

  await verify(jar, seeded, seeded.b);

  await page.goto(`/sign/${seeded.b.token}`);
  await expect(
    page.getByRole('heading', { name: 'Sign Document' }),
    'premise: the cookie opened the old link',
  ).toBeVisible();

  const b = await rotate(request, seeded);
  const bare = await playwright.request.newContext();

  const bareEmbed = await bare.get(embedUrl(b.token), { maxRedirects: 0 });

  expect(bareEmbed.status(), 'premise: the embed page with no cookie answers 401').toBe(401);

  const embed = await jar.get(embedUrl(b.token), { maxRedirects: 0 });

  expect.soft(embed.status(), 'R2 embed through the new link with the old-token cookie answers as with none').toBe(401);

  await page.goto(`/sign/${b.token}`);

  await expect(
    page.getByRole('heading', { name: 'Verification required' }),
    'R1 the new link asks for the code',
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign Document' })).not.toBeVisible();

  await bare.dispose();
});

test('C1 R3: the file routes through the new link refuse the old-token cookie as they refuse no cookie', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  expect(
    (await jar.get(fileUrls(seeded, seeded.b.token).view)).status(),
    'premise: the cookie opens the old link',
  ).toBe(200);

  const b = await rotate(request, seeded);
  const bare = await playwright.request.newContext();
  const urls = { ...fileUrls(seeded, b.token), itemPdf: await itemPdfUrl(seeded, b.token) };

  for (const [label, url] of Object.entries(urls)) {
    const without = await bare.get(url);

    expect(without.status(), `premise: ${label} with no cookie answers 401`).toBe(401);

    const withCookie = await jar.get(url);

    expect
      .soft(withCookie.status(), `R3 ${label}: the old-token cookie gets the no-cookie status`)
      .toBe(without.status());
    expect.soft(isPdf(await withCookie.body()), `R3 ${label}: no PDF bytes for the old-token cookie`).toBe(false);
  }

  await jar.dispose();
  await bare.dispose();
});

test('C1 R4: the attachment and item lookups through the new link refuse the old-token cookie', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await prisma.envelopeAttachment.create({
    data: { envelopeId: seeded.envelopeId, type: 'link', label: `A2FA ${Date.now()}`, data: 'https://example.com/a' },
  });

  await verify(jar, seeded, seeded.b);

  expectOk(await findAttachments(jar, seeded, seeded.b.token), 'premise: the cookie opens the old attachment list');

  const b = await rotate(request, seeded);
  const bare = await playwright.request.newContext();

  expectRefusedAsWithoutCookie(
    await findAttachments(jar, seeded, b.token),
    await findAttachments(bare, seeded, b.token),
    'R4 envelope.attachment.find',
  );
  expectRefusedAsWithoutCookie(
    await findItems(jar, seeded, b.token),
    await findItems(bare, seeded, b.token),
    'R4 envelope.item.getManyByToken',
  );

  await jar.dispose();
  await bare.dispose();
});

test('C1 R5: the legacy field route through the new link refuses the old-token cookie as unverified', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request, { v1: true });
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  const b = await rotate(request, seeded);
  const bare = await playwright.request.newContext();

  const without = await legacySign(bare, b);
  const withCookie = await legacySign(jar, b);

  expectRefusedAsWithoutCookie(withCookie, without, 'R5 field.signFieldWithToken');
  expect(await fieldInserted(b.fieldId), 'R5 the field stays empty').toBe(false);

  await jar.dispose();
  await bare.dispose();
});

test('C1 R6: envelope.field.sign through the new link refuses the old-token cookie as unverified', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  const b = await rotate(request, seeded);
  const bare = await playwright.request.newContext();

  const without = await signV2(bare, b);
  const withCookie = await signV2(jar, b);

  expectRefusedAsWithoutCookie(withCookie, without, 'R6 envelope.field.sign');
  expect(await fieldInserted(b.fieldId), 'R6 the field stays empty').toBe(false);

  await jar.dispose();
  await bare.dispose();
});

test('C1 R7 complete: completing through the new link refuses the old-token cookie as unverified', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  const b = await rotate(request, seeded);

  // Inserted after the change, which #150 refuses for a recipient with an inserted field, so only the
  // access check stands in the way of completion.
  await prisma.field.update({ where: { id: b.fieldId }, data: { inserted: true, customText: '' } });
  await prisma.signature.create({ data: { fieldId: b.fieldId, recipientId: b.id, typedSignature: b.name } });

  const bare = await playwright.request.newContext();

  const without = await complete(bare, seeded, b);
  const withCookie = await complete(jar, seeded, b);

  expectRefusedAsWithoutCookie(withCookie, without, 'R7 recipient.completeDocumentWithToken');
  expect(await signingStatus(b.id), 'R7 the recipient is not recorded as signed').toBe(SigningStatus.NOT_SIGNED);

  await jar.dispose();
  await bare.dispose();
});

test('C1 R7 reject: rejecting through the new link refuses the old-token cookie as unverified', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  const b = await rotate(request, seeded);
  const bare = await playwright.request.newContext();

  const without = await reject(bare, seeded, b, 'no cookie');
  const withCookie = await reject(jar, seeded, b, 'old-token cookie');

  expectRefusedAsWithoutCookie(withCookie, without, 'R7 recipient.rejectDocumentWithToken');
  expect(await signingStatus(b.id), 'R7 the recipient is not recorded as rejected').toBe(SigningStatus.NOT_SIGNED);

  await jar.dispose();
  await bare.dispose();
});

// ---------------------------------------------------------------------------
// C2: without rotation the cookie satisfies every reader as before
// ---------------------------------------------------------------------------

test('C2 readers: with the token unchanged the cookie opens the page, files, lookups, field sign and complete', async ({
  page,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = page.context().request;

  await prisma.envelopeAttachment.create({
    data: { envelopeId: seeded.envelopeId, type: 'link', label: `A2FA ${Date.now()}`, data: 'https://example.com/a' },
  });

  await verify(jar, seeded, seeded.b);

  await page.goto(`/sign/${seeded.b.token}`);
  await expect(
    page.getByRole('heading', { name: 'Sign Document' }),
    'R1 the signing page shows the document',
  ).toBeVisible();

  expectEmbedOpens(await oracle(jar, seeded, seeded.b.token), 'R2 embed');

  const urls = { ...fileUrls(seeded, seeded.b.token), itemPdf: await itemPdfUrl(seeded, seeded.b.token) };

  for (const [label, url] of Object.entries(urls)) {
    const res = await jar.get(url);

    expect.soft(res.status(), `R3 ${label}`).toBe(200);
    expect.soft(isPdf(await res.body()), `R3 ${label} serves the PDF`).toBe(true);
  }

  expectOk(await findAttachments(jar, seeded, seeded.b.token), 'R4 envelope.attachment.find');
  expectOk(await findItems(jar, seeded, seeded.b.token), 'R4 envelope.item.getManyByToken');

  expectOk(await signV2(jar, seeded.b), 'R6 envelope.field.sign');
  expect(await fieldInserted(seeded.b.fieldId), 'R6 the field is signed').toBe(true);

  expectOk(await complete(jar, seeded, seeded.b), 'R7 recipient.completeDocumentWithToken');
  expect(await signingStatus(seeded.b.id), 'R7 the recipient is signed').toBe(SigningStatus.SIGNED);
});

test('C2 legacy field sign: with the token unchanged the cookie lets the legacy field route sign', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request, { v1: true });
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  expectOk(await legacySign(jar, seeded.b), 'R5 field.signFieldWithToken');
  expect(await fieldInserted(seeded.b.fieldId), 'R5 the field is signed').toBe(true);

  await jar.dispose();
});

test('C2 reject: with the token unchanged the cookie lets the recipient reject', async ({ playwright, request }) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  expectOk(await reject(jar, seeded, seeded.b, 'verified rejection'), 'R7 recipient.rejectDocumentWithToken');
  expect(await signingStatus(seeded.b.id), 'R7 the recipient is rejected').toBe(SigningStatus.REJECTED);

  await jar.dispose();
});

// ---------------------------------------------------------------------------
// C3: no token in the cookie
// ---------------------------------------------------------------------------

test('C3 the cookie value carries no part of the token and is not the bare <id>:<exp> value', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  const { name, inner, decoded } = await jarCookie(jar, seeded.b.id);
  const token = seeded.b.token;
  const windows = Array.from({ length: Math.max(token.length - 7, 0) }, (_, i) => token.slice(i, i + 8));

  expect(name.endsWith(`${COOKIE_PREFIX}${seeded.b.id}`), 'the cookie is named for the recipient').toBe(true);
  expect(
    windows.some((window) => decoded.includes(window)),
    'the cookie value holds an 8-character piece of the token',
  ).toBe(false);
  expect(/^\d+:\d+$/.test(inner), 'the cookie is the bare <recipientId>:<expiresAt> value, with no digest').toBe(false);

  await jar.dispose();
});

// ---------------------------------------------------------------------------
// C4: the reader accepts only the new value format
// ---------------------------------------------------------------------------

test('C4 the reader refuses validly signed old-format, other-token, extra-part and missing-part values', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jarA = await playwright.request.newContext();
  const jarB = await playwright.request.newContext();

  await verify(jarA, seeded, seeded.a);
  await verify(jarB, seeded, seeded.b);

  const a = await jarCookie(jarA, seeded.a.id);
  const b = await jarCookie(jarB, seeded.b.id);

  const tryValue = async (inner: string) => {
    const context = await contextWithCookie(playwright, await signedCookieHeader(b.name, inner));
    const answer = await oracle(context, seeded, seeded.b.token);

    await context.dispose();

    return answer;
  };

  // Control: the real value, re-signed here, is accepted, so the forging matches the app's signing and every
  // refusal below comes from the value rather than the signature.
  const control = await tryValue(b.inner);

  expect(control.file, 'premise: the re-signed real value opens the file route').toBe(200);
  expect(control.embed, 'premise: the re-signed real value opens the embed page').toBe(200);
  expect(control.embedShowsDocument, 'premise: the re-signed real value shows the document in the embed page').toBe(
    true,
  );

  const expiresMs = Math.round(b.expires * 1000);
  const parts = b.inner.split(':');
  const aId = String(seeded.a.id);

  const forged: Record<string, string> = {
    'old format <id>:<exp ms>': `${seeded.b.id}:${expiresMs}`,
    'old format <id>:<exp s>': `${seeded.b.id}:${Math.round(b.expires)}`,
    "A's value with B's id (digest for another token)": a.inner
      .split(':')
      .map((part) => (part === aId ? String(seeded.b.id) : part))
      .join(':'),
    'extra part': `${b.inner}:extra`,
    'missing part': parts.slice(0, -1).join(':'),
  };

  for (const [label, inner] of Object.entries(forged)) {
    const answer = await tryValue(inner);

    expect.soft(answer.file, `C4 ${label}: the file route refuses`).toBe(401);
    expect.soft(answer.embed, `C4 ${label}: the embed page refuses`).toBe(401);
  }

  await jarA.dispose();
  await jarB.dispose();
});

// ---------------------------------------------------------------------------
// C5: verification and an email change at once
// ---------------------------------------------------------------------------

test('C5 verification races an email change: the new link is never satisfied by the old-token cookie', async ({
  playwright,
  request,
}) => {
  test.setTimeout(600_000);

  const orderings = { verifiedFirst: 0, changedFirst: 0 };

  await runIterations(
    'C5',
    async (): Promise<Outcome> => {
      const seeded = await seedWithAccessCode(request);
      const jar = await playwright.request.newContext();

      // Control: what verification answers for a token it does not know, through the same envelope and email.
      const stranger = await playwright.request.newContext();
      const unknown = await verifyRaw(stranger, seeded, { ...seeded.b, token: unknownToken() });

      await stranger.dispose();

      const [verified, changed] = await Promise.all([
        verifyRaw(jar, seeded, seeded.b, false),
        changeEmailRaw(request, seeded, seeded.b.id, false),
      ]);

      const limited = rateLimited(seeded, { verified, changed, unknown });

      if (limited) {
        await jar.dispose();

        return limited;
      }

      const row = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.b.id } });
      const rotated = row.token !== seeded.b.token;
      const answer = await oracle(jar, seeded, row.token);
      const hasCookie = (await jar.storageState()).cookies.some((cookie) =>
        cookie.name.endsWith(`${COOKIE_PREFIX}${seeded.b.id}`),
      );

      await jar.dispose();

      // The permitted verification outcomes: it ran first, succeeded and issued the cookie; or the change ran first
      // and verification answered as for an unknown token. Anything else (a 5xx, a 2xx without a cookie, another
      // refusal) fails the iteration.
      const isVerifiedFirst = verified.status >= 200 && verified.status < 300 && hasCookie;
      const isChangedFirst =
        isRefused(unknown) && verified.status === unknown.status && codeOf(verified) === codeOf(unknown) && !hasCookie;

      if (isVerifiedFirst) {
        orderings.verifiedFirst++;
      }

      if (isChangedFirst) {
        orderings.changedFirst++;
      }

      const problems = [
        !isVerifiedFirst && !isChangedFirst
          ? `verification answered ${verified.status} (${codeOf(verified) || 'no code'}), cookie issued ${hasCookie}; ` +
            `neither a success with a cookie nor the unknown-token answer ${unknown.status} (${codeOf(unknown) || 'no code'})`
          : null,
        !rotated || changed.status >= 300 ? `the email change did not land (${changed.status})` : null,
        answer.file !== 401 ? `the new link's file route answered ${answer.file} to the old-token cookie` : null,
        answer.embed !== 401 ? `the new link's embed page answered ${answer.embed} to the old-token cookie` : null,
      ].filter((problem): problem is string => problem !== null);

      return {
        verdict: problems.length > 0 ? problems.join('; ') : null,
        record: {
          envelopeId: seeded.envelopeId,
          ordering: isVerifiedFirst ? 'verified-first' : isChangedFirst ? 'changed-first' : 'neither',
          verifyStatus: verified.status,
          verifyCode: codeOf(verified),
          unknownTokenStatus: unknown.status,
          unknownTokenCode: codeOf(unknown),
          cookieIssued: hasCookie,
          changeStatus: changed.status,
          rotated,
          newLinkFile: answer.file,
          newLinkEmbed: answer.embed,
        },
      };
    },
    6,
  );

  await keepRecord('C5-orderings.json', orderings);
  console.log(`C5 orderings: verified first ${orderings.verifiedFirst}, changed first ${orderings.changedFirst}`);
});

const holdsCookie = async (request: APIRequestContext, recipientId: number) =>
  (await request.storageState()).cookies.some((cookie) => cookie.name.endsWith(`${COOKIE_PREFIX}${recipientId}`));

test('C5 verify then change: a cookie issued before the change is refused through the new link', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const jar = await playwright.request.newContext();

  await verify(jar, seeded, seeded.b);

  expect(await holdsCookie(jar, seeded.b.id), 'premise: the verification issued the cookie').toBe(true);

  const b = await rotate(request, seeded);
  const answer = await oracle(jar, seeded, b.token);

  expect.soft(answer.file, "the new link's file route refuses the old-token cookie").toBe(401);
  expect.soft(answer.embed, "the new link's embed page refuses the old-token cookie").toBe(401);

  await jar.dispose();
});

test('C5 change then verify: verification through the old token is refused as an unknown token', async ({
  playwright,
  request,
}) => {
  const seeded = await seedWithAccessCode(request);
  const oldSigner = { ...seeded.b };

  const stranger = await playwright.request.newContext();
  const unknown = await verifyRaw(stranger, seeded, { ...oldSigner, token: unknownToken() });

  await stranger.dispose();

  expect(isRefused(unknown), `premise: a never-issued token is refused (got ${unknown.status})`).toBe(true);

  const b = await rotate(request, seeded);
  const jar = await playwright.request.newContext();

  // The old token with a valid code for the old address.
  const verified = await verifyRaw(jar, seeded, oldSigner);

  expect(verified.status, 'the old token is refused with the status of a never-issued token').toBe(unknown.status);
  expect(codeOf(verified), 'the old token is refused with the error code of a never-issued token').toBe(
    codeOf(unknown),
  );
  expect(await holdsCookie(jar, seeded.b.id), 'no access-2FA cookie is issued').toBe(false);

  const answer = await oracle(jar, seeded, b.token);

  expect.soft(answer.file, "the new link's file route refuses this context").toBe(401);
  expect.soft(answer.embed, "the new link's embed page refuses this context").toBe(401);

  await jar.dispose();
});
