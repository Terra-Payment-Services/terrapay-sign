/**
 * #174: a direct-template document must not record a signed-in user's id and
 * name against a different email address.
 *
 * Written from the specification (terrapay-sign-evidence/campaign-2026-10-17/F174/spec.md)
 * before any fix, without reading the implementation. The request under test is
 * `template.createDocumentFromDirectTemplate`, sent as the direct-link page sends
 * it: with the seeded session cookie of a signed-in user, or with none. Every
 * assertion reads the database or the Inbucket mail catcher.
 *
 * | Criterion | Test                                                                 |
 * | --------- | -------------------------------------------------------------------- |
 * | C1        | C1: a signed-in request with another address is refused, nothing made |
 * | C2        | C2: exact account email succeeds, recipient and audit carry it        |
 * | C2        | C2: a case-only difference succeeds, stored account email is recorded |
 * | C3        | C3: an anonymous request with any email succeeds, no user id          |
 * | C4        | C4: ACCOUNT access auth refuses anonymous, accepts the matching user  |
 */

import { DocumentAuth } from '@documenso/lib/types/document-auth';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentSigningOrder, DocumentStatus, EnvelopeType, FieldType } from '@prisma/client';
import { NO_MAIL_WINDOW_MS, readMailbox } from '../fixtures/send-path';
import {
  type G4DirectTemplate,
  seedG4DirectTemplate,
  seedG4Envelope,
  sessionHeaders,
  teamRowCounts,
  trpcWithDates,
  uniqueStamp,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const REFUSAL = 'The email must be the one on your account.';
const SIGNED_NAME = 'Identity Signer';
const CREATION_AUDIT_TYPES = [
  'DOCUMENT_CREATED',
  'DOCUMENT_OPENED',
  'DOCUMENT_FIELD_INSERTED',
  'DOCUMENT_RECIPIENT_COMPLETED',
];

const localPartOf = (email: string) => email.split('@')[0].toLowerCase();

/** A signed-in or anonymous direct-template submission, as the direct-link page sends it. */
const submit = async (
  request: APIRequestContext,
  template: G4DirectTemplate,
  email: string,
  headers: Record<string, string> = {},
  nextSigner?: { name: string; email: string },
) => {
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: template.envelopeId } });

  return await trpcWithDates(
    request,
    'template.createDocumentFromDirectTemplate',
    {
      directRecipientName: 'Direct Signer',
      directRecipientEmail: email,
      directTemplateToken: template.directToken,
      signedFieldValues: [{ token: '', fieldId: template.sigFieldId, value: SIGNED_NAME, isBase64: false }],
      templateUpdatedAt: envelope.updatedAt.toISOString(),
      ...(nextSigner ? { nextSigner } : {}),
    },
    ['templateUpdatedAt'],
    { headers },
  );
};

const createdEnvelopeId = (body: string) => {
  const parsed = JSON.parse(body) as { result?: { data?: { json?: { envelopeId?: string } } } };
  const envelopeId = parsed.result?.data?.json?.envelopeId;

  expect(envelopeId, `the reply names the envelope it created: ${body.slice(0, 300)}`).toBeTruthy();

  return envelopeId as string;
};

/** Seeds the template owner and a separate signer account, with the signer's session headers. */
const seedScene = async (authOptions?: Record<string, unknown>) => {
  const template = await seedG4DirectTemplate(2);
  const { user: signer } = await seedUser();

  if (authOptions) {
    await prisma.envelope.update({ where: { id: template.envelopeId }, data: { authOptions: authOptions as never } });
  }

  return { template, signer, headers: await sessionHeaders(signer.id) };
};

/** The direct recipient of the created document and its creation audit entries. */
const readCreated = async (envelopeId: string) => {
  const recipients = await prisma.recipient.findMany({ where: { envelopeId } });
  const audits = await prisma.documentAuditLog.findMany({
    where: { envelopeId, type: { in: CREATION_AUDIT_TYPES } },
    orderBy: { createdAt: 'asc' },
  });

  return { recipients, audits };
};

const expectAuditIdentity = (
  audits: { type: string; userId: number | null; email: string | null }[],
  expected: { userId: number | null; email: string | null } | { userId: null },
  label: string,
) => {
  for (const type of CREATION_AUDIT_TYPES) {
    expect(
      audits.some((a) => a.type === type),
      `${label}: an ${type} audit entry exists`,
    ).toBe(true);
  }

  for (const audit of audits) {
    expect(audit.userId, `${label}: ${audit.type} userId`).toBe(expected.userId);

    if ('email' in expected) {
      expect(audit.email, `${label}: ${audit.type} email`).toBe(expected.email);
    }
  }
};

