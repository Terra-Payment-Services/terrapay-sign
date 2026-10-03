import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * "Require account" access auth used to be checked only when the signing page
 * loaded. The signing mutations take nothing but the token, so whoever held a
 * forwarded link could fill fields, reject or complete without signing in.
 */

const trpcMutation = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  return await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });
};

const seedAccountProtectedDocument = async () => {
  const { user: owner, team } = await seedUser();
  const { user: recipientUser } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [recipientUser],
    fields: [FieldType.TEXT],
    updateDocumentOptions: {
      authOptions: createDocumentAuthOptions({
        globalAccessAuth: ['ACCOUNT'],
        globalActionAuth: [],
      }),
    },
  });

  const [recipient] = recipients;

  return {
    token: recipient.token,
    recipientId: recipient.id,
    textFieldId: recipient.fields[0].id,
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
  };
};

test.describe('[DOCUMENT_AUTH]: signing mutations enforce account access auth', () => {
  test('field.signFieldWithToken refuses a caller who is not signed in', async ({ request }) => {
    const { token, textFieldId } = await seedAccountProtectedDocument();

    const res = await trpcMutation(request, 'field.signFieldWithToken', {
      token,
      fieldId: textFieldId,
      value: 'Forged',
      isBase64: false,
    });

    expect(res.ok()).toBeFalsy();

    const field = await prisma.field.findUniqueOrThrow({ where: { id: textFieldId } });

    expect(field.inserted).toBe(false);
  });

  test('recipient.rejectDocumentWithToken refuses a caller who is not signed in', async ({ request }) => {
    const { token, documentId, recipientId } = await seedAccountProtectedDocument();

    const res = await trpcMutation(request, 'recipient.rejectDocumentWithToken', {
      token,
      documentId,
      reason: 'Not mine to reject',
    });

    expect(res.ok()).toBeFalsy();

    const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });

    expect(recipient.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  });

  test('recipient.completeDocumentWithToken refuses a caller who is not signed in', async ({ request }) => {
    const { token, documentId, recipientId, textFieldId } = await seedAccountProtectedDocument();

    // Fill the only field so that nothing but the access check stands in the way.
    await prisma.field.update({ where: { id: textFieldId }, data: { inserted: true, customText: 'Filled' } });

    const res = await trpcMutation(request, 'recipient.completeDocumentWithToken', {
      token,
      documentId,
    });

    expect(res.ok()).toBeFalsy();

    const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });

    expect(recipient.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  });
});
