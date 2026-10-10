/**
 * V2 embedded signing shows completion and tells the host page.
 *
 * Written from the specification alone (issue-27-v2-embed-completion), without reading the fix.
 *
 * Criteria and failure modes covered here:
 *
 *   Criterion 1 (F1): V2 envelope through /embed/sign/<token>: after sign and confirm the dialog
 *     closes and "Document Completed!" shows, as it does for V1.
 *   Criterion 2 (F1): the same for a V2 direct template through /embed/direct/<token>.
 *   Criterion 3 (F2): a host page that iframes the embed receives exactly one `document-completed`
 *     message from it, carrying the document id, recipient id and token that V1 sends.
 *   Criterion 4 (F3): when the server refuses the sign, the error toast shows, the confirmation
 *     dialog stays, "Document Completed!" does not show and no completion message is posted.
 *   Criterion 5 (F4): the V1 embed's completed state and completion message are unchanged.
 *   Criterion 6 (F4): non-embedded V2 signing at /sign/<token> still completes.
 *
 * The host page is a real local HTTP server on another port, so the embed is framed cross-origin.
 * The embed posts to window.parent with target origin "*" and applies no origin check, so any
 * host origin receives the message. Route-fulfilled host pages are refused by Chromium's local
 * network access checks when they frame localhost, hence the real server.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import type { FrameLocator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const PDF_PAGE_SELECTOR = 'img[data-page-number]';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

type TScope = Page | FrameLocator;

type TFieldBox = { id: number; positionX: unknown; positionY: unknown; width: unknown; height: unknown };

type THostMessage = { origin: string; data: { action?: string; data?: Record<string, unknown> | null } };

const hostServers: ReturnType<typeof createServer>[] = [];

test.afterEach(async () => {
  await Promise.all(hostServers.splice(0).map(async (server) => new Promise((resolve) => server.close(resolve))));
});

/** Serve a host page that iframes the embed URL and records every message event it receives. */
const openHostPage = async (page: Page, embedPath: string) => {
  const html = `<!doctype html><html><body style="margin:0">
<iframe id="embed" src="${WEBAPP_BASE_URL}${embedPath}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
  window.__messages = [];
  window.addEventListener('message', (event) => {
    window.__messages.push({ origin: event.origin, data: JSON.parse(JSON.stringify(event.data)) });
  });
</script></body></html>`;

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  hostServers.push(server);

  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);

  return page.frameLocator('#embed');
};

const readHostMessages = async (page: Page): Promise<THostMessage[]> => {
  return await page.evaluate(() => (window as unknown as { __messages: THostMessage[] }).__messages);
};

const completionMessages = async (page: Page) => {
  return (await readHostMessages(page)).filter((message) => message.data?.action === 'document-completed');
};

const expectDocumentVisible = async (scope: TScope) => {
  await expect(scope.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
};

const signSignaturePadIn = async (page: Page, scope: TScope) => {
  await page.waitForTimeout(200);

  await scope.getByTestId('signature-pad-dialog-button').click();
  await scope.getByRole('tab', { name: 'Type' }).click();
  await scope.getByTestId('signature-pad-type-input').fill('Signature');
  await scope.getByRole('button', { name: 'Next' }).click();
};

/** V1 renders each field as a DOM element; set a signature, then insert every field. */
const signV1Fields = async (page: Page, scope: TScope, fields: TFieldBox[]) => {
  await signSignaturePadIn(page, scope);

  for (const field of fields) {
    await scope.locator(`#field-${field.id}`).getByRole('button').click();
    await expect(scope.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
  }
};

/** V2 paints fields on a Konva canvas; aim at the middle of each field's stored box. */
const signV2Fields = async (page: Page, scope: TScope, fields: TFieldBox[]) => {
  const canvas = scope.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  await signSignaturePadIn(page, scope);

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  for (const field of fields) {
    const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
    const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

    await canvas.click({ position: { x, y } });
    await page.waitForTimeout(500);
  }

  await expect(scope.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });
};

/** Click Complete, fill the visitor email when the direct link asks for it, then confirm with Sign. */
const confirmV2Sign = async (scope: TScope, { directEmail }: { directEmail?: string } = {}) => {
  await scope.getByRole('button', { name: 'Complete' }).first().click();
  await expect(scope.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();

  if (directEmail) {
    await scope.getByRole('textbox', { name: 'Your Email' }).fill(directEmail);
  }

  await scope.getByRole('button', { name: 'Sign', exact: true }).click();
};

const expectCompletedState = async (scope: TScope) => {
  await expect(scope.getByRole('heading', { name: 'Document Completed!' })).toBeVisible({ timeout: 30_000 });
  await expect(scope.getByRole('heading', { name: 'Are you sure?' })).toHaveCount(0);
};

const seedPendingSigner = async (internalVersion: 1 | 2) => {
  const { user, team } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [seedTestEmail()],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion },
  });

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: document.id } });

  return {
    document,
    recipient: recipients[0],
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
  };
};

