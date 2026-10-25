import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { getRecipientAccess2FACookieName } from '@documenso/lib/server-only/2fa/email/recipient-access-2fa-cookie';
import { enableTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/enable-2fa';
import { setupTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/setup-2fa';
import type { TDocumentActionAuthTypes } from '@documenso/lib/types/document-auth';
import { createDocumentAuthOptions, createRecipientAuthOptions } from '@documenso/lib/utils/document-auth';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument, seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import type { User } from '@prisma/client';
import { FieldType, SigningStatus } from '@prisma/client';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

import { apiSignin } from '../fixtures/authentication';

/**
 * #240: the authenticator code, passkey or password that satisfies a recipient's
 * access code or action auth must belong to the recipient's own account. Each
 * "other account" test has an "own account" twin on the same route, so a refusal
 * is shown to come from the identity check and not from a broken path.
 *
 * C3 PASSKEY is not covered here: the E2E suite has no way to register a test
 * passkey, so it is left to review.
 */

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const TOTP_PERIOD = 30_000;
const ATTACKER_PASSWORD = 'attacker-own-password-240';

const trpc = async (page: Page, procedure: string, input: Record<string, unknown>, datePaths: string[] = []) => {
  const body: Record<string, unknown> = { json: input };

  if (datePaths.length > 0) {
    body.meta = { values: Object.fromEntries(datePaths.map((key) => [key, ['Date']])) };
  }

  return await page.context().request.post(`${BASE}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json', origin: new URL(BASE).origin },
    data: JSON.stringify(body),
  });
};

const totpFor = async (secret: string) =>
  await generateHOTP(base32.decode(secret), Math.floor(Date.now() / TOTP_PERIOD));

/**
 * Signs the user in, turns on authenticator 2FA and waits for a fresh TOTP step,
 * so the code used by the test is not the one spent on enabling.
 */
const signInWithAuthenticator = async (page: Page, user: User, password = 'password') => {
  await apiSignin({ page, email: user.email, password });

  const { secret } = await setupTwoFactorAuthentication({ user });
  const withSecret = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  await enableTwoFactorAuthentication({ user: withSecret, code: await totpFor(secret) });

  await new Promise((resolve) => setTimeout(resolve, TOTP_PERIOD - (Date.now() % TOTP_PERIOD) + 500));

  return secret;
};

const seedAccess2FADocument = async (recipient: User | string) => {
  const { user: owner, team } = await seedUser();

  const document = await seedPendingDocument(owner, team.id, [recipient], {
    internalVersion: 1,
    createDocumentOptions: {
      authOptions: createDocumentAuthOptions({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] }),
    },
  });

  return await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
};

const verifyAccess2FA = async (page: Page, recipientToken: string, code: string) =>
  await trpc(page, 'document.accessAuth.verify2FA', {
    token: recipientToken,
    authOptions: { type: 'TWO_FACTOR_AUTH', method: 'authenticator', token: code },
  });

const setsAccessCookie = (headers: { name: string; value: string }[], recipientId: number) =>
  headers
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .some((header) => header.value.split('=')[0] === getRecipientAccess2FACookieName(recipientId));

const isSigningPageGated = async (page: Page, recipientToken: string) => {
  const res = await page.context().request.get(`${BASE}/sign/${recipientToken}.data`);

  return (await res.text()).includes('isAccess2FARequired');
};

const seedCompletableAccess2FADocument = async (recipient: User | string) => {
  const { user: owner, team } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [recipient],
    fields: [FieldType.TEXT],
    updateDocumentOptions: {
      authOptions: createDocumentAuthOptions({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] }),
    },
  });

  const [seededRecipient] = recipients;

  // Fill the only field so that nothing but the access code stands in the way.
  await prisma.field.update({
    where: { id: seededRecipient.fields[0].id },
    data: { inserted: true, customText: 'Filled' },
  });

  return {
    recipient: seededRecipient,
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
  };
};

const completeWithAuthenticator = async (page: Page, recipientToken: string, documentId: number, code: string) =>
  await trpc(page, 'recipient.completeDocumentWithToken', {
    token: recipientToken,
    documentId,
    accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'authenticator', token: code },
  });

const seedActionAuthDocument = async (
  recipient: User | string,
  actionAuth: TDocumentActionAuthTypes,
  internalVersion: 1 | 2,
) => {
  const { user: owner, team } = await seedUser();

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [recipient],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: {
      internalVersion,
      authOptions: createDocumentAuthOptions({ globalAccessAuth: [], globalActionAuth: [actionAuth] }),
    },
  });

  const [seededRecipient] = recipients;

  return { recipientToken: seededRecipient.token, fieldId: seededRecipient.fields[0].id };
};

const signField = async (
  page: Page,
  internalVersion: 1 | 2,
  recipientToken: string,
  fieldId: number,
  authOptions: Record<string, unknown>,
) => {
  if (internalVersion === 1) {
    return await trpc(page, 'field.signFieldWithToken', {
      token: recipientToken,
      fieldId,
      value: 'Typed Signature',
      isBase64: false,
      authOptions,
    });
  }

  return await trpc(page, 'envelope.field.sign', {
    token: recipientToken,
    fieldId,
    fieldValue: { type: FieldType.SIGNATURE, value: 'Typed Signature' },
    authOptions,
  });
};

const expectFieldUnsigned = async (fieldId: number) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });

  expect(field.inserted).toBe(false);
  expect(await prisma.signature.findUnique({ where: { fieldId } })).toBeNull();
};

const expectFieldSigned = async (fieldId: number) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });

  expect(field.inserted).toBe(true);
};

test.describe('[RECIPIENT_ACCOUNT_MATCH] C1 access code gate (document.accessAuth.verify2FA)', () => {
  test('C1/C5: another account is refused with its own TOTP when the recipient has no account', async ({ page }) => {
    const recipient = await seedAccess2FADocument(`no-account-${Date.now()}@documenso.com`);
    const { user: attacker } = await seedUser();
    const secret = await signInWithAuthenticator(page, attacker);

    expect(await isSigningPageGated(page, recipient.token)).toBe(true);

    const res = await verifyAccess2FA(page, recipient.token, await totpFor(secret));

    expect(res.ok()).toBe(false);
    expect(await res.text()).toContain('TWO_FACTOR_AUTH_FAILED');
    expect(setsAccessCookie(res.headersArray(), recipient.id)).toBe(false);
    expect(await isSigningPageGated(page, recipient.token)).toBe(true);
  });

  test('C1: another account is refused with its own TOTP when the recipient has an account', async ({ page }) => {
    const { user: recipientUser } = await seedUser();
    const recipient = await seedAccess2FADocument(recipientUser);
    const { user: attacker } = await seedUser();
    const secret = await signInWithAuthenticator(page, attacker);

    const res = await verifyAccess2FA(page, recipient.token, await totpFor(secret));

    expect(res.ok()).toBe(false);
    expect(await res.text()).toContain('TWO_FACTOR_AUTH_FAILED');
    expect(setsAccessCookie(res.headersArray(), recipient.id)).toBe(false);
    expect(await isSigningPageGated(page, recipient.token)).toBe(true);
  });

  test("C1: the recipient's own account is accepted with its own TOTP", async ({ page }) => {
    const { user: recipientUser } = await seedUser();
    const recipient = await seedAccess2FADocument(recipientUser);
    const secret = await signInWithAuthenticator(page, recipientUser);

    expect(await isSigningPageGated(page, recipient.token)).toBe(true);

    const res = await verifyAccess2FA(page, recipient.token, await totpFor(secret));

    expect(res.ok()).toBe(true);
    expect(setsAccessCookie(res.headersArray(), recipient.id)).toBe(true);
    expect(await isSigningPageGated(page, recipient.token)).toBe(false);
  });
});

test.describe('[RECIPIENT_ACCOUNT_MATCH] C2 completion without the access cookie', () => {
  test('C2: another account cannot complete with its own TOTP', async ({ page }) => {
    const { user: recipientUser } = await seedUser();
    const { recipient, documentId } = await seedCompletableAccess2FADocument(recipientUser);
    const { user: attacker } = await seedUser();
    const secret = await signInWithAuthenticator(page, attacker);

    const res = await completeWithAuthenticator(page, recipient.token, documentId, await totpFor(secret));

    expect(res.ok()).toBe(false);

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

    expect(after.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  });

  test("C2: the recipient's own account completes with its own TOTP", async ({ page }) => {
    const { user: recipientUser } = await seedUser();
    const { recipient, documentId } = await seedCompletableAccess2FADocument(recipientUser);
    const secret = await signInWithAuthenticator(page, recipientUser);

    const res = await completeWithAuthenticator(page, recipient.token, documentId, await totpFor(secret));

    expect(res.ok()).toBe(true);

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

    expect(after.signingStatus).toBe(SigningStatus.SIGNED);
  });
});

for (const internalVersion of [1, 2] as const) {
  const route = internalVersion === 1 ? 'V1 field.signFieldWithToken' : 'V2 envelope.field.sign';

  test.describe(`[RECIPIENT_ACCOUNT_MATCH] C3 action auth (${route})`, () => {
    test(`C3 TOTP ${route}: another account cannot sign with its own TOTP`, async ({ page }) => {
      const { user: recipientUser } = await seedUser();
      const { recipientToken, fieldId } = await seedActionAuthDocument(
        recipientUser,
        'TWO_FACTOR_AUTH',
        internalVersion,
      );
      const { user: attacker } = await seedUser();
      const secret = await signInWithAuthenticator(page, attacker);

      const res = await signField(page, internalVersion, recipientToken, fieldId, {
        type: 'TWO_FACTOR_AUTH',
        token: await totpFor(secret),
      });

      expect(res.ok()).toBe(false);
      await expectFieldUnsigned(fieldId);
    });

    test(`C3 TOTP ${route}: the recipient's own account signs with its own TOTP`, async ({ page }) => {
      const { user: recipientUser } = await seedUser();
      const { recipientToken, fieldId } = await seedActionAuthDocument(
        recipientUser,
        'TWO_FACTOR_AUTH',
        internalVersion,
      );
      const secret = await signInWithAuthenticator(page, recipientUser);

      const res = await signField(page, internalVersion, recipientToken, fieldId, {
        type: 'TWO_FACTOR_AUTH',
        token: await totpFor(secret),
      });

      expect(res.ok()).toBe(true);
      await expectFieldSigned(fieldId);
    });

    test(`C3 PASSWORD ${route}: another account cannot sign with its own password`, async ({ page }) => {
      const { user: recipientUser } = await seedUser();
      const { recipientToken, fieldId } = await seedActionAuthDocument(recipientUser, 'PASSWORD', internalVersion);
      const { user: attacker } = await seedUser({ password: ATTACKER_PASSWORD });

      await apiSignin({ page, email: attacker.email, password: ATTACKER_PASSWORD });

      const res = await signField(page, internalVersion, recipientToken, fieldId, {
        type: 'PASSWORD',
        password: ATTACKER_PASSWORD,
      });

      expect(res.ok()).toBe(false);
      await expectFieldUnsigned(fieldId);
    });

    test(`C3 PASSWORD ${route}: the recipient's own account signs with its own password`, async ({ page }) => {
      const { user: recipientUser } = await seedUser();
      const { recipientToken, fieldId } = await seedActionAuthDocument(recipientUser, 'PASSWORD', internalVersion);

      await apiSignin({ page, email: recipientUser.email, password: 'password' });

      const res = await signField(page, internalVersion, recipientToken, fieldId, {
        type: 'PASSWORD',
        password: 'password',
      });

      expect(res.ok()).toBe(true);
      await expectFieldSigned(fieldId);
    });
  });
}

