/**
 * A V1 document cannot gain owner restrictions by copying (criterion 12,
 * the duplicate half; direct-template signing is in
 * e2e/templates/protected-pdf-direct-template.spec.ts).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * Duplicating a V1 document or V1 template whose PDF is owner-restricted
 * must be refused before any document, recipient or audit entry is created
 * (F11: the copy reaches signers and fails only at completion).
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | duplicating an ordinary V1 document and template (controls)    | 8, 12    | F8            |
 * | document/duplicate refuses an owner-restricted V1 document     | 12       | F11           |
 * | template/duplicate refuses an owner-restricted V1 template     | 12       | F11           |
 * | envelope/duplicate never yields a V1 copy of an                | 12       | F11           |
 * |   owner-restricted V1 document or template                     |          |               |
 * | document/duplicate refuses a V1 document whose original upload | 20       | F19           |
 * |   is owner-restricted though its current file is not           |          |               |
 * | envelope/duplicate: the same record never yields a V1 copy     | 20       | F19           |
 *
 * The duplicate routes and their bodies (`{ documentId }`, `{ templateId }`,
 * `{ envelopeId }`) are the ones test-unauthorized-api-access.spec.ts calls.
 * envelope/duplicate is a newer route that may legitimately copy a V1
 * envelope as an envelope (V2), which can keep owner restrictions; so for it
 * the requirement is that it refuses or that the copy is not V1.
 *
 * "Nothing is created" is counted per team: envelopes, recipients, document
 * data rows and audit entries for the team's envelopes or by the test's user
 * since the request was made. Duplicates are drafts and notify nobody, so the
 * absence of any new recipient stands for "no notification".
 *
 * Criterion 20 is a legacy record shaped by hand, as Ram allowed: its
 * DocumentData.initialData (the original upload) is the owner-restricted PDF
 * and DocumentData.data (the current version) is the ordinary one.
 */
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { seedTemplate } from '@documenso/prisma/seed/templates';
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';

import { type ApiSeedContext, apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  API_BASE_URL,
  assertVerifierToolsPresent,
  buildOwnerOnlyPdf,
  ordinaryPdf,
  readEncryptionWithPdfinfo,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const replacePdf = async (envelopeId: string, pdf: Buffer) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });
  const base64 = pdf.toString('base64');

  await prisma.documentData.update({ where: { id: item.documentDataId }, data: { data: base64, initialData: base64 } });
};

const seedV1Document = async (owner: ApiSeedContext['user'], teamId: number, pdf?: Buffer) => {
  const email = `copy-signer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com`;
  const document = await seedDraftDocument(owner, teamId, [email], { internalVersion: 1 });

  if (pdf) {
    await replacePdf(document.id, pdf);
  }

  return document;
};

const seedV1Template = async (userId: number, teamId: number, pdf?: Buffer) => {
  const template = await seedTemplate({ title: 'V1 template to copy', userId, teamId, internalVersion: 1 });

  if (pdf) {
    await replacePdf(template.id, pdf);
  }

  return template;
};

const snapshot = async (teamId: number, userId: number, since: Date) => ({
  envelopes: await prisma.envelope.count({ where: { teamId } }),
  recipients: await prisma.recipient.count({ where: { envelope: { teamId } } }),
  documentData: await prisma.documentData.count({ where: { envelopeItem: { envelope: { teamId } } } }),
  auditEntriesSince: await prisma.documentAuditLog.count({
    where: { createdAt: { gte: since }, OR: [{ envelope: { teamId } }, { userId }] },
  }),
});

const duplicate = async (request: APIRequestContext, token: string, route: string, data: Record<string, unknown>) =>
  await request.post(`${API_BASE_URL}/${route}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data,
  });

const expectRefused = async (res: APIResponse) => {
  const text = await res.text();

  expect(res.status(), `expected a refusal, got ${res.status()}: ${text}`).toBeGreaterThanOrEqual(400);
  expect(res.status(), `a refusal is the client's problem, not a server error: ${text}`).toBeLessThan(500);
  expect(res.status(), `the request reached its target: ${text}`).not.toBe(404);
};

test('criterion_12_control_ordinary_v1_document_and_template_duplicate', async ({ request }) => {
  const { token, user, team } = await apiCreateTestContext('copy-control');
  const document = await seedV1Document(user, team.id);
  const template = await seedV1Template(user.id, team.id);

  const documentCopy = await duplicate(request, token, 'document/duplicate', {
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
  });
  const templateCopy = await duplicate(request, token, 'template/duplicate', {
    templateId: mapSecondaryIdToTemplateId(template.secondaryId),
  });

  expect(documentCopy.status(), await documentCopy.text()).toBe(200);
  expect(templateCopy.status(), await templateCopy.text()).toBe(200);
  expect(await prisma.envelope.count({ where: { teamId: team.id } }), 'two originals and two copies').toBe(4);
});

