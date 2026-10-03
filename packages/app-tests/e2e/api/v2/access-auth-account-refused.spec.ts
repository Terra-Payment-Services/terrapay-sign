import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { createDocumentAuthOptions, createRecipientAuthOptions } from '@documenso/lib/utils/document-auth';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { TCreateEnvelopePayload } from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { TCreateEnvelopeRecipientsRequest } from '@documenso/trpc/server/envelope-router/envelope-recipients/create-envelope-recipients.types';
import type { TUpdateEnvelopeRecipientsRequest } from '@documenso/trpc/server/envelope-router/envelope-recipients/update-envelope-recipients.types';
import type { TUpdateEnvelopeRequest } from '@documenso/trpc/server/envelope-router/update-envelope.types';
import { type APIRequestContext, expect, test } from '@playwright/test';
import type { Team, User } from '@prisma/client';

const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const pdf = fs.readFileSync(path.join(__dirname, '../../../../../assets/field-font-alignment.pdf'));

test.describe.configure({ mode: 'parallel' });

/**
 * "Require account" access auth is no longer offered. New writes that ask for it are refused,
 * while envelopes and recipients that already carry it keep it.
 */
test.describe('API V2 refuses newly added "Require account" access auth', () => {
  let user: User, team: Team, token: string;

  test.beforeEach(async () => {
    ({ user, team } = await seedUser());
    ({ token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'access-auth',
      expiresIn: null,
    }));
  });

  const createEnvelope = async (request: APIRequestContext, payload: TCreateEnvelopePayload) => {
    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));
    formData.append('files', new File([pdf], 'field-font-alignment.pdf', { type: 'application/pdf' }));

    return await request.post(`${baseUrl}/envelope/create`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: formData,
    });
  };

  test('refuses a new envelope with global ACCOUNT access and creates nothing', async ({ request }) => {
    const title = `Account access ${Date.now()}`;

    const res = await createEnvelope(request, {
      type: EnvelopeType.DOCUMENT,
      title,
      globalAccessAuth: ['ACCOUNT'],
    });

    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('Require account');
    expect(await prisma.envelope.count({ where: { teamId: team.id, title } })).toBe(0);
  });

  test('refuses a new envelope whose recipient asks for ACCOUNT access', async ({ request }) => {
    const title = `Recipient account access ${Date.now()}`;

    const res = await createEnvelope(request, {
      type: EnvelopeType.DOCUMENT,
      title,
      recipients: [
        {
          email: 'account-access-recipient@test.documenso.com',
          name: 'Recipient',
          role: RecipientRole.SIGNER,
          accessAuth: ['ACCOUNT'],
        },
      ],
    });

    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('Require account');
    expect(await prisma.envelope.count({ where: { teamId: team.id, title } })).toBe(0);
  });

  test('still accepts TWO_FACTOR_AUTH access on a new envelope', async ({ request }) => {
    const res = await createEnvelope(request, {
      type: EnvelopeType.DOCUMENT,
      title: 'Two factor access',
      globalAccessAuth: ['TWO_FACTOR_AUTH'],
    });

    expect(res.status()).toBe(200);
  });

  test('API v1 refuses generating a document from a template with ACCOUNT access', async ({ request }) => {
    const template = await seedBlankTemplate(user, team.id);
    const title = `V1 account access ${Date.now()}`;

    const res = await request.post(
      `${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/templates/${mapSecondaryIdToTemplateId(template.secondaryId)}/generate-document`,
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { title, recipients: [], authOptions: { globalAccessAuth: ['ACCOUNT'] } },
      },
    );

    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('Require account');
    expect(await prisma.envelope.count({ where: { teamId: team.id, title } })).toBe(0);
  });

  test('refuses adding ACCOUNT access to an envelope that did not have it', async ({ request }) => {
    const document = await seedBlankDocument(user, team.id);

    const res = await request.post(`${baseUrl}/envelope/update`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        envelopeId: document.id,
        data: { globalAccessAuth: ['ACCOUNT'] },
      } satisfies TUpdateEnvelopeRequest,
    });

    expect(res.status()).toBe(400);

    const stored = await prisma.envelope.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored.authOptions).toBeNull();
  });

  test('keeps ACCOUNT access on an existing envelope while other settings change', async ({ request }) => {
    const document = await seedBlankDocument(user, team.id, {
      createDocumentOptions: {
        authOptions: createDocumentAuthOptions({ globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] }),
      },
    });

    const res = await request.post(`${baseUrl}/envelope/update`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        envelopeId: document.id,
        data: { title: 'Renamed', globalAccessAuth: ['ACCOUNT'] },
      } satisfies TUpdateEnvelopeRequest,
    });

    expect(res.status()).toBe(200);

    const stored = await prisma.envelope.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored.title).toBe('Renamed');
    expect(stored.authOptions).toEqual({ globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] });
  });

  test('refuses a new recipient with ACCOUNT access', async ({ request }) => {
    const document = await seedBlankDocument(user, team.id);

    const res = await request.post(`${baseUrl}/envelope/recipient/create-many`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        envelopeId: document.id,
        data: [
          {
            email: 'new-account-recipient@test.documenso.com',
            name: 'Recipient',
            role: RecipientRole.SIGNER,
            accessAuth: ['ACCOUNT'],
            actionAuth: [],
          },
        ],
      } satisfies TCreateEnvelopeRecipientsRequest,
    });

    expect(res.status()).toBe(400);
    expect(await prisma.recipient.count({ where: { envelopeId: document.id } })).toBe(0);
  });

  test('refuses adding ACCOUNT access to an existing recipient but keeps one that has it', async ({ request }) => {
    const document = await seedBlankDocument(user, team.id);

    const [plainRecipient, accountRecipient] = await Promise.all([
      prisma.recipient.create({
        data: {
          envelopeId: document.id,
          email: 'plain-recipient@test.documenso.com',
          name: 'Plain',
          token: `plain-${Date.now()}`,
          authOptions: createRecipientAuthOptions({ accessAuth: [], actionAuth: [] }),
        },
      }),
      prisma.recipient.create({
        data: {
          envelopeId: document.id,
          email: 'account-recipient@test.documenso.com',
          name: 'Account',
          token: `account-${Date.now()}`,
          authOptions: createRecipientAuthOptions({ accessAuth: ['ACCOUNT'], actionAuth: [] }),
        },
      }),
    ]);

    const refused = await request.post(`${baseUrl}/envelope/recipient/update-many`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        envelopeId: document.id,
        data: [{ id: plainRecipient.id, accessAuth: ['ACCOUNT'] }],
      } satisfies TUpdateEnvelopeRecipientsRequest,
    });

    expect(refused.status()).toBe(400);

    const kept = await request.post(`${baseUrl}/envelope/recipient/update-many`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        envelopeId: document.id,
        data: [{ id: accountRecipient.id, name: 'Account renamed', accessAuth: ['ACCOUNT'] }],
      } satisfies TUpdateEnvelopeRecipientsRequest,
    });

    expect(kept.status()).toBe(200);

    const storedAccountRecipient = await prisma.recipient.findUniqueOrThrow({ where: { id: accountRecipient.id } });
    expect(storedAccountRecipient.name).toBe('Account renamed');
    expect(storedAccountRecipient.authOptions).toEqual({ accessAuth: ['ACCOUNT'], actionAuth: [] });

    const storedPlainRecipient = await prisma.recipient.findUniqueOrThrow({ where: { id: plainRecipient.id } });
    expect(storedPlainRecipient.authOptions).toEqual({ accessAuth: [], actionAuth: [] });
  });
});