test.describe('[RECIPIENT_ACCOUNT_MATCH] C4 direct template signing with action auth', () => {
  const seedPasswordDirectTemplate = async () => {
    const { user: owner, team } = await seedUser();

    const template = await seedDirectTemplate({
      title: '[TEST] Direct template with password action auth',
      userId: owner.id,
      teamId: team.id,
      createTemplateOptions: {
        authOptions: createDocumentAuthOptions({ globalAccessAuth: [], globalActionAuth: ['PASSWORD'] }),
      },
    });

    const signatureField = template.fields.find((field) => field.type === FieldType.SIGNATURE);

    if (!signatureField || !template.directLink) {
      throw new Error('Expected a direct link and a direct recipient signature field');
    }

    return { template, directToken: template.directLink.token, fieldId: signatureField.id };
  };

  const submitDirect = async (page: Page, directRecipientEmail: string, password: string) => {
    const { template, directToken, fieldId } = await seedPasswordDirectTemplate();
    const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });

    return await trpc(
      page,
      'template.createDocumentFromDirectTemplate',
      {
        directRecipientName: 'Direct Signer',
        directRecipientEmail,
        directTemplateToken: directToken,
        signedFieldValues: [
          {
            token: '',
            fieldId,
            value: 'Typed Signature',
            isBase64: false,
            authOptions: { type: 'PASSWORD', password },
          },
        ],
        templateUpdatedAt: envelope.updatedAt.toISOString(),
      },
      ['templateUpdatedAt'],
    );
  };

  test('C4: a signed-in user signing as their own email with their own password works', async ({ page }) => {
    const { user } = await seedUser();

    await apiSignin({ page, email: user.email, password: 'password' });

    const res = await submitDirect(page, user.email, 'password');

    expect(res.ok()).toBe(true);

    const created = await prisma.recipient.findFirstOrThrow({ where: { email: user.email } });

    expect(created.signingStatus).toBe(SigningStatus.SIGNED);
  });

  test("C4: a signed-in user signing as another account's email with their own password is refused", async ({
    page,
  }) => {
    const { user: attacker } = await seedUser({ password: ATTACKER_PASSWORD });
    const { user: otherAccount } = await seedUser();

    await apiSignin({ page, email: attacker.email, password: ATTACKER_PASSWORD });

    const res = await submitDirect(page, otherAccount.email, ATTACKER_PASSWORD);

    expect(res.ok()).toBe(false);
    expect(await prisma.recipient.count({ where: { email: otherAccount.email } })).toBe(0);
  });
});

