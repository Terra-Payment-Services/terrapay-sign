import { randomInt } from 'node:crypto';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { generateTwoFactorCredentialsFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-credentials-from-email';
import { enableTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/enable-2fa';
import { setupTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/setup-2fa';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument, seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, type User } from '@prisma/client';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

import { apiSignin } from '../fixtures/authentication';
import { signSignaturePad } from '../fixtures/signature';

/**
 * Issue #214: before the emailed access code is entered, the signing page and
 * the embed signing page must give the gate only the recipient's token and
 * email. The recipient's id, name, role and auth options, and the envelope's
 * auth options, stay on the server.
 *
 * Written from the specification (F214/spec.md, C1 to C5 and Amendment 1).
 *
 * The loader data travels in React Router's turbo-stream encoding: one flat
 * JSON array in which an object is `{"_<keyIndex>": <valueIndex>}` and equal
 * values share an index. A recipient id such as 1 can therefore be the same
 * array slot as an unrelated `version: 1`, so the id is checked by decoding the
 * objects that carry the recipient's token or email and looking for an `id`
 * key among them, never by searching the text for the number.
 */

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const PERIOD_MS = 30_000;

const PDF_PAGE_SELECTOR = 'img[data-page-number]';

const FORBIDDEN_RECIPIENT_KEYS = ['id', 'name', 'role', 'authOptions'];

const FORBIDDEN_AUTH_KEYS = ['documentAuthOptions', 'globalAccessAuth', 'globalActionAuth', 'accessAuth', 'actionAuth'];

type TGatedRecipient = { id: number; token: string; email: string; name: string };

test.describe('C1 and C2: the gated payload carries only the token and email', () => {
  for (const internalVersion of [1, 2] as const) {
    test(`C1: /sign/<token> .data and HTML withhold the recipient's id, name, role and auth options (V${internalVersion})`, async ({
      playwright,
    }) => {
      const { recipient } = await seedGatedRecipient(internalVersion);

      const request = await playwright.request.newContext();

      await expectGatedPayload(request, `${WEBAPP_BASE_URL}/sign/${recipient.token}`, recipient);

      await request.dispose();
    });

    test(`C2: /embed/sign/<token> .data and HTML withhold the recipient's id, name, role and auth options (V${internalVersion})`, async ({
      playwright,
    }) => {
      const { recipient } = await seedGatedRecipient(internalVersion);

      const request = await playwright.request.newContext();

      await expectGatedPayload(request, `${WEBAPP_BASE_URL}/embed/sign/${recipient.token}`, recipient);

      await request.dispose();
    });
  }
});

for (const surface of ['sign', 'embed'] as const) {
  for (const internalVersion of [1, 2] as const) {
    for (const signedIn of [false, true]) {
      const who = signedIn ? 'signed in as the recipient' : 'anonymous';

      test(`C3: the ${surface} gate opens the document once the emailed code is entered (V${internalVersion}, ${who})`, async ({
        page,
      }) => {
        await useOwnAddress(page);

        let recipientUser: User | undefined;

        if (signedIn) {
          recipientUser = (await seedUser()).user;

          await apiSignin({ page, email: recipientUser.email });
        }

        const { document, recipient } = await seedGatedRecipient(internalVersion, recipientUser);

        await page.goto(signPath(surface, recipient.token));

        await enterEmailedCode(page, recipient, document.id);

        await expectDocumentOpen(page, internalVersion);
      });
    }
  }
}

test('C4: a signed-in recipient with two-factor authentication is offered the authenticator app on the gate', async ({
  page,
}) => {
  const { user: recipientUser } = await seedUser();

  await apiSignin({ page, email: recipientUser.email });

  await enableAuthenticator(recipientUser);

  const { recipient } = await seedGatedRecipient(1, recipientUser);

  await page.goto(`/sign/${recipient.token}`);

  await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Email verification/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Authenticator app/ })).toBeVisible();
});