test('criterion_12_document_duplicate_refuses_an_owner_restricted_v1_document_and_creates_nothing', async ({
  request,
}) => {
  const { token, user, team } = await apiCreateTestContext('copy-document-refused');
  const document = await seedV1Document(user, team.id, await buildOwnerOnlyPdf('AES-256'));
  const since = new Date();
  const before = await snapshot(team.id, user.id, since);

  const res = await duplicate(request, token, 'document/duplicate', {
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
  });

  await expectRefused(res);
  expect(await snapshot(team.id, user.id, since), 'nothing was created').toEqual(before);
});

test('criterion_12_template_duplicate_refuses_an_owner_restricted_v1_template_and_creates_nothing', async ({
  request,
}) => {
  const { token, user, team } = await apiCreateTestContext('copy-template-refused');
  const template = await seedV1Template(user.id, team.id, await buildOwnerOnlyPdf('AES-256'));
  const since = new Date();
  const before = await snapshot(team.id, user.id, since);

  const res = await duplicate(request, token, 'template/duplicate', {
    templateId: mapSecondaryIdToTemplateId(template.secondaryId),
  });

  await expectRefused(res);
  expect(await snapshot(team.id, user.id, since), 'nothing was created').toEqual(before);
});

for (const kind of ['document', 'template'] as const) {
  test(`criterion_12_envelope_duplicate_never_yields_a_v1_copy_of_an_owner_restricted_v1_${kind}`, async ({
    request,
  }) => {
    const { token, user, team } = await apiCreateTestContext(`copy-envelope-${kind}`);
    const pdf = await buildOwnerOnlyPdf('AES-256');
    const original =
      kind === 'document' ? await seedV1Document(user, team.id, pdf) : await seedV1Template(user.id, team.id, pdf);
    const since = new Date();
    const before = await snapshot(team.id, user.id, since);

    const res = await duplicate(request, token, 'envelope/duplicate', { envelopeId: original.id });

    if (!res.ok()) {
      await expectRefused(res);
      expect(await snapshot(team.id, user.id, since), 'nothing was created').toEqual(before);

      return;
    }

    const copies = await prisma.envelope.findMany({ where: { teamId: team.id, id: { not: original.id } } });

    expect(copies, 'one copy was made').toHaveLength(1);
    expect(copies[0].internalVersion, 'the copy is not a V1 document, which could not keep the restrictions').not.toBe(
      1,
    );
  });
}

/** A legacy V1 document whose original upload is owner-restricted and whose current version is not. */
const seedV1DocumentWithProtectedOriginal = async (owner: ApiSeedContext['user'], teamId: number) => {
  const document = await seedV1Document(owner, teamId);
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });
  const original = await buildOwnerOnlyPdf('AES-256');
  const current = ordinaryPdf();

  expect(readEncryptionWithPdfinfo(original).encrypted, 'fixture precondition: original is protected').toBe(true);
  expect(readEncryptionWithPdfinfo(current).encrypted, 'fixture precondition: current is not').toBe(false);

  await prisma.documentData.update({
    where: { id: item.documentDataId },
    data: { initialData: original.toString('base64'), data: current.toString('base64') },
  });

  return document;
};

test('criterion_20_document_duplicate_refuses_a_v1_document_whose_original_upload_is_owner_restricted', async ({
  request,
}) => {
  const { token, user, team } = await apiCreateTestContext('copy-protected-original');
  const document = await seedV1DocumentWithProtectedOriginal(user, team.id);
  const since = new Date();
  const before = await snapshot(team.id, user.id, since);

  const res = await duplicate(request, token, 'document/duplicate', {
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
  });

  await expectRefused(res);
  expect(await snapshot(team.id, user.id, since), 'nothing was created').toEqual(before);
});

test('criterion_20_envelope_duplicate_never_yields_a_v1_copy_of_a_document_whose_original_is_owner_restricted', async ({
  request,
}) => {
  const { token, user, team } = await apiCreateTestContext('copy-envelope-protected-original');
  const document = await seedV1DocumentWithProtectedOriginal(user, team.id);
  const since = new Date();
  const before = await snapshot(team.id, user.id, since);

  const res = await duplicate(request, token, 'envelope/duplicate', { envelopeId: document.id });

  if (!res.ok()) {
    await expectRefused(res);
    expect(await snapshot(team.id, user.id, since), 'nothing was created').toEqual(before);

    return;
  }

  const copies = await prisma.envelope.findMany({ where: { teamId: team.id, id: { not: document.id } } });

  expect(copies, 'one copy was made').toHaveLength(1);
  expect(copies[0].internalVersion, 'the copy is not a V1 document, which could not keep the restrictions').not.toBe(1);
});
