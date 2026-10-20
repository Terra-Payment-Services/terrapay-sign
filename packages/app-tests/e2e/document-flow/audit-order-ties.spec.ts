/**
 * #178: the sealed audit pages list tied audit rows in a fixed order.
 *
 * Written from the specification (F178 spec.md, criteria A1 and A3), without
 * reading the fix. The setup is C26's (sender-details-hidden.spec.ts): a
 * document created through API v2 with a delegated owner, which writes
 * DOCUMENT_CREATED and then DOCUMENT_DELEGATED_OWNER_CREATED in one
 * transaction, then rejected so that it is sealed with its audit pages.
 *
 * | Test                                                                  | Criterion |
 * | --------------------------------------------------------------------- | --------- |
 * | A1 tied rows: the row written later is listed first                   | A1        |
 * | A3 rows whose createdAt differs keep createdAt order against id order | A3        |
 *
 * Only the order of the two entry headings is read. Headings sit in the left
 * column and come out of pdftotext in page order, so these tests do not depend
 * on the audit-entry reader that A2 covers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType, RecipientRole } from '@prisma/client';

import { flatPdfText } from '../fixtures/company-seals';
import { addressFor, jsonHeaders, uniqueLocalPart, V2_URL } from '../fixtures/send-path';

test.describe.configure({ mode: 'parallel', timeout: 240_000 });

const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();
const CREATED = 'DOCUMENT CREATED';
const DELEGATED = 'DOCUMENT DELEGATED OWNER CREATED';

const uniqueToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Posts a tRPC mutation the way the web client does. */
const trpcMutation = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  const res = await request.post(`${WEBAPP_URL}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });

  expect(res.ok(), `${procedure}: ${res.status()} ${await res.text()}`).toBe(true);
};

const downloadSigned = async (request: APIRequestContext, token: string, envelopeItemId: string) => {
  const res = await request.get(
    `${WEBAPP_URL}/api/files/token/${token}/envelopeItem/${envelopeItemId}/download/signed`,
  );

  expect(res.ok(), `signed download with a recipient token: ${res.status()}`).toBe(true);

  return new Uint8Array(await res.body());
};

/**
 * How the test rewrites DOCUMENT_DELEGATED_OWNER_CREATED's createdAt before the
 * seal: equal to DOCUMENT_CREATED's (a tie), or one second older, so that
 * createdAt order runs against id order.
 */
type Timing = 'tie' | 'delegated-older';

/**
 * Creates a document through API v2 with a delegated owner, rewrites the
 * delegation row's createdAt as `timing` says, rejects it so it is sealed, and
 * returns the sealed PDF's whitespace-collapsed text and the two rows.
 */
const sealDelegatedDocument = async (request: APIRequestContext, timing: Timing) => {
  const id = uniqueToken();
  const { user, team, organisation } = await seedUser({
    name: `Zelqsender${id}`,
    email: `zelq-sender-${id}@test.documenso.com`,
    teamEmail: `zelq-team-${id}@test.documenso.com`,
    isPersonalOrganisation: false,
  });

  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { includeAuditLog: true, delegateDocumentOwnership: true },
  });

  const delegate = await seedTeamMember({ teamId: team.id, name: `Wexdelegate${id}` });
  const { token: apiToken } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: `audit-order-${id}`,
    expiresIn: null,
  });

  const title = `Sdoc178${id}`;
  const signers = [
    { email: addressFor(uniqueLocalPart('a178a')), name: `Qorvarecipa${id}` },
    { email: addressFor(uniqueLocalPart('a178b')), name: `Qorvarecipb${id}` },
  ];
  const formData = new FormData();

  formData.append(
    'payload',
    JSON.stringify({
      type: 'DOCUMENT',
      title,
      delegatedDocumentOwner: delegate.email,
      recipients: signers.map((signer) => ({
        email: signer.email,
        name: signer.name,
        role: RecipientRole.SIGNER,
        fields: [{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 60, width: 25, height: 8 }],
      })),
    }),
  );

  const pdfData = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

  // The V2 audit pages print the file name, not the title, so the file carries
  // the title and the seal wait below can find it.
  formData.append('files', new File([pdfData], `${title}.pdf`, { type: 'application/pdf' }));

  const created = await request.post(`${V2_URL}/envelope/create`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    multipart: formData,
  });

  expect(created.ok(), `v2 envelope create: ${created.status()} ${await created.text()}`).toBe(true);

  const { id: envelopeId } = (await created.json()) as { id: string };
  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { envelopeItems: true },
  });

  expect(envelope.userId, 'premise: the delegated owner owns the document').toBe(delegate.id);

  const createdRow = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId, type: 'DOCUMENT_CREATED' },
  });
  const delegatedRow = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId, type: 'DOCUMENT_DELEGATED_OWNER_CREATED' },
  });

  expect(
    await prisma.documentAuditLog.count({
      where: { envelopeId, type: { in: ['DOCUMENT_CREATED', 'DOCUMENT_DELEGATED_OWNER_CREATED'] } },
    }),
    'premise: one row of each type',
  ).toBe(2);

  // cuid() ids grow in insertion order, and create-envelope writes the
  // delegation row second, so the delegation row is the one written later.
  expect(
    delegatedRow.id > createdRow.id,
    `premise: the delegation row's id (${delegatedRow.id}) sorts above DOCUMENT_CREATED's (${createdRow.id})`,
  ).toBe(true);

  const delegatedAt = timing === 'tie' ? createdRow.createdAt : new Date(createdRow.createdAt.getTime() - 1000);

  // Only the delegation row is rewritten, so it is also the newest tuple on
  // disk. Without an id tie-break Postgres then tends to return the tied pair
  // in scan order, DOCUMENT_CREATED first, which is the order A1 forbids.
  await prisma.documentAuditLog.update({ where: { id: delegatedRow.id }, data: { createdAt: delegatedAt } });

  const [createdAfter, delegatedAfter] = await Promise.all([
    prisma.documentAuditLog.findUniqueOrThrow({ where: { id: createdRow.id } }),
    prisma.documentAuditLog.findUniqueOrThrow({ where: { id: delegatedRow.id } }),
  ]);

  if (timing === 'tie') {
    expect(delegatedAfter.createdAt.getTime(), 'premise: the two rows share createdAt').toBe(
      createdAfter.createdAt.getTime(),
    );
  } else {
    expect(
      delegatedAfter.createdAt.getTime() < createdAfter.createdAt.getTime(),
      'premise: the delegation row is older than DOCUMENT_CREATED',
    ).toBe(true);
  }

  const distributed = await request.post(`${V2_URL}/envelope/distribute`, {
    headers: jsonHeaders(apiToken),
    data: { envelopeId },
  });

  expect(distributed.ok(), `v2 distribute: ${distributed.status()} ${await distributed.text()}`).toBe(true);

  const rejected = await prisma.recipient.findFirstOrThrow({ where: { envelopeId, email: signers[0].email } });

  await trpcMutation(request, 'recipient.rejectDocumentWithToken', {
    token: rejected.token,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    reason: 'The figures in schedule two are wrong',
  });

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status, {
      message: 'the document is REJECTED',
      timeout: 60_000,
    })
    .toBe('REJECTED');

  let flat = '';

  await expect
    .poll(
      async () => {
        flat = flatPdfText(await downloadSigned(request, rejected.token, envelope.envelopeItems[0].id));

        return flat.replace(/\s+/g, '').includes(title);
      },
      { message: 'the rejected document is sealed with its audit pages', timeout: 60_000 },
    )
    .toBe(true);

  return { flat, envelopeId, createdRow, delegatedRow };
};

/** The position of `heading` in `flat`, which must hold it exactly once. */
const headingAt = (flat: string, heading: string) => {
  const at = flat.indexOf(heading);

  expect(at >= 0, `the audit pages hold a "${heading}" entry`).toBe(true);
  expect(flat.indexOf(heading, at + heading.length), `the audit pages hold one "${heading}" entry`).toBe(-1);

  return at;
};

test('A1 tied audit rows: the delegation row, written later, is listed before DOCUMENT CREATED', async ({
  request,
}) => {
  const sealed = await sealDelegatedDocument(request, 'tie');

  expect(
    headingAt(sealed.flat, DELEGATED) < headingAt(sealed.flat, CREATED),
    `A1 (${sealed.envelopeId}): with equal createdAt, "${DELEGATED}" (id ${sealed.delegatedRow.id}) comes before "${CREATED}" (id ${sealed.createdRow.id})`,
  ).toBe(true);
});

test('A3 audit rows whose createdAt differs keep createdAt order even against id order', async ({ request }) => {
  const sealed = await sealDelegatedDocument(request, 'delegated-older');

  expect(
    headingAt(sealed.flat, CREATED) < headingAt(sealed.flat, DELEGATED),
    `A3 (${sealed.envelopeId}): "${CREATED}" is newer, so it comes before the older "${DELEGATED}" despite its lower id`,
  ).toBe(true);
});