for (const surface of ['sign', 'embed'] as const) {
  test(`C4: a signed-in recipient opens the ${surface} gate with their own authenticator code`, async ({ page }) => {
    const { user: recipientUser } = await seedUser();

    await apiSignin({ page, email: recipientUser.email });

    const authenticator = await enableAuthenticator(recipientUser);

    const { recipient } = await seedGatedRecipient(1, recipientUser);

    await page.goto(signPath(surface, recipient.token));

    await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
    await expect(page.locator(PDF_PAGE_SELECTOR)).toHaveCount(0);

    await page.getByRole('button', { name: /Authenticator app/ }).click();

    await page.getByRole('textbox', { name: '2FA code' }).fill(await nextAuthenticatorCode(authenticator));
    await page.getByRole('button', { name: 'Verify & Complete' }).click();

    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
  });
}

/**
 * Completion asks for the code again when the access cookie has gone while the
 * recipient was signing. The form it shows must still offer the authenticator
 * to a signed-in recipient whose account has it.
 */
test('C4: the completion dialog offers the authenticator app when completion asks for the code again', async ({
  page,
}) => {
  const { user, team } = await seedUser();
  const { user: recipientUser } = await seedUser();

  await apiSignin({ page, email: recipientUser.email });

  await enableAuthenticator(recipientUser);

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [recipientUser],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: {
      authOptions: createDocumentAuthOptions({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] }),
    },
  });

  const [recipient] = recipients;

  await verifyEmailedCode(page.context().request, recipient, document.id);

  await page.goto(`/sign/${recipient.token}`);

  await expect(page.getByRole('heading', { name: 'Sign Document' })).toBeVisible({ timeout: 30_000 });

  await signSignaturePad(page);

  for (const field of recipient.fields) {
    await page.locator(`#field-${field.id}`).getByRole('button').click();
    await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
  }

  const accessCookies = (await page.context().cookies()).filter((cookie) =>
    cookie.name.endsWith(`recipientAccess2FA-${recipient.id}`),
  );

  expect(accessCookies.length, 'premise: the access cookie is set').toBeGreaterThan(0);

  await page.context().clearCookies({ name: new RegExp(`recipientAccess2FA-${recipient.id}$`) });

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();

  await expect(page.getByRole('button', { name: /Email verification/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Authenticator app/ })).toBeVisible();
});

for (const internalVersion of [1, 2] as const) {
  test(`C5: with the access cookie the /sign and embed loaders return the recipient's full data (V${internalVersion})`, async ({
    playwright,
  }) => {
    const { document, recipient } = await seedGatedRecipient(internalVersion);
    const fields = await prisma.field.findMany({ where: { recipientId: recipient.id } });

    expect(fields.length, 'premise: the recipient has fields').toBeGreaterThan(0);

    const request = await playwright.request.newContext();

    await verifyEmailedCode(request, recipient, document.id);

    for (const url of [
      `${WEBAPP_BASE_URL}/sign/${recipient.token}.data`,
      `${WEBAPP_BASE_URL}/embed/sign/${recipient.token}.data`,
    ]) {
      const res = await request.get(url);
      const body = await res.text();

      expect(res.status(), url).toBe(200);
      expect(body, url).not.toContain('isAccess2FARequired');
      expect(body, url).not.toContain('embed-access-code-required');

      const objects = decodeObjects(parseFlat(firstLine(body)));

      const recipientObject = objects.find((object) => object.token === recipient.token && 'id' in object);

      expect(recipientObject, `${url}: recipient object`).toBeDefined();
      expect(recipientObject?.id, `${url}: recipient id`).toBe(recipient.id);
      expect(recipientObject?.name, `${url}: recipient name`).toBe(recipient.name);
      expect(recipientObject?.role, `${url}: recipient role`).toBe(recipient.role);

      const fieldObjects = objects.filter(
        (object) => fields.some((field) => field.id === object.id) && object.recipientId === recipient.id,
      );

      expect(fieldObjects.length, `${url}: document fields`).toBeGreaterThan(0);
      expect(fieldObjects[0].type, `${url}: field type`).toBe(fields.find((f) => f.id === fieldObjects[0].id)?.type);
    }

    await request.dispose();
  });
}