test.describe('[RECIPIENT_ACCOUNT_MATCH] C5 email comparison', () => {
  test("C5: the recipient's own account is matched when the recipient email differs only in case", async ({ page }) => {
    const { user: recipientUser } = await seedUser();
    const { recipientToken, fieldId } = await seedActionAuthDocument(recipientUser.email.toUpperCase(), 'PASSWORD', 1);

    await apiSignin({ page, email: recipientUser.email, password: 'password' });

    const res = await signField(page, 1, recipientToken, fieldId, { type: 'PASSWORD', password: 'password' });

    expect(res.ok()).toBe(true);
    await expectFieldSigned(fieldId);
  });
});

/**
 * Amendment 1: a FREE_SIGNATURE field is a signature, so recipient action auth
 * applies to it as it does to SIGNATURE (C7). Other field types still sign
 * without action auth (C7b). The recipient is signed in to its own account
 * throughout, so a refusal can only come from the missing auth values.
 */
const seedRecipientActionAuthDocument = async (
  recipient: User,
  actionAuth: 'TWO_FACTOR_AUTH' | 'PASSWORD',
  internalVersion: 1 | 2,
) => {
  const { user: owner, team } = await seedUser();

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [recipient],
    recipientsCreateOptions: [
      { authOptions: createRecipientAuthOptions({ accessAuth: [], actionAuth: [actionAuth] }) },
    ],
    fields: [FieldType.FREE_SIGNATURE, FieldType.TEXT, FieldType.NAME, FieldType.DATE],
    updateDocumentOptions: { internalVersion },
  });

  const [seededRecipient] = recipients;

  const fieldIdOf = (type: FieldType) => {
    const field = seededRecipient.fields.find((candidate) => candidate.type === type);

    if (!field) {
      throw new Error(`Expected a seeded ${type} field`);
    }

    return field.id;
  };

  return {
    recipientToken: seededRecipient.token,
    freeSignatureFieldId: fieldIdOf(FieldType.FREE_SIGNATURE),
    textFieldId: fieldIdOf(FieldType.TEXT),
    nameFieldId: fieldIdOf(FieldType.NAME),
    dateFieldId: fieldIdOf(FieldType.DATE),
  };
};

