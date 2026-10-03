import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createDocumentAuthOptions } from '@documenso/lib/utils/document-auth';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * The emailed access code was checked with no limit on wrong guesses, so a
 * link holder could keep calling the completion mutation until a code matched.
 * After five attempts the recipient is locked out and the code is not checked.
 */
test('[DOCUMENT_AUTH]: locks the emailed access code after five attempts', async ({ request }) => {
  test.skip(process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true', 'Rate limits are bypassed');

  const { user: owner, team } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [`access-2fa-${Date.now()}@documenso.com`],
    fields: [FieldType.TEXT],
    updateDocumentOptions: {
      authOptions: createDocumentAuthOptions({
        globalAccessAuth: ['TWO_FACTOR_AUTH'],
        globalActionAuth: [],
      }),
    },
  });

  const [recipient] = recipients;

  // Fill the only field so that nothing but the code stands in the way.
  await prisma.field.update({
    where: { id: recipient.fields[0].id },
    data: { inserted: true, customText: 'Filled' },
  });

  const attempt = async () =>
    await request.post(`${WEBAPP_BASE_URL}/api/trpc/recipient.completeDocumentWithToken`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({
        json: {
          token: recipient.token,
          documentId: mapSecondaryIdToDocumentId(document.secondaryId),
          accessAuthOptions: { type: 'TWO_FACTOR_AUTH', method: 'email', token: 'not-a-code' },
        },
      }),
    });

  for (let i = 0; i < 5; i++) {
    const res = await attempt();

    expect(res.ok()).toBeFalsy();
    expect(res.status()).not.toBe(429);
  }

  const locked = await attempt();

  expect(locked.status()).toBe(429);

  const after = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

  expect(after.signingStatus).toBe(SigningStatus.NOT_SIGNED);
});