/**
 * The signing view has replaced the gate. The seeded V2 envelope has no V2 page
 * data, so its viewer shows a rendering error in place of the pages; for V2 the
 * signing sidebar and its Complete button are the evidence instead.
 */
const expectDocumentOpen = async (page: Page, internalVersion: 1 | 2) => {
  if (internalVersion === 1) {
    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(page.getByRole('heading', { name: /^Sign Document/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Complete' })).toBeVisible();
  }

  await expect(page.getByRole('heading', { name: 'Verification required' })).not.toBeVisible();
};

const signPath = (surface: 'sign' | 'embed', token: string) =>
  surface === 'sign' ? `/sign/${token}` : `/embed/sign/${token}`;

/**
 * Each browser test that asks for an emailed code sends its own client address,
 * so the email rate limit counts it apart from the others.
 */
const useOwnAddress = async (page: Page) => {
  const ip = `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;

  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip });
};

/**
 * An authenticator code from a step later than the one used to enable 2FA,
 * since an account code may be accepted only once.
 */
const nextAuthenticatorCode = async ({ secret, usedCounter }: { secret: string; usedCounter: number }) => {
  let counter = Math.floor(Date.now() / PERIOD_MS);
  let remaining = PERIOD_MS - (Date.now() % PERIOD_MS);

  while (counter <= usedCounter || remaining < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 250));

    counter = Math.floor(Date.now() / PERIOD_MS);
    remaining = PERIOD_MS - (Date.now() % PERIOD_MS);
  }

  return await generateHOTP(base32.decode(secret), counter);
};

/**
 * A pending envelope whose single recipient needs the emailed access code. The
 * recipient's name is a random marker so that its absence can be asserted on
 * the raw text of every response.
 */
const seedGatedRecipient = async (internalVersion: 1 | 2, recipientUser?: User) => {
  const { user, team } = await seedUser();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const document = await seedPendingDocument(user, team.id, [recipientUser ?? `gate-payload-${suffix}@documenso.com`], {
    internalVersion,
    createDocumentOptions: {
      authOptions: createDocumentAuthOptions({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] }),
    },
  });

  const seeded = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  const recipient = await prisma.recipient.update({
    where: { id: seeded.id },
    data: { name: `Gatemarker${suffix.replace(/[^a-z0-9]/gi, '')}` },
  });

  return { document, recipient: recipient satisfies TGatedRecipient };
};

/**
 * The emailed code for the current 30 second step, computed as the server does.
 * Near the end of a step, wait for the next one so the code cannot expire in
 * flight. Each recipient has its code verified at most once.
 */
const currentEmailCode = async (email: string, envelopeId: string) => {
  const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);

  if (remaining < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 250));
  }

  const { secret } = generateTwoFactorCredentialsFromEmail({ email, envelopeId });

  return await generateHOTP(secret, Math.floor(Date.now() / PERIOD_MS));
};

const enterEmailedCode = async (page: Page, recipient: TGatedRecipient, envelopeId: string) => {
  await expect(page.getByRole('heading', { name: 'Verification required' })).toBeVisible();
  await expect(page.getByText(`Enter the code sent to ${recipient.email}`)).toBeVisible();
  await expect(page.locator(PDF_PAGE_SELECTOR)).toHaveCount(0);

  await page.getByRole('button', { name: /Email verification/ }).click();

  const code = await currentEmailCode(recipient.email, envelopeId);

  await page.getByRole('textbox', { name: '2FA code' }).fill(code);
  await page.getByRole('button', { name: 'Verify & Complete' }).click();
};

const verifyEmailedCode = async (request: APIRequestContext, recipient: TGatedRecipient, envelopeId: string) => {
  const code = await currentEmailCode(recipient.email, envelopeId);

  const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/document.accessAuth.verify2FA`, {
    headers: { 'content-type': 'application/json', origin: new URL(WEBAPP_BASE_URL).origin },
    data: JSON.stringify({
      json: { token: recipient.token, authOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: code } },
    }),
  });

  expect(res.ok()).toBeTruthy();
};

/**
 * Turn on authenticator-app 2FA for a user, after they have signed in, so the
 * sign-in itself needs no code.
 */
const enableAuthenticator = async (user: User) => {
  const { secret } = await setupTwoFactorAuthentication({ user });

  const withSecret = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);

  if (remaining < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 250));
  }

  const usedCounter = Math.floor(Date.now() / PERIOD_MS);
  const code = await generateHOTP(base32.decode(secret), usedCounter);

  await enableTwoFactorAuthentication({ user: withSecret, code });

  expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(true);

  return { secret, usedCounter };
};