const seedDirect = async (internalVersion: 1 | 2) => {
  const { user, team } = await seedUser();

  const template = await seedDirectTemplate({
    title: `Embedded direct V${internalVersion}`,
    userId: user.id,
    teamId: team.id,
    internalVersion,
  });

  return { team, template, signerEmail: seedTestEmail() };
};

/** The recipient and document a direct link created for the visitor who signed. */
const findDirectSigner = async (teamId: number, email: string) => {
  const findSigner = async () => {
    return await prisma.recipient.findFirst({ where: { email, envelope: { teamId, type: 'DOCUMENT' } } });
  };

  await expect.poll(async () => (await findSigner())?.signingStatus, { timeout: 30_000 }).toBe(SigningStatus.SIGNED);

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: { email, envelope: { teamId, type: 'DOCUMENT' } },
  });

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: recipient.envelopeId } });

  return { recipient, envelope, documentId: mapSecondaryIdToDocumentId(envelope.secondaryId) };
};

/**
 * Exactly one completion message, shaped as V1 sends it: action `document-completed`, and data
 * carrying the document id, recipient id and recipient token. An envelope id, where sent, must
 * name the same envelope.
 */
const expectOneCompletionMessage = async (
  page: Page,
  expected: { documentId: number; recipientId: number; token: string; envelopeId?: string },
) => {
  await expect.poll(async () => (await completionMessages(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);

  // Give a duplicate time to arrive before counting.
  await page.waitForTimeout(3_000);

  const messages = await completionMessages(page);

  expect(messages, 'the host page receives exactly one document-completed message').toHaveLength(1);

  const [message] = messages;

  expect(message.data.data?.documentId).toBe(expected.documentId);
  expect(message.data.data?.recipientId).toBe(expected.recipientId);
  expect(message.data.data?.token).toBe(expected.token);

  if (expected.envelopeId) {
    expect(message.data.data?.envelopeId, 'the V2 payload names the envelope').toBe(expected.envelopeId);
  }
};

/** Make the server refuse a tRPC procedure, in the shape the tRPC client expects. */
const refuseProcedure = async (page: Page, procedure: string) => {
  await page.route(new RegExp(`/api/trpc/[^?]*${procedure.replace('.', '\\.')}`), async (route) => {
    const error = {
      error: { json: { message: 'refused', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } } },
    };

    const isBatch = new URL(route.request().url()).searchParams.has('batch');

    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify(isBatch ? [error] : error),
    });
  });
};

test.describe('Criterion 1: V2 envelope shows completion in the embed', () => {
  test('the dialog closes and Document Completed! shows after a V2 recipient signs in /embed/sign', async ({
    page,
  }) => {
    const { recipient } = await seedPendingSigner(2);

    await page.goto(`/embed/sign/${recipient.token}`);
    await expectDocumentVisible(page);

    await signV2Fields(page, page, recipient.fields);
    await confirmV2Sign(page);

    await expectCompletedState(page);
  });
});

test.describe('Criterion 2: V2 direct template shows completion in the embed', () => {
  test('the dialog closes and Document Completed! shows after a visitor signs in /embed/direct', async ({ page }) => {
    const { team, template, signerEmail } = await seedDirect(2);

    await page.goto(`/embed/direct/${template.directLink?.token}`);
    await expectDocumentVisible(page);

    await page.getByRole('textbox', { name: 'Full Name' }).fill('Direct Signer');

    await signV2Fields(page, page, template.fields);
    await confirmV2Sign(page, { directEmail: signerEmail });

    await expectCompletedState(page);
    await findDirectSigner(team.id, signerEmail);
  });
});

test.describe('Criterion 3: the host page receives the completion event from V2', () => {
  test('a host iframing a V2 /embed/sign receives one document-completed message with the V1 payload', async ({
    page,
  }) => {
    const { document, recipient, documentId } = await seedPendingSigner(2);

    const frame = await openHostPage(page, `/embed/sign/${recipient.token}`);

    await expectDocumentVisible(frame);

    await signV2Fields(page, frame, recipient.fields);
    await confirmV2Sign(frame);

    await expectOneCompletionMessage(page, {
      documentId,
      recipientId: recipient.id,
      token: recipient.token,
      envelopeId: document.id,
    });

    await expectCompletedState(frame);
  });

  test('a host iframing a V2 /embed/direct receives one document-completed message with the V1 payload', async ({
    page,
  }) => {
    const { team, template, signerEmail } = await seedDirect(2);

    const frame = await openHostPage(page, `/embed/direct/${template.directLink?.token}`);

    await expectDocumentVisible(frame);

    await frame.getByRole('textbox', { name: 'Full Name' }).fill('Direct Signer');

    await signV2Fields(page, frame, template.fields);
    await confirmV2Sign(frame, { directEmail: signerEmail });

    const signer = await findDirectSigner(team.id, signerEmail);

    await expectOneCompletionMessage(page, {
      documentId: signer.documentId,
      recipientId: signer.recipient.id,
      token: signer.recipient.token,
      envelopeId: signer.envelope.id,
    });
  });
});

