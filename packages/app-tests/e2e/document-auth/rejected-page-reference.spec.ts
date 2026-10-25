import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createDocumentAuthOptions, createRecipientAuthOptions } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { apiSignin } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

type AccessLevel = 'document' | 'recipient' | 'none';

/**
 * The rejected page names the recipient by name, else by the NAME field they
 * typed, else by email. Before the recipient has proved who they are, it may
 * show only the email (#245).
 */
const seedRejected = async (
  prefix: string,
  access: AccessLevel,
  options: { withName?: boolean; internalVersion?: number } = {},
) => {
  const { withName = false, internalVersion = 1 } = options;
  const { user, team } = await seedUser();
  const { user: recipientUser } = await seedUser();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const customText = `Typed name ${prefix} ${suffix}`;
  const recipientName = withName ? `Recipient name ${prefix} ${suffix}` : '';

  const seeded = await seedPendingDocument(user, team.id, [recipientUser], {
    internalVersion,
    createDocumentOptions:
      access === 'document'
        ? { authOptions: createDocumentAuthOptions({ globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] }) }
        : {},
  });

  const recipient = seeded.recipients[0];

  await prisma.field.updateMany({
    where: { recipientId: recipient.id, type: FieldType.NAME },
    data: { customText },
  });

  await prisma.recipient.update({
    where: { id: recipient.id },
    data: {
      name: recipientName,
      signingStatus: SigningStatus.REJECTED,
      rejectionReason: 'Not for me',
      ...(access === 'recipient'
        ? { authOptions: createRecipientAuthOptions({ accessAuth: ['ACCOUNT'], actionAuth: [] }) }
        : {}),
    },
  });

  await prisma.envelope.update({ where: { id: seeded.id }, data: { status: DocumentStatus.REJECTED } });

  return { recipient, recipientUser, customText, recipientName };
};

const pageUrls = (token: string) => [
  `${WEBAPP_BASE_URL}/sign/${token}/rejected`,
  `${WEBAPP_BASE_URL}/sign/${token}/rejected.data`,
];

for (const access of ['document', 'recipient'] as const) {
  test(`[DOCUMENT_AUTH]: the rejected page shows only the email before account auth (${access} level)`, async ({
    page,
    request,
  }) => {
    const { recipient, customText } = await seedRejected(`c1-${access}`, access);

    for (const url of pageUrls(recipient.token)) {
      const body = await (await request.get(url)).text();

      expect(body, `anonymous ${url}`).not.toContain(customText);
      expect(body, `anonymous ${url}`).toContain(recipient.email);
    }

    await page.goto(`/sign/${recipient.token}/rejected`);

    await expect(page.getByText(recipient.email).first()).toBeVisible();
    await expect(page.getByText(customText)).toHaveCount(0);
    await expect(page.getByText('Document Rejected').first()).not.toBeVisible();

    const { user: other } = await seedUser();

    await apiSignin({ page, email: other.email });

    for (const url of pageUrls(recipient.token)) {
      const res = await page.context().request.get(url);
      const body = await res.text();

      expect(body, `signed-in other ${url}`).not.toContain(customText);
      expect(body, `signed-in other ${url}`).toContain(recipient.email);
    }

    await page.goto(`/sign/${recipient.token}/rejected`);

    await expect(page.getByText(recipient.email).first()).toBeVisible();
    await expect(page.getByText(customText)).toHaveCount(0);
    await expect(page.getByText('Document Rejected').first()).not.toBeVisible();
  });

  test(`[DOCUMENT_AUTH]: the signed-in recipient sees their reference on the rejected page (${access} level)`, async ({
    page,
  }) => {
    const { recipient, recipientUser, customText } = await seedRejected(`c2-${access}`, access);

    await apiSignin({ page, email: recipientUser.email });

    await page.goto(`/sign/${recipient.token}/rejected`);

    await expect(page.getByText('Document Rejected').first()).toBeVisible();

    const data = await (
      await page.context().request.get(`${WEBAPP_BASE_URL}/sign/${recipient.token}/rejected.data`)
    ).text();

    expect(data).toContain(customText);
  });
}

const expectNoLeakBeforeAuth = async (
  page: Page,
  request: APIRequestContext,
  recipient: { token: string; email: string },
  markers: string[],
) => {
  const check = async (label: string, get: (url: string) => Promise<string>) => {
    for (const url of pageUrls(recipient.token)) {
      const body = await get(url);

      for (const marker of markers) {
        expect(body, `${label} ${url}`).not.toContain(marker);
      }

      expect(body, `${label} ${url}`).toContain(recipient.email);
    }

    await page.goto(`/sign/${recipient.token}/rejected`);

    await expect(page.getByText(recipient.email).first()).toBeVisible();

    for (const marker of markers) {
      await expect(page.getByText(marker)).toHaveCount(0);
    }

    await expect(page.getByText('Document Rejected').first()).not.toBeVisible();
  };

  await check('anonymous', async (url) => await (await request.get(url)).text());

  const { user: other } = await seedUser();

  await apiSignin({ page, email: other.email });

  await check('signed-in other', async (url) => await (await page.context().request.get(url)).text());
};

for (const access of ['document', 'recipient'] as const) {
  test(`[DOCUMENT_AUTH]: C1b the rejected page hides a populated recipient name and NAME value before account auth (${access} level)`, async ({
    page,
    request,
  }) => {
    const { recipient, customText, recipientName } = await seedRejected(`c1b-${access}`, access, { withName: true });

    await expectNoLeakBeforeAuth(page, request, recipient, [customText, recipientName]);
  });

  test(`[DOCUMENT_AUTH]: C1c the rejected page hides a populated recipient name and NAME value on a V2 envelope (${access} level)`, async ({
    page,
    request,
  }) => {
    const { recipient, customText, recipientName } = await seedRejected(`c1c-${access}`, access, {
      withName: true,
      internalVersion: 2,
    });

    await expectNoLeakBeforeAuth(page, request, recipient, [customText, recipientName]);
  });

  test(`[DOCUMENT_AUTH]: C2b the signed-in recipient sees their populated name on the rejected page (${access} level)`, async ({
    page,
  }) => {
    const { recipient, recipientUser, recipientName } = await seedRejected(`c2b-${access}`, access, {
      withName: true,
    });

    await apiSignin({ page, email: recipientUser.email });

    await page.goto(`/sign/${recipient.token}/rejected`);

    await expect(page.getByText('Document Rejected').first()).toBeVisible();

    const data = await (
      await page.context().request.get(`${WEBAPP_BASE_URL}/sign/${recipient.token}/rejected.data`)
    ).text();

    expect(data).toContain(recipientName);
  });
}

/**
 * Control: with no access auth the page shows as before, with the NAME field
 * value as the reference.
 */
test('[DOCUMENT_AUTH]: the rejected page is unchanged for a recipient with no access auth', async ({ page }) => {
  const { recipient, customText } = await seedRejected('c3', 'none');

  await page.goto(`/sign/${recipient.token}/rejected`);

  await expect(page.getByText('Document Rejected').first()).toBeVisible();

  const data = await (
    await page.context().request.get(`${WEBAPP_BASE_URL}/sign/${recipient.token}/rejected.data`)
  ).text();

  expect(data).toContain(customText);
});