/** Signs the recipient in and, for TWO_FACTOR_AUTH, enables its authenticator. Returns its own valid auth values. */
const signInRecipient = async (page: Page, recipient: User, actionAuth: 'TWO_FACTOR_AUTH' | 'PASSWORD') => {
  if (actionAuth === 'PASSWORD') {
    await apiSignin({ page, email: recipient.email, password: 'password' });

    return async () => ({ type: 'PASSWORD', password: 'password' });
  }

  const secret = await signInWithAuthenticator(page, recipient);

  return async () => ({ type: 'TWO_FACTOR_AUTH', token: await totpFor(secret) });
};

const signFreeSignature = async (
  page: Page,
  internalVersion: 1 | 2,
  recipientToken: string,
  fieldId: number,
  authOptions?: Record<string, unknown>,
) => {
  if (internalVersion === 1) {
    return await trpc(page, 'field.signFieldWithToken', {
      token: recipientToken,
      fieldId,
      value: 'Free Signature',
      isBase64: false,
      ...(authOptions ? { authOptions } : {}),
    });
  }

  // The V2 value schema has no FREE_SIGNATURE member, so this is the closest a
  // client can send for that field.
  return await trpc(page, 'envelope.field.sign', {
    token: recipientToken,
    fieldId,
    fieldValue: { type: FieldType.SIGNATURE, value: 'Free Signature' },
    ...(authOptions ? { authOptions } : {}),
  });
};

