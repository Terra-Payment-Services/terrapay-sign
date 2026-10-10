/**
 * Legacy (V1) documents and owner-restricted PDFs (criterion 9).
 *
 * Written from the specification alone, before reading any implementation.
 *
 * A V1 document cannot keep owner restrictions, so creating one from an
 * owner-restricted PDF must be refused when it is created, with a message
 * pointing the sender to envelopes, rather than accepted and failing at
 * completion after people have signed (F7).
 *
 * | Test                                                            | Criteria | Failure modes |
 * | --------------------------------------------------------------- | -------- | ------------- |
 * | legacy create accepts an ordinary pdf as a V1 document (control) | 8, 9     | F8            |
 * | legacy create refuses an owner-restricted pdf [x3 ciphers]       | 9        | F7, F9        |
 * | legacy template use accepts an ordinary template (control)       | 8, 9     | F8            |
 * | legacy template use refuses an owner-restricted template pdf     | 9        | F7            |
 *
 * Expected on main (red run): the four refusal tests fail because the V1
 * document is created (200). The controls pass on main.
 *
 * "No recipient is notified" is asserted as: no document envelope and no
 * recipient row exist afterwards. A recipient that was never stored cannot be
 * notified. The refused message is required to mention envelopes; no error
 * code is asserted because the specification names none.
 */
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedTemplate } from '@documenso/prisma/seed/templates';
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import { EnvelopeType, FieldType } from '@prisma/client';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  API_BASE_URL,
  assertVerifierToolsPresent,
  buildOwnerOnlyPdf,
  OWNER_ONLY_ALGORITHMS,
  ordinaryPdf,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const legacyCreateDocument = async (request: APIRequestContext, token: string, file: Buffer, title: string) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ title }));
  formData.append('file', new File([file], `${title}.pdf`, { type: 'application/pdf' }));

  return await request.post(`${API_BASE_URL}/document/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

/** A V1 template with one signer and one signature field, its PDF optionally replaced. */
const seedLegacyTemplate = async (userId: number, teamId: number, pdf?: Buffer) => {
  const template = await seedTemplate({ title: 'Legacy template', userId, teamId, internalVersion: 1 });
  const item = template.envelopeItems[0];

  if (pdf) {
    const base64 = pdf.toString('base64');

    await prisma.documentData.update({
      where: { id: item.documentDataId },
      data: { data: base64, initialData: base64 },
    });
  }

  await prisma.field.create({
    data: {
      envelopeId: template.id,
      envelopeItemId: item.id,
      recipientId: template.recipients[0].id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: 10,
      positionY: 60,
      width: 25,
      height: 8,
      customText: '',
      inserted: false,
    },
  });

  return template;
};

const useLegacyTemplate = async (
  request: APIRequestContext,
  token: string,
  template: Awaited<ReturnType<typeof seedLegacyTemplate>>,
  recipientEmail: string,
) =>
  await request.post(`${API_BASE_URL}/template/use`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      templateId: mapSecondaryIdToTemplateId(template.secondaryId),
      recipients: [{ id: template.recipients[0].id, email: recipientEmail, name: 'Legacy Signer' }],
      distributeDocument: true,
    },
  });

const expectRefusedWithEnvelopeAdvice = async (res: APIResponse) => {
  const text = await res.text();
  const body = (() => {
    try {
      return JSON.parse(text) as { message?: string };
    } catch {
      return {} as { message?: string };
    }
  })();

  expect(res.status(), `expected a refusal, got ${res.status()}: ${text}`).toBeGreaterThanOrEqual(400);
  expect(res.status(), `a refusal is the client's problem, not a server error: ${text}`).toBeLessThan(500);
  expect(res.status(), `the request reached its target: ${text}`).not.toBe(404);
  expect(body.message ?? '', 'the message tells the sender to use an envelope instead').toMatch(/envelope/i);
};

const countDocuments = async (teamId: number) =>
  await prisma.envelope.count({ where: { teamId, type: EnvelopeType.DOCUMENT } });

test('legacy_create_accepts_an_ordinary_pdf_as_a_v1_document', async ({ request }) => {
  const { token, team } = await apiCreateTestContext('legacy-create-control');

  const res = await legacyCreateDocument(request, token, ordinaryPdf(), 'legacy-ordinary');

  expect(res.status(), await res.text()).toBe(200);

  const { envelopeId } = (await res.json()) as { envelopeId: string };
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

  expect(envelope.teamId).toBe(team.id);
  expect(envelope.internalVersion, 'premise: this endpoint creates legacy V1 documents').toBe(1);
});

for (const algorithm of OWNER_ONLY_ALGORITHMS) {
  test(`legacy_create_refuses_an_owner_restricted_pdf_and_stores_nothing (${algorithm})`, async ({ request }) => {
    const { token, team } = await apiCreateTestContext('legacy-create-refused');

    const res = await legacyCreateDocument(request, token, await buildOwnerOnlyPdf(algorithm), `legacy-${algorithm}`);

    await expectRefusedWithEnvelopeAdvice(res);
    expect(await countDocuments(team.id), 'nothing is stored').toBe(0);
  });
}

test('legacy_template_use_accepts_an_ordinary_template', async ({ request }) => {
  const { token, user, team } = await apiCreateTestContext('legacy-template-control');
  const template = await seedLegacyTemplate(user.id, team.id);
  const email = `legacy-control-${Date.now()}@test.documenso.com`;

  const res = await useLegacyTemplate(request, token, template, email);

  expect(res.status(), await res.text()).toBe(200);

  const documents = await prisma.envelope.findMany({ where: { teamId: team.id, type: EnvelopeType.DOCUMENT } });

  expect(documents).toHaveLength(1);
  expect(documents[0].internalVersion, 'premise: a V1 template makes a V1 document').toBe(1);
});

test('legacy_template_use_refuses_an_owner_restricted_template_pdf_and_notifies_nobody', async ({ request }) => {
  const { token, user, team } = await apiCreateTestContext('legacy-template-refused');
  const template = await seedLegacyTemplate(user.id, team.id, await buildOwnerOnlyPdf('AES-256'));
  const email = `legacy-refused-${Date.now()}@test.documenso.com`;

  const res = await useLegacyTemplate(request, token, template, email);

  await expectRefusedWithEnvelopeAdvice(res);
  expect(await countDocuments(team.id), 'no document is stored').toBe(0);
  expect(await prisma.recipient.count({ where: { email } }), 'no recipient exists to be notified').toBe(0);
});