test.describe('[DIRECT_TEMPLATE_SESSION_IDENTITY]: #174', () => {
  test('C1: a signed-in request with another address is refused and nothing is made', async ({ request }) => {
    const { template, signer, headers } = await seedScene();
    const teamId = template.owner.team.id;

    const stamp = uniqueStamp();
    const otherEmail = `c1-other-${stamp}@test.documenso.com`;
    const nearEmail = `x${signer.email}`;
    const watched = [localPartOf(signer.email), localPartOf(otherEmail), localPartOf(nearEmail)];

    const mailBefore = await Promise.all(watched.map(async (box) => (await readMailbox(request, box)).length));
    const rowsBefore = await teamRowCounts(teamId);

    for (const [label, email] of [
      ['a different address', otherEmail],
      ['the account address with a prefix', nearEmail],
    ] as const) {
      const reply = await submit(request, template, email, headers);

      expect
        .soft(reply.status, `${label}: refused with a 4xx (body ${reply.body.slice(0, 300)})`)
        .toBeGreaterThanOrEqual(400);
      expect.soft(reply.status, `${label}: refused with a 4xx`).toBeLessThan(500);
      expect.soft(reply.body, `${label}: the refusal message`).toContain(REFUSAL);

      expect
        .soft(await teamRowCounts(teamId), `${label}: no envelope, recipient or field is created for the template`)
        .toEqual(rowsBefore);

      const audits = await prisma.documentAuditLog.count({
        where: { type: { in: CREATION_AUDIT_TYPES }, email: { in: [email, signer.email] }, envelope: { teamId } },
      });

      expect.soft(audits, `${label}: no audit entry is written`).toBe(0);
    }

    await new Promise((resolve) => setTimeout(resolve, NO_MAIL_WINDOW_MS));

    const mailAfter = await Promise.all(watched.map(async (box) => (await readMailbox(request, box)).length));

    expect.soft(mailAfter, 'no email reaches the account address or either submitted address').toEqual(mailBefore);
  });

  test('C2: the exact account email succeeds, recipient and audit entries carry it', async ({ request }) => {
    const { template, signer, headers } = await seedScene();

    const reply = await submit(request, template, signer.email, headers);

    expect(reply.status, `the request succeeds (body ${reply.body.slice(0, 300)})`).toBe(200);

    const { recipients, audits } = await readCreated(createdEnvelopeId(reply.body));
    const direct = recipients.find((r) => r.email === signer.email);

    expect(direct, 'the direct recipient carries the account email').toBeTruthy();
    expect(recipients.map((r) => r.email)).toEqual([signer.email]);
    expectAuditIdentity(audits, { userId: signer.id, email: signer.email }, 'exact email');
  });

  test('C2: a case-only difference succeeds and records the stored account email', async ({ request }) => {
    const { template, signer, headers } = await seedScene();
    const shouting = signer.email.toUpperCase();

    expect(shouting, 'the variant differs from the stored address in case only').not.toBe(signer.email);

    const reply = await submit(request, template, shouting, headers);

    expect(reply.status, `the request succeeds (body ${reply.body.slice(0, 300)})`).toBe(200);

    const { recipients, audits } = await readCreated(createdEnvelopeId(reply.body));

    expect(
      recipients.map((r) => r.email),
      'the direct recipient email is the account email as stored',
    ).toEqual([signer.email]);
    expectAuditIdentity(audits, { userId: signer.id, email: signer.email }, 'case-only email');
  });

  test('C3: an anonymous request with any email succeeds and the audit entries carry no user id', async ({
    request,
  }) => {
    const { template } = await seedScene();
    const email = `c3-${uniqueStamp()}@test.documenso.com`;

    const reply = await submit(request, template, email);

    expect(reply.status, `the request succeeds (body ${reply.body.slice(0, 300)})`).toBe(200);

    const { recipients, audits } = await readCreated(createdEnvelopeId(reply.body));

    expect(recipients.map((r) => r.email)).toEqual([email]);
    expectAuditIdentity(audits, { userId: null, email }, 'anonymous');
  });

  test('C4: ACCOUNT access auth refuses an anonymous request and accepts the matching signed-in user', async ({
    request,
  }) => {
    const { template, signer, headers } = await seedScene({
      globalAccessAuth: [DocumentAuth.ACCOUNT],
      globalActionAuth: [],
    });
    const teamId = template.owner.team.id;
    const rowsBefore = await teamRowCounts(teamId);

    const anonymous = await submit(request, template, `c4-${uniqueStamp()}@test.documenso.com`);

    expect(anonymous.status, `anonymous is refused (body ${anonymous.body.slice(0, 300)})`).toBeGreaterThanOrEqual(400);
    expect(anonymous.status).toBeLessThan(500);
    expect(anonymous.body).toContain('You must be logged in');
    expect(await teamRowCounts(teamId), 'nothing is created for the anonymous request').toEqual(rowsBefore);

    const signedIn = await submit(request, template, signer.email, headers);

    expect(signedIn.status, `the matching user succeeds (body ${signedIn.body.slice(0, 300)})`).toBe(200);

    const { recipients, audits } = await readCreated(createdEnvelopeId(signedIn.body));

    expect(recipients.map((r) => r.email)).toEqual([signer.email]);
    expectAuditIdentity(audits, { userId: signer.id, email: signer.email }, 'ACCOUNT auth');
  });

  /** A SEQUENTIAL direct template whose direct recipient may dictate the next signer. */
  const seedDictatingScene = async () => {
    const seeded = await seedG4Envelope({
      internalVersion: 2,
      type: EnvelopeType.TEMPLATE,
      status: DocumentStatus.DRAFT,
      signingOrder: DocumentSigningOrder.SEQUENTIAL,
      allowDictateNextSigner: true,
      recipients: [
        {
          key: 'direct',
          signingOrder: 1,
          email: 'direct.link@documenso.com',
          name: 'Direct link recipient',
          fields: [{ key: 'sig', type: FieldType.SIGNATURE }],
        },
        { key: 'next', signingOrder: 2, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
      ],
    });
    const directToken = `a1-dt-${uniqueStamp()}`;

    await prisma.templateDirectLink.create({
      data: {
        envelopeId: seeded.envelopeId,
        enabled: true,
        token: directToken,
        directTemplateRecipientId: seeded.r.direct.id,
      },
    });

    const template = {
      ...seeded,
      directToken,
      directRecipientId: seeded.r.direct.id,
      sigFieldId: seeded.r.direct.fields.sig.id,
    } as G4DirectTemplate;
    const { user: signer } = await seedUser();

    return { template, signer, headers: await sessionHeaders(signer.id) };
  };

  const nextSignerAudits = async (envelopeId: string) =>
    await prisma.documentAuditLog.findMany({ where: { envelopeId, type: 'RECIPIENT_UPDATED' } });

  test('A1 C2b: a signed-in submission that dictates the next signer audits it with the user id and account email', async ({
    request,
  }) => {
    const { template, signer, headers } = await seedDictatingScene();
    const dictated = { name: 'Dictated Next', email: `a1-next-${uniqueStamp()}@test.documenso.com` };

    const reply = await submit(request, template, signer.email, headers, dictated);

    expect(reply.status, `the request succeeds (body ${reply.body.slice(0, 300)})`).toBe(200);

    const envelopeId = createdEnvelopeId(reply.body);
    const recipients = await prisma.recipient.findMany({ where: { envelopeId } });

    expect(
      recipients.map((r) => r.email),
      'the dictated signer is on the document',
    ).toContain(dictated.email);

    const audits = await nextSignerAudits(envelopeId);

    expect(audits.length, 'a RECIPIENT_UPDATED audit entry exists for the dictation').toBeGreaterThanOrEqual(1);

    for (const audit of audits) {
      expect(audit.userId, 'RECIPIENT_UPDATED userId is the submitting user, not null').toBe(signer.id);
      expect(audit.email, 'RECIPIENT_UPDATED email is the account email').toBe(signer.email);
    }
  });

  test('A1 C2b: an anonymous submission that dictates the next signer audits it with no user id', async ({
    request,
  }) => {
    const { template } = await seedDictatingScene();
    const direct = `a1-anon-${uniqueStamp()}@test.documenso.com`;
    const dictated = { name: 'Dictated Next', email: `a1-next-${uniqueStamp()}@test.documenso.com` };

    const reply = await submit(request, template, direct, {}, dictated);

    expect(reply.status, `the request succeeds (body ${reply.body.slice(0, 300)})`).toBe(200);

    const envelopeId = createdEnvelopeId(reply.body);
    const recipients = await prisma.recipient.findMany({ where: { envelopeId } });

    expect(recipients.map((r) => r.email)).toContain(dictated.email);

    const audits = await nextSignerAudits(envelopeId);

    expect(audits.length, 'a RECIPIENT_UPDATED audit entry exists for the dictation').toBeGreaterThanOrEqual(1);

    for (const audit of audits) {
      expect(audit.userId, 'RECIPIENT_UPDATED userId is null').toBeNull();
    }
  });
});