/**
 * Fetch `<base>.data` and `<base>` without any cookie and check both against C1/C2.
 */
const expectGatedPayload = async (request: APIRequestContext, base: string, recipient: TGatedRecipient) => {
  const dataRes = await request.get(`${base}.data`);
  const dataBody = await dataRes.text();

  const htmlRes = await request.get(base);
  const htmlBody = await htmlRes.text();

  // Premise: both responses are the gate, not the document.
  expect(htmlBody, base).toContain('Verification required');

  const payloads = [
    { label: `${base}.data`, raw: dataBody, flat: parseFlat(firstLine(dataBody)) },
    { label: base, raw: htmlBody, flat: parseFlat(firstLine(streamFromHtml(htmlBody))) },
  ];

  for (const { label, raw, flat } of payloads) {
    const strings = flat.filter((value): value is string => typeof value === 'string');

    // The gate needs these two.
    expect(strings, `${label}: email`).toContain(recipient.email);
    expect(strings, `${label}: token`).toContain(recipient.token);

    // The leak checks are soft so one run reports every field that leaks.
    // The name, by its distinctive marker, anywhere in the response.
    expect.soft(raw, `${label}: name`).not.toContain(recipient.name);

    const objects = decodeObjects(flat);

    const recipientObjects = objects.filter((object) =>
      Object.values(object).some((value) => value === recipient.email || value === recipient.token),
    );

    expect(recipientObjects.length, `${label}: an object carries the token or email`).toBeGreaterThan(0);

    for (const object of recipientObjects) {
      const keys = Object.keys(object);

      for (const key of FORBIDDEN_RECIPIENT_KEYS) {
        expect.soft(keys, `${label}: recipient key ${key}`).not.toContain(key);
      }

      expect.soft(object.id, `${label}: recipient id`).not.toBe(recipient.id);
    }

    const allKeys = new Set(objects.flatMap((object) => Object.keys(object)));

    for (const key of FORBIDDEN_AUTH_KEYS) {
      expect.soft(allKeys.has(key), `${label}: auth key ${key}`).toBe(false);
    }
  }
};

const firstLine = (text: string) => text.split('\n')[0];

const parseFlat = (line: string) => {
  const parsed: unknown = JSON.parse(line);

  if (!Array.isArray(parsed)) {
    throw new Error('Expected a turbo-stream flat array');
  }

  return parsed as unknown[];
};

/**
 * The server-rendered HTML hands the same turbo-stream to the client through
 * `streamController.enqueue("<json string>")` calls; join their arguments.
 */
const streamFromHtml = (html: string) => {
  const chunks = [...html.matchAll(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/g)].map(
    (match) => JSON.parse(match[1]) as string,
  );

  if (chunks.length === 0) {
    throw new Error('No React Router stream found in the HTML');
  }

  return chunks.join('');
};

/**
 * Every object slot in the flat array, with key indices resolved to key names
 * and value indices resolved one level to the primitive they point at.
 */
const decodeObjects = (flat: unknown[]) =>
  flat
    .filter((value): value is Record<string, number> => isEncodedObject(value))
    .map((encoded) =>
      Object.fromEntries(
        Object.entries(encoded).map(([key, valueIndex]) => [
          String(flat[Number(key.slice(1))]),
          valueIndex >= 0 ? flat[valueIndex] : undefined,
        ]),
      ),
    );

const isEncodedObject = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).every(([key, index]) => /^_\d+$/.test(key) && typeof index === 'number');
