import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { FieldType } from '@documenso/prisma/client';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext } from '@playwright/test';
import { expect, request, test } from '@playwright/test';
import { nanoid } from 'nanoid';

import { KIB, MIB } from '../chunked-stall/support/raw-connection';
import {
  BackgroundJobStatus,
  createPendingCleanupJob,
  JSON_TYPE,
  jobStatus,
  paddedJson,
  signedCleanupTrigger,
} from './support/families';

/**
 * criterion 7 (F4, F5): requests representative of real use keep the status and body they get today. The answers
 * were measured on the unfixed server, so this file passes there and must still pass once the limits are in place.
 */

test.describe.configure({ mode: 'default' });

let nextClient = 0;
const contexts: APIRequestContext[] = [];

/** A request context with its own client address, so no rate limiter decides the answer. */
const client = async () => {
  nextClient += 1;

  const context = await request.newContext({
    baseURL: NEXT_PUBLIC_WEBAPP_URL(),
    extraHTTPHeaders: { 'X-Forwarded-For': `10.45.210.${nextClient}` },
  });
  contexts.push(context);

  return context;
};

test.afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.dispose();
  }
});

const apiToken = async () => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'family-45', expiresIn: null });

  return { user, team, token };
};

test.describe('criterion 7: /api/v1', () => {
  test('POST /api/v1/documents with a valid token and a normal body gets the answer it gets today', async () => {
    const { token } = await apiToken();
    const context = await client();
    const response = await context.post('/api/v1/documents', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': JSON_TYPE },
      data: {
        title: 'family-body-limits-45',
        recipients: [
          { name: 'Family Limits', email: `family-45-${nanoid(8).toLowerCase()}@example.com`, role: 'SIGNER' },
        ],
      },
    });
    const text = await response.text();

    // The route refuses to run without the S3 upload transport, which production does not use.
    if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT === 's3') {
      expect(response.status(), text).toBe(200);

      const body = JSON.parse(text);

      expect(typeof body.uploadUrl, 'uploadUrl').toBe('string');
      expect(typeof body.documentId, 'documentId').toBe('number');
      expect(body.recipients, 'recipients').toHaveLength(1);
    } else {
      expect(response.status(), text).toBe(500);
      expect(JSON.parse(text)).toEqual({ message: 'Create document is not available without S3 transport.' });
    }
  });

  test('POST /api/v1/documents/:id/fields with an array of just over 1 MiB creates every field', async () => {
    const { user, team, token } = await apiToken();
    const document = await seedDraftDocument(user, team.id, [`family-45-${nanoid(8).toLowerCase()}@example.com`]);
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
    const documentId = mapSecondaryIdToDocumentId(document.secondaryId);
    const fields = Array.from({ length: 50 }, (_, index) => ({
      recipientId: recipient.id,
      type: FieldType.TEXT,
      pageNumber: 1,
      pageX: 1 + index,
      pageY: 1,
      pageWidth: 5,
      pageHeight: 2,
      fieldMeta: { type: 'text', label: 'L'.repeat(22 * KIB) },
    }));
    const data = JSON.stringify(fields);

    // Over 1 MiB, so a ceiling of 1 MiB on /api/v1 (F4) refuses it, and far under the 10 MiB one.
    expect(Buffer.byteLength(data)).toBeGreaterThan(MIB);
    expect(Buffer.byteLength(data)).toBeLessThan(2 * MIB);

    const context = await client();
    const response = await context.post(`/api/v1/documents/${documentId}/fields`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': JSON_TYPE },
      data,
    });
    const text = await response.text();

    expect(response.status(), text.slice(0, 300)).toBe(200);

    const body = JSON.parse(text);

    expect(body.documentId).toBe(documentId);
    expect(body.fields).toHaveLength(50);
    expect(await prisma.field.count({ where: { envelopeId: document.id, type: FieldType.TEXT } })).toBe(50);
  });
});

test.describe('criterion 7: /api/auth', () => {
  const signIn = async (context: APIRequestContext, fields: Record<string, unknown>, totalBytes?: number) => {
    const { csrfToken } = await (await context.get('/api/auth/csrf')).json();
    const value = { ...fields, csrfToken };

    return await context.post('/api/auth/email-password/authorize', {
      headers: { 'Content-Type': JSON_TYPE },
      data: totalBytes === undefined ? JSON.stringify(value) : paddedJson(value, totalBytes),
    });
  };

  test('email-password sign-in with good credentials signs the user in', async () => {
    const { user } = await seedUser();
    const context = await client();
    const before = await prisma.session.count({ where: { userId: user.id } });
    const response = await signIn(context, { email: user.email, password: 'password' });

    // The sign-in route answers 201, measured on the unfixed server.
    expect(response.status(), await response.text()).toBe(201);
    expect(await prisma.session.count({ where: { userId: user.id } }), 'sessions for the user').toBe(before + 1);
  });

  test('email-password sign-in with bad credentials gets the answer it gets today', async () => {
    const context = await client();
    const response = await signIn(context, {
      email: `family-45-${nanoid(8).toLowerCase()}@example.com`,
      password: 'wrongpassword',
    });

    expect(response.status()).toBe(500);
    expect(await response.json()).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  });

  test('a 900 KiB sign-in body reaches the route and gets its own answer', async () => {
    const context = await client();
    const response = await signIn(
      context,
      { email: `family-45-${nanoid(8).toLowerCase()}@example.com`, password: 'wrongpassword' },
      900 * KIB,
    );

    expect(response.status()).toBe(500);
    expect(await response.json()).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  });
});

test.describe('criterion 7: /api/jobs under the local provider', () => {
  const trigger = async (totalBytes: number) => {
    const job = await createPendingCleanupJob();
    const signed = signedCleanupTrigger(job.id, totalBytes);

    expect(signed.body.length).toBe(totalBytes);

    const context = await client();
    const response = await context.post(signed.path, {
      headers: { ...signed.headers, 'Content-Type': JSON_TYPE },
      data: signed.body,
    });

    return { job, response };
  };

  test('a signed trigger carrying a 12 MiB JSON payload reaches the handler and runs the job', async () => {
    const { job, response } = await trigger(12 * MIB);

    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(await jobStatus(job.id), 'background job status').toBe(BackgroundJobStatus.COMPLETED);
  });

  test('an ordinary small signed trigger still runs the job', async () => {
    const { job, response } = await trigger(256);

    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(await jobStatus(job.id), 'background job status').toBe(BackgroundJobStatus.COMPLETED);
  });
});
