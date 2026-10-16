import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { WebhookTriggerEvents } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import {
  BackgroundJobStatus,
  CEILING_BYTES,
  connectionPool,
  createPendingCleanupJob,
  csrfPair,
  expectPayloadTooLarge,
  JSON_TYPE,
  jobStatus,
  paddedJson,
  signedCleanupTrigger,
} from './support/families';

/**
 * criterion 1, the observable half (F1, F2, F6): a request one byte over its family's ceiling, which would succeed
 * if the route ever saw it, is answered 413 and leaves no trace of the route. Each carries valid credentials, so on the
 * unfixed server the route runs to completion and answers 200: a document, a webhook, a session or a completed job.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(3000);

test.afterEach(() => pool.destroyAll());

const apiToken = async () => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'family-45', expiresIn: null });

  return { user, team, token };
};

test('POST /api/v1/documents with a valid token creates no document', async () => {
  const { team, token } = await apiToken();
  const before = await prisma.envelope.count({ where: { teamId: team.id } });
  const body = paddedJson(
    {
      title: 'family-body-limits-45',
      recipients: [{ name: 'Family Limits', email: 'family-limits-45@example.com', role: 'SIGNER' }],
    },
    CEILING_BYTES.v1 + 1,
  );
  const conn = await pool.connect({
    path: '/api/v1/documents',
    contentType: JSON_TYPE,
    contentLength: body.length,
    headers: { Authorization: `Bearer ${token}` },
  });

  await conn.sendBody(body);

  expectPayloadTooLarge('v1 documents', conn, await conn.waitResponse(20_000));
  expect(await prisma.envelope.count({ where: { teamId: team.id } }), 'documents on the team').toBe(before);
});

test('POST /api/v1/zapier/subscribe with a valid token creates no webhook', async () => {
  const { team, token } = await apiToken();
  const before = await prisma.webhook.count({ where: { teamId: team.id } });
  const body = paddedJson(
    { webhookUrl: 'https://1.1.1.1/family-body-limits-45', eventTrigger: WebhookTriggerEvents.DOCUMENT_SIGNED },
    CEILING_BYTES.v1 + 1,
  );
  const conn = await pool.connect({
    path: '/api/v1/zapier/subscribe',
    contentType: JSON_TYPE,
    contentLength: body.length,
    headers: { Authorization: `Bearer ${token}` },
  });

  await conn.sendBody(body);

  expectPayloadTooLarge('zapier subscribe', conn, await conn.waitResponse(20_000));
  expect(await prisma.webhook.count({ where: { teamId: team.id } }), 'webhooks on the team').toBe(before);
});

test('POST /api/auth/email-password/authorize with good credentials signs nobody in', async () => {
  const { user } = await seedUser();
  const forwardedFor = '10.45.200.1';
  const { csrfToken, cookie } = await csrfPair(forwardedFor);
  const before = await prisma.session.count({ where: { userId: user.id } });
  const body = paddedJson({ email: user.email, password: 'password', csrfToken }, CEILING_BYTES.auth + 1);
  const conn = await pool.connect({
    path: '/api/auth/email-password/authorize',
    contentType: JSON_TYPE,
    contentLength: body.length,
    forwardedFor,
    headers: { Cookie: cookie },
  });

  await conn.sendBody(body);

  const response = await conn.waitResponse(20_000);

  expectPayloadTooLarge('auth authorize', conn, response);
  expect(response?.headers['set-cookie'] ?? '', 'Set-Cookie on the refusal').not.toMatch(/session/i);
  expect(await prisma.session.count({ where: { userId: user.id } }), 'sessions for the user').toBe(before);
});

test('POST /api/jobs/<job>/<id> with a valid signature leaves the job pending', async () => {
  const job = await createPendingCleanupJob();
  const trigger = signedCleanupTrigger(job.id, CEILING_BYTES.jobs + 1);

  expect(trigger.body.length).toBe(CEILING_BYTES.jobs + 1);

  const conn = await pool.connect({
    path: trigger.path,
    contentType: JSON_TYPE,
    contentLength: trigger.body.length,
    headers: trigger.headers,
  });

  await conn.sendBody(trigger.body);

  expectPayloadTooLarge('jobs trigger', conn, await conn.waitResponse(20_000));
  expect(await jobStatus(job.id), 'background job status').toBe(BackgroundJobStatus.PENDING);
});