for (const actionAuth of ['TWO_FACTOR_AUTH', 'PASSWORD'] as const) {
  test.describe(`[RECIPIENT_ACCOUNT_MATCH] C7 FREE_SIGNATURE with recipient action auth ${actionAuth}`, () => {
    for (const internalVersion of [1, 2] as const) {
      const route = internalVersion === 1 ? 'V1 field.signFieldWithToken' : 'V2 envelope.field.sign';

      test(`C7 ${actionAuth} ${route}: a FREE_SIGNATURE field is refused with no auth values`, async ({ page }) => {
        const { user: recipientUser } = await seedUser();
        const { recipientToken, freeSignatureFieldId } = await seedRecipientActionAuthDocument(
          recipientUser,
          actionAuth,
          internalVersion,
        );

        await signInRecipient(page, recipientUser, actionAuth);

        const res = await signFreeSignature(page, internalVersion, recipientToken, freeSignatureFieldId);

        expect(res.ok()).toBe(false);
        await expectFieldUnsigned(freeSignatureFieldId);
      });
    }

    test(`C7 ${actionAuth} V1 field.signFieldWithToken: the recipient's own valid auth signs a FREE_SIGNATURE field`, async ({
      page,
    }) => {
      const { user: recipientUser } = await seedUser();
      const { recipientToken, freeSignatureFieldId } = await seedRecipientActionAuthDocument(
        recipientUser,
        actionAuth,
        1,
      );

      const ownAuth = await signInRecipient(page, recipientUser, actionAuth);

      const res = await signFreeSignature(page, 1, recipientToken, freeSignatureFieldId, await ownAuth());

      expect(res.ok()).toBe(true);
      await expectFieldSigned(freeSignatureFieldId);
    });

    for (const internalVersion of [1, 2] as const) {
      const route = internalVersion === 1 ? 'V1 field.signFieldWithToken' : 'V2 envelope.field.sign';

      test(`C7b ${actionAuth} ${route}: TEXT, NAME and DATE fields still sign with no auth values`, async ({
        page,
      }) => {
        const { user: recipientUser } = await seedUser();
        const { recipientToken, textFieldId, nameFieldId, dateFieldId } = await seedRecipientActionAuthDocument(
          recipientUser,
          actionAuth,
          internalVersion,
        );

        await apiSignin({ page, email: recipientUser.email, password: 'password' });

        for (const [fieldId, type, value] of [
          [textFieldId, FieldType.TEXT, 'Filled text'],
          [nameFieldId, FieldType.NAME, 'Filled Name'],
          [dateFieldId, FieldType.DATE, true],
        ] as const) {
          // The V2 DATE value is `true`; V1 takes the date as a string.
          const res =
            internalVersion === 1
              ? await trpc(page, 'field.signFieldWithToken', {
                  token: recipientToken,
                  fieldId,
                  value: type === FieldType.DATE ? new Date().toISOString() : value,
                  isBase64: false,
                })
              : await trpc(page, 'envelope.field.sign', {
                  token: recipientToken,
                  fieldId,
                  fieldValue: { type, value },
                });

          expect(res.ok(), `${type} field should sign without auth`).toBe(true);
          await expectFieldSigned(fieldId);
        }
      });
    }
  });
}