test.describe('Criterion 4: a refused sign shows the error, not completion', () => {
  test('a V2 envelope sign the server refuses keeps the dialog and posts no completion message', async ({ page }) => {
    const { recipient } = await seedPendingSigner(2);

    await refuseProcedure(page, 'recipient.completeDocumentWithToken');

    const frame = await openHostPage(page, `/embed/sign/${recipient.token}`);

    await expectDocumentVisible(frame);

    await signV2Fields(page, frame, recipient.fields);
    await confirmV2Sign(frame);

    await expect(frame.getByTestId('toast').first()).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await expect(frame.getByRole('heading', { name: 'Document Completed!' })).toHaveCount(0);

    await page.waitForTimeout(3_000);

    expect(await completionMessages(page)).toHaveLength(0);
    expect(
      (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus,
      'the refused request never reached the server, so the recipient is still unsigned',
    ).not.toBe(SigningStatus.SIGNED);
  });

  test('a V2 direct sign the server refuses keeps the dialog and posts no completion message', async ({ page }) => {
    const { template, signerEmail } = await seedDirect(2);

    await refuseProcedure(page, 'template.createDocumentFromDirectTemplate');

    const frame = await openHostPage(page, `/embed/direct/${template.directLink?.token}`);

    await expectDocumentVisible(frame);

    await frame.getByRole('textbox', { name: 'Full Name' }).fill('Direct Signer');

    await signV2Fields(page, frame, template.fields);
    await confirmV2Sign(frame, { directEmail: signerEmail });

    await expect(frame.getByTestId('toast').first()).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await expect(frame.getByRole('heading', { name: 'Document Completed!' })).toHaveCount(0);

    await page.waitForTimeout(3_000);

    expect(await completionMessages(page)).toHaveLength(0);
  });
});

test.describe('Criterion 5: V1 embedded signing is unchanged', () => {
  test('a V1 /embed/sign shows Document Completed! and the host receives one completion message', async ({ page }) => {
    const { recipient, documentId } = await seedPendingSigner(1);

    const frame = await openHostPage(page, `/embed/sign/${recipient.token}`);

    await expectDocumentVisible(frame);

    await signV1Fields(page, frame, recipient.fields);
    await frame.getByRole('button', { name: 'Complete' }).first().click();

    await expect(frame.getByRole('heading', { name: 'Document Completed!' })).toBeVisible({ timeout: 30_000 });

    await expectOneCompletionMessage(page, { documentId, recipientId: recipient.id, token: recipient.token });
  });

  test('a V1 /embed/direct shows Document Completed! and the host receives one completion message', async ({
    page,
  }) => {
    const { team, template, signerEmail } = await seedDirect(1);

    const frame = await openHostPage(page, `/embed/direct/${template.directLink?.token}`);

    await expectDocumentVisible(frame);

    await frame.getByRole('textbox', { name: 'Full Name' }).fill('Direct Signer');
    await frame.getByRole('textbox', { name: 'Email' }).fill(signerEmail);

    await signV1Fields(page, frame, template.fields);
    await frame.getByRole('button', { name: 'Complete' }).first().click();

    await expect(frame.getByRole('heading', { name: 'Document Completed!' })).toBeVisible({ timeout: 30_000 });

    const signer = await findDirectSigner(team.id, signerEmail);

    await expectOneCompletionMessage(page, {
      documentId: signer.documentId,
      recipientId: signer.recipient.id,
      token: signer.recipient.token,
    });
  });
});

test.describe('Criterion 6: non-embedded V2 signing is unchanged', () => {
  test('a V2 recipient signing at /sign/<token> reaches the signing complete page', async ({ page }) => {
    const { document, recipient } = await seedPendingSigner(2);

    await page.goto(`/sign/${recipient.token}`);
    await expectDocumentVisible(page);

    await signV2Fields(page, page, recipient.fields);
    await confirmV2Sign(page);

    await page.waitForURL(`**/sign/${recipient.token}/complete`, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();

    await expect
      .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: document.id } })).status, {
        timeout: 60_000,
      })
      .toBe('COMPLETED');
  });
});
