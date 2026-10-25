/**
 * A V2 envelope refuses FREE_SIGNATURE fields, which nothing can sign there.
 *
 * Written from the specification alone, without reading the implementations of
 * the writers. Every refusal test has a control that sends the same request
 * with a SIGNATURE field and expects it to be accepted, so a refusal cannot be
 * a broken setup.
 *
 * | Test                                                                 | Criterion |
 * | -------------------------------------------------------------------- | --------- |
 * | C1 envelope/create DOCUMENT with a FREE_SIGNATURE field is refused    | C1        |
 * | C1 envelope/create TEMPLATE with a FREE_SIGNATURE field is refused    | C1        |
 * | C2 field/create-many with a FREE_SIGNATURE field saves nothing        | C2        |
 * | C2 field/create-many with SIGNATURE and FREE_SIGNATURE saves neither  | C2        |
 * | C3 field/update-many to FREE_SIGNATURE leaves the field unchanged     | C3        |
 * | C4 placeholder on envelope/create is refused and places no FREE_SIGNATURE field      | C4        |
 * | C4 placeholder on item/create-many is refused and places no FREE_SIGNATURE field     | C4        |
 * | C5 SIGNATURE is accepted through create, create-many and update-many  | C5        |
 * | C5 V1 document gets a FREE_SIGNATURE field through the V1 route       | C5        |
 * | C5 V1 document FREE_SIGNATURE field signs through the V1 route        | C5        |
 * | C6 V1 field routes refuse FREE_SIGNATURE on V2, accept SIGNATURE      | C6        |
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument, seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { PDF, StandardFonts } from '@libpdf/core';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FieldType, Prisma } from '@prisma/client';

import {
  apiCreateEnvelope,
  apiCreateFields,
  apiCreateRecipients,
  apiCreateTestContext,
} from '../../fixtures/api-seeds';
import { apiSignin } from '../../fixtures/authentication';

// Files run one test at a time (one worker), because the leftover tests count rows across the whole table.

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const API = `${BASE}/api/v2-beta`;

const json = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com`;

const uniqueTitle = (label: string) => `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const coordinates = { page: 1, positionX: 10, positionY: 20, width: 15, height: 5 };

const fieldCount = async (envelopeId: string, type?: FieldType) =>
  await prisma.field.count({ where: { envelopeId, ...(type ? { type } : {}) } });

const seedV2Draft = async (request: APIRequestContext) => {
  const { user, team, token } = await apiCreateTestContext('v2-free-signature');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: uniqueTitle('V2 draft') });
  const recipients = await apiCreateRecipients(request, token, envelopeId, [{ email: uniqueEmail('signer') }]);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

  expect(envelope.internalVersion, 'precondition: an API v2 envelope is a V2 envelope').toBe(2);

  return { user, team, token, envelopeId, recipientId: recipients.data[0].id, secondaryId: envelope.secondaryId };
};

/** Posts envelope/create with one recipient holding one field of the given type. */
const createWithField = async (
  request: APIRequestContext,
  token: string,
  type: 'DOCUMENT' | 'TEMPLATE',
  title: string,
  fieldType: FieldType,
) => {
  const formData = new FormData();

  formData.append(
    'payload',
    JSON.stringify({
      title,
      type,
      recipients: [
        {
          email: uniqueEmail('create'),
          name: 'Create Signer',
          role: 'SIGNER',
          fields: [{ type: fieldType, ...coordinates }],
        },
      ],
    }),
  );
  formData.append('files', new File([await examplePdf()], 'example.pdf', { type: 'application/pdf' }));

  return await request.post(`${API}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

const examplePdf = async () => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: 'letter' });

  page.drawText('Agreement', { x: 50, y: 700, font: StandardFonts.Helvetica, size: 12 });

  return Buffer.from(await pdf.save());
};

const placeholderPdf = async (placeholder: string) => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: 'letter' });

  page.drawText(placeholder, { x: 50, y: 700, font: StandardFonts.Helvetica, size: 12 });

  return Buffer.from(await pdf.save());
};

const envelopesTitled = async (teamId: number, title: string) =>
  await prisma.envelope.count({ where: { teamId, title } });

for (const type of ['DOCUMENT', 'TEMPLATE'] as const) {
  test(`C1 envelope/create ${type} with a FREE_SIGNATURE field is refused and creates no envelope`, async ({
    request,
  }) => {
    const { team, token } = await apiCreateTestContext('v2-free-signature-c1');
    const title = uniqueTitle(`C1 ${type}`);

    const refused = await createWithField(request, token, type, title, FieldType.FREE_SIGNATURE);
    const body = await refused.text();

    expect(refused.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
    expect(refused.status(), body).toBeLessThan(500);
    expect(body, 'the refusal names the unsupported type').toContain('FREE_SIGNATURE');
    expect(await envelopesTitled(team.id, title), 'no envelope is created').toBe(0);

    const controlTitle = uniqueTitle(`C1 control ${type}`);
    const control = await createWithField(request, token, type, controlTitle, FieldType.SIGNATURE);

    expect(
      control.ok(),
      `control: the same request with a SIGNATURE field is accepted: ${await control.text()}`,
    ).toBeTruthy();
    expect(await envelopesTitled(team.id, controlTitle)).toBe(1);
  });
}

test('C2 field/create-many with a FREE_SIGNATURE field is refused and saves nothing', async ({ request }) => {
  const { token, envelopeId, recipientId } = await seedV2Draft(request);

  const refused = await request.post(`${API}/envelope/field/create-many`, {
    headers: json(token),
    data: { envelopeId, data: [{ recipientId, type: FieldType.FREE_SIGNATURE, ...coordinates }] },
  });
  const body = await refused.text();

  expect(refused.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
  expect(refused.status(), body).toBeLessThan(500);
  expect(await fieldCount(envelopeId), 'no field is created').toBe(0);

  const control = await request.post(`${API}/envelope/field/create-many`, {
    headers: json(token),
    data: { envelopeId, data: [{ recipientId, type: FieldType.SIGNATURE, ...coordinates }] },
  });

  expect(control.ok(), `control: a SIGNATURE field alone saves: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId)).toBe(1);
});

test('C2 field/create-many with SIGNATURE and FREE_SIGNATURE saves neither', async ({ request }) => {
  const { token, envelopeId, recipientId } = await seedV2Draft(request);

  const refused = await request.post(`${API}/envelope/field/create-many`, {
    headers: json(token),
    data: {
      envelopeId,
      data: [
        { recipientId, type: FieldType.SIGNATURE, ...coordinates },
        { recipientId, type: FieldType.FREE_SIGNATURE, ...coordinates, positionY: 40 },
      ],
    },
  });
  const body = await refused.text();

  expect(refused.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
  expect(refused.status(), body).toBeLessThan(500);
  expect(await fieldCount(envelopeId), 'neither the SIGNATURE nor the FREE_SIGNATURE field is created').toBe(0);

  const control = await request.post(`${API}/envelope/field/create-many`, {
    headers: json(token),
    data: { envelopeId, data: [{ recipientId, type: FieldType.SIGNATURE, ...coordinates }] },
  });

  expect(control.ok(), `control: the SIGNATURE field alone saves: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId)).toBe(1);
});

test('C3 field/update-many changing a field to FREE_SIGNATURE is refused and leaves the field unchanged', async ({
  request,
}) => {
  const { token, envelopeId, recipientId } = await seedV2Draft(request);

  await apiCreateFields(request, token, envelopeId, [{ recipientId, type: FieldType.SIGNATURE, ...coordinates }]);

  // Clear the stored meta so a refusal cannot come from a meta-type mismatch, which would hide the type change.
  await prisma.field.updateMany({ where: { envelopeId }, data: { fieldMeta: Prisma.DbNull } });

  const before = await prisma.field.findFirstOrThrow({ where: { envelopeId } });

  expect(before.type).toBe(FieldType.SIGNATURE);

  const refused = await request.post(`${API}/envelope/field/update-many`, {
    headers: json(token),
    data: { envelopeId, data: [{ id: before.id, type: FieldType.FREE_SIGNATURE }] },
  });
  const body = await refused.text();

  expect(refused.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
  expect(refused.status(), body).toBeLessThan(500);

  const after = await prisma.field.findUniqueOrThrow({ where: { id: before.id } });

  expect(after.type, 'the field type is unchanged').toBe(FieldType.SIGNATURE);

  const control = await request.post(`${API}/envelope/field/update-many`, {
    headers: json(token),
    data: { envelopeId, data: [{ id: before.id, type: FieldType.INITIALS }] },
  });

  expect(control.ok(), `control: a change to another type is accepted: ${await control.text()}`).toBeTruthy();
  expect((await prisma.field.findUniqueOrThrow({ where: { id: before.id } })).type).toBe(FieldType.INITIALS);
});

test('C4 a FREE_SIGNATURE placeholder on envelope/create is refused and places no FREE_SIGNATURE field', async ({
  request,
}) => {
  const { team, token } = await apiCreateTestContext('v2-free-signature-c4a');

  const create = async (placeholder: string, title: string) => {
    const formData = new FormData();

    formData.append('payload', JSON.stringify({ type: 'DOCUMENT', title }));
    formData.append(
      'files',
      new File([await placeholderPdf(placeholder)], 'placeholder.pdf', { type: 'application/pdf' }),
    );

    return await request.post(`${API}/envelope/create`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: formData,
    });
  };

  const controlTitle = uniqueTitle('C4 control');
  const control = await create('{{SIGNATURE, r1}}', controlTitle);

  expect(control.ok(), `control: a SIGNATURE placeholder is accepted: ${await control.text()}`).toBeTruthy();

  const controlEnvelope = await prisma.envelope.findFirstOrThrow({ where: { teamId: team.id, title: controlTitle } });

  expect(
    await fieldCount(controlEnvelope.id, FieldType.SIGNATURE),
    'control: the SIGNATURE placeholder is placed as a SIGNATURE field, so placement works in this setup',
  ).toBe(1);

  const title = uniqueTitle('C4 free signature');
  const res = await create('{{FREE_SIGNATURE, r1}}', title);
  const body = await res.text();
  const created = await prisma.envelope.findFirst({ where: { teamId: team.id, title } });

  expect(res.status(), `the upload is refused with 400: ${body}`).toBe(400);
  expect(created, 'a refused creation leaves no envelope behind').toBeNull();
});

test('C4 a FREE_SIGNATURE placeholder on item/create-many is refused and places no FREE_SIGNATURE field', async ({
  request,
}) => {
  const { token, envelopeId } = await seedV2Draft(request);

  const addItem = async (placeholder: string) => {
    const formData = new FormData();

    formData.append('payload', JSON.stringify({ envelopeId }));
    formData.append(
      'files',
      new File([await placeholderPdf(placeholder)], 'placeholder.pdf', { type: 'application/pdf' }),
    );

    return await request.post(`${API}/envelope/item/create-many`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: formData,
    });
  };

  const control = await addItem('{{SIGNATURE, r1}}');

  expect(control.ok(), `control: a SIGNATURE placeholder upload is accepted: ${await control.text()}`).toBeTruthy();
  expect(
    await fieldCount(envelopeId, FieldType.SIGNATURE),
    'control: the SIGNATURE placeholder is placed as a SIGNATURE field, so placement works in this setup',
  ).toBe(1);

  const itemsBefore = await prisma.envelopeItem.count({ where: { envelopeId } });
  const res = await addItem('{{FREE_SIGNATURE, r1}}');
  const body = await res.text();

  expect(res.status(), `the upload is refused with 400: ${body}`).toBe(400);
  expect(await prisma.envelopeItem.count({ where: { envelopeId } }), 'a refused upload adds no item').toBe(itemsBefore);
  expect(await fieldCount(envelopeId, FieldType.FREE_SIGNATURE), 'no FREE_SIGNATURE field exists').toBe(0);
});

test('C5 SIGNATURE fields are accepted through create, create-many and update-many', async ({ request }) => {
  const { team, token } = await apiCreateTestContext('v2-free-signature-c5');

  for (const type of ['DOCUMENT', 'TEMPLATE'] as const) {
    const title = uniqueTitle(`C5 ${type}`);
    const res = await createWithField(request, token, type, title, FieldType.SIGNATURE);

    expect(res.ok(), `envelope/create ${type}: ${await res.text()}`).toBeTruthy();

    const created = await prisma.envelope.findFirstOrThrow({ where: { teamId: team.id, title } });

    expect(await fieldCount(created.id, FieldType.SIGNATURE)).toBe(1);
  }

  const seeded = await seedV2Draft(request);
  const created = await request.post(`${API}/envelope/field/create-many`, {
    headers: json(seeded.token),
    data: {
      envelopeId: seeded.envelopeId,
      data: [{ recipientId: seeded.recipientId, type: FieldType.SIGNATURE, ...coordinates }],
    },
  });

  expect(created.ok(), `field/create-many: ${await created.text()}`).toBeTruthy();

  const field = await prisma.field.findFirstOrThrow({ where: { envelopeId: seeded.envelopeId } });
  const updated = await request.post(`${API}/envelope/field/update-many`, {
    headers: json(seeded.token),
    data: { envelopeId: seeded.envelopeId, data: [{ id: field.id, type: FieldType.SIGNATURE, positionX: 30 }] },
  });

  expect(updated.ok(), `field/update-many: ${await updated.text()}`).toBeTruthy();
  expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).type).toBe(FieldType.SIGNATURE);
});

test('C5 a V1 document gets a FREE_SIGNATURE field through the V1 field route', async ({ request }) => {
  const { user, team, token } = await apiCreateTestContext('v2-free-signature-c5-v1-create');
  const recipientEmail = uniqueEmail('v1-recipient');
  const document = await seedDraftDocument(user, team.id, [recipientEmail], { internalVersion: 1 });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  expect(document.internalVersion, 'precondition: a V1 document').toBe(1);

  const res = await request.post(`${API}/document/field/create-many`, {
    headers: json(token),
    data: {
      documentId: mapSecondaryIdToDocumentId(document.secondaryId),
      fields: [
        {
          recipientId: recipient.id,
          type: FieldType.FREE_SIGNATURE,
          pageNumber: 1,
          pageX: 10,
          pageY: 20,
          width: 15,
          height: 5,
        },
      ],
    },
  });

  expect(res.ok(), `V1 document/field/create-many: ${await res.text()}`).toBeTruthy();
  expect(await fieldCount(document.id, FieldType.FREE_SIGNATURE)).toBe(1);
});

test('C5 a V1 document FREE_SIGNATURE field signs through the V1 route', async ({ request }) => {
  const { user, team } = await apiCreateTestContext('v2-free-signature-c5-v1-sign');
  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [uniqueEmail('v1-signer')],
    fields: [FieldType.FREE_SIGNATURE],
    updateDocumentOptions: { internalVersion: 1 },
  });
  const [recipient] = recipients;
  const field = recipient.fields.find((candidate) => candidate.type === FieldType.FREE_SIGNATURE);

  expect(field, 'precondition: the seeded document holds a FREE_SIGNATURE field').toBeDefined();

  const res = await request.post(`${BASE}/api/trpc/field.signFieldWithToken`, {
    headers: { 'content-type': 'application/json', origin: new URL(BASE).origin },
    data: JSON.stringify({
      json: { token: recipient.token, fieldId: field!.id, value: 'Free Signature', isBase64: false },
    }),
  });

  expect(res.ok(), `V1 field.signFieldWithToken: ${await res.text()}`).toBeTruthy();
  expect((await prisma.field.findUniqueOrThrow({ where: { id: field!.id } })).inserted).toBe(true);
});

test('C6 V1 field routes refuse a FREE_SIGNATURE field on a V2 envelope and still accept SIGNATURE', async ({
  request,
}) => {
  const { token, envelopeId, recipientId, secondaryId } = await seedV2Draft(request);
  const documentId = mapSecondaryIdToDocumentId(secondaryId);
  const fieldOf = (type: FieldType) => ({
    recipientId,
    type,
    pageNumber: 1,
    pageX: 10,
    pageY: 20,
    width: 15,
    height: 5,
  });

  const refusedMany = await request.post(`${API}/document/field/create-many`, {
    headers: json(token),
    data: { documentId, fields: [fieldOf(FieldType.FREE_SIGNATURE)] },
  });
  const manyBody = await refusedMany.text();

  expect(refusedMany.status(), `V1 create-many should be refused with a 4xx: ${manyBody}`).toBeGreaterThanOrEqual(400);
  expect(refusedMany.status(), manyBody).toBeLessThan(500);

  const refusedSingle = await request.post(`${API}/document/field/create`, {
    headers: json(token),
    data: { documentId, field: fieldOf(FieldType.FREE_SIGNATURE) },
  });
  const singleBody = await refusedSingle.text();

  expect(refusedSingle.status(), `V1 create should be refused with a 4xx: ${singleBody}`).toBeGreaterThanOrEqual(400);
  expect(refusedSingle.status(), singleBody).toBeLessThan(500);
  expect(await fieldCount(envelopeId), 'nothing was written').toBe(0);

  const control = await request.post(`${API}/document/field/create-many`, {
    headers: json(token),
    data: { documentId, fields: [fieldOf(FieldType.SIGNATURE)] },
  });

  expect(control.ok(), `control: a SIGNATURE field is accepted: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId, FieldType.SIGNATURE)).toBe(1);
});

// ---------------------------------------------------------------------------
// Leftovers: a refused request leaves no DocumentData or DocumentMeta row behind.
// ---------------------------------------------------------------------------

const rowCounts = async () => ({
  documentData: await prisma.documentData.count(),
  documentMeta: await prisma.documentMeta.count(),
});

const FREE_SIGNATURE_PLACEHOLDER = '{{FREE_SIGNATURE, r1}}';

const expectRefusedWithoutLeftovers = async (
  before: Awaited<ReturnType<typeof rowCounts>>,
  res: { status(): number; text(): Promise<string> },
) => {
  const body = await res.text();

  expect(res.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
  expect(res.status(), body).toBeLessThan(500);
  expect(await rowCounts(), 'no DocumentData or DocumentMeta row is left behind').toEqual(before);
};

const postCreate = async (request: APIRequestContext, token: string, payload: Record<string, unknown>, pdf: Buffer) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify(payload));
  formData.append('files', new File([pdf], 'upload.pdf', { type: 'application/pdf' }));

  return await request.post(`${API}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

const postItems = async (request: APIRequestContext, token: string, envelopeId: string, pdfs: Buffer[]) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId }));
  pdfs.forEach((pdf, index) =>
    formData.append('files', new File([pdf], `upload-${index}.pdf`, { type: 'application/pdf' })),
  );

  return await request.post(`${API}/envelope/item/create-many`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

test('L1 envelope/create with a FREE_SIGNATURE recipient field leaves no rows behind', async ({ request }) => {
  const { token } = await apiCreateTestContext('v2-free-signature-l1');
  const payload = {
    title: uniqueTitle('L1'),
    type: 'DOCUMENT',
    recipients: [
      {
        email: uniqueEmail('l1'),
        name: 'L1',
        role: 'SIGNER',
        fields: [{ type: FieldType.FREE_SIGNATURE, ...coordinates }],
      },
    ],
  };
  const before = await rowCounts();

  await expectRefusedWithoutLeftovers(before, await postCreate(request, token, payload, await examplePdf()));
});

test('L1 envelope/create with a FREE_SIGNATURE placeholder PDF leaves no rows behind', async ({ request }) => {
  const { token } = await apiCreateTestContext('v2-free-signature-l1p');
  const pdf = await placeholderPdf(FREE_SIGNATURE_PLACEHOLDER);
  const before = await rowCounts();

  await expectRefusedWithoutLeftovers(
    before,
    await postCreate(request, token, { title: uniqueTitle('L1p'), type: 'DOCUMENT' }, pdf),
  );
});

test('L2 item/create-many with a FREE_SIGNATURE placeholder PDF leaves no rows behind', async ({ request }) => {
  const { token, envelopeId } = await seedV2Draft(request);
  const itemsBefore = await prisma.envelopeItem.count({ where: { envelopeId } });
  const before = await rowCounts();

  await expectRefusedWithoutLeftovers(
    before,
    await postItems(request, token, envelopeId, [await placeholderPdf(FREE_SIGNATURE_PLACEHOLDER)]),
  );
  expect(await prisma.envelopeItem.count({ where: { envelopeId } }), 'no item is added').toBe(itemsBefore);

  const control = await postItems(request, token, envelopeId, [await placeholderPdf('{{SIGNATURE, r1}}')]);

  expect(control.ok(), `control: a SIGNATURE placeholder upload is accepted: ${await control.text()}`).toBeTruthy();
});

test('L2 item/create-many with one clean PDF and one FREE_SIGNATURE placeholder PDF leaves no rows behind', async ({
  request,
}) => {
  const { token, envelopeId } = await seedV2Draft(request);
  const itemsBefore = await prisma.envelopeItem.count({ where: { envelopeId } });
  const before = await rowCounts();

  await expectRefusedWithoutLeftovers(
    before,
    await postItems(request, token, envelopeId, [await examplePdf(), await placeholderPdf(FREE_SIGNATURE_PLACEHOLDER)]),
  );
  expect(await prisma.envelopeItem.count({ where: { envelopeId } }), 'neither upload is added').toBe(itemsBefore);

  const control = await postItems(request, token, envelopeId, [
    await examplePdf(),
    await placeholderPdf('{{SIGNATURE, r1}}'),
  ]);

  expect(
    control.ok(),
    `control: the same pair with a SIGNATURE placeholder is accepted: ${await control.text()}`,
  ).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Session-only routes: PDF replacement, envelope.set, field.setFieldsForDocument and setFieldsForTemplate.
// ---------------------------------------------------------------------------

const trpcPost = async (page: Page, teamId: number, procedure: string, input: Record<string, unknown>) =>
  await page.request.post(`${BASE}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json', origin: new URL(BASE).origin, 'x-team-id': String(teamId) },
    data: JSON.stringify({ json: input }),
  });

const replacePdfRequest = async (
  page: Page,
  teamId: number,
  envelopeId: string,
  envelopeItemId: string,
  pdf: Buffer,
) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId, envelopeItemId }));
  formData.append('file', new File([pdf], 'replacement.pdf', { type: 'application/pdf' }));

  return await page.request.post(`${BASE}/api/trpc/envelope.item.replacePdf`, {
    headers: { 'x-team-id': String(teamId) },
    multipart: formData,
  });
};

test('L3 replacing a V2 draft item with a FREE_SIGNATURE placeholder PDF is refused and changes nothing', async ({
  page,
  request,
}) => {
  const { user, team, token, envelopeId, recipientId } = await seedV2Draft(request);

  await apiCreateFields(request, token, envelopeId, [{ recipientId, type: FieldType.SIGNATURE, ...coordinates }]);
  await apiSignin({ page, email: user.email });

  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });
  const fieldsBefore = await prisma.field.findMany({ where: { envelopeId }, orderBy: { id: 'asc' } });
  const before = await rowCounts();

  const refused = await replacePdfRequest(
    page,
    team.id,
    envelopeId,
    item.id,
    await placeholderPdf(FREE_SIGNATURE_PLACEHOLDER),
  );

  await expectRefusedWithoutLeftovers(before, refused);

  const after = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: item.id } });

  expect(after.documentDataId, 'the item still points at its original documentData').toBe(item.documentDataId);
  expect(await prisma.field.findMany({ where: { envelopeId }, orderBy: { id: 'asc' } }), 'its fields are kept').toEqual(
    fieldsBefore,
  );

  const signatureFieldIds = async () =>
    (await prisma.field.findMany({ where: { envelopeId, recipientId, type: FieldType.SIGNATURE } })).map(
      (field) => field.id,
    );
  const idsBeforeControl = await signatureFieldIds();

  const control = await replacePdfRequest(
    page,
    team.id,
    envelopeId,
    item.id,
    await placeholderPdf('{{SIGNATURE, r1}}'),
  );

  expect(
    control.ok(),
    `control: replacing with a SIGNATURE placeholder PDF is accepted: ${await control.text()}`,
  ).toBeTruthy();
  expect(
    (await signatureFieldIds()).filter((id) => !idsBeforeControl.includes(id)).length,
    'control: the SIGNATURE placeholder is placed as a new SIGNATURE field for r1',
  ).toBeGreaterThanOrEqual(1);
});

const setFieldPayload = (recipientId: number, envelopeItemId: string, type: FieldType) => ({
  type,
  recipientId,
  envelopeItemId,
  pageNumber: 1,
  pageX: 10,
  pageY: 20,
  pageWidth: 15,
  pageHeight: 5,
});

test('B1 field.setFieldsForDocument on a V2 draft refuses FREE_SIGNATURE and accepts SIGNATURE', async ({
  page,
  request,
}) => {
  const { user, team, envelopeId, recipientId, secondaryId } = await seedV2Draft(request);
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });
  const documentId = mapSecondaryIdToDocumentId(secondaryId);

  await apiSignin({ page, email: user.email });

  const refused = await trpcPost(page, team.id, 'field.setFieldsForDocument', {
    documentId,
    fields: [setFieldPayload(recipientId, item.id, FieldType.FREE_SIGNATURE)],
  });
  const body = await refused.text();

  expect(refused.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
  expect(refused.status(), body).toBeLessThan(500);
  expect(await fieldCount(envelopeId), 'nothing was written').toBe(0);

  const control = await trpcPost(page, team.id, 'field.setFieldsForDocument', {
    documentId,
    fields: [setFieldPayload(recipientId, item.id, FieldType.SIGNATURE)],
  });

  expect(control.ok(), `control: a SIGNATURE field is accepted: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId, FieldType.SIGNATURE)).toBe(1);
});

const seedV2Template = async (request: APIRequestContext) => {
  const { user, team, token } = await apiCreateTestContext('v2-free-signature-template');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, {
    title: uniqueTitle('V2 template'),
    type: 'TEMPLATE',
  });
  const recipients = await apiCreateRecipients(request, token, envelopeId, [{ email: uniqueEmail('tpl') }]);
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

  expect(envelope.internalVersion, 'precondition: an API v2 template is a V2 envelope').toBe(2);

  return { user, team, envelopeId, recipientId: recipients.data[0].id, secondaryId: envelope.secondaryId };
};

test('B2 field.setFieldsForTemplate on a V2 template refuses FREE_SIGNATURE and accepts SIGNATURE', async ({
  page,
  request,
}) => {
  const { user, team, envelopeId, recipientId, secondaryId } = await seedV2Template(request);
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });
  const templateId = mapSecondaryIdToTemplateId(secondaryId);

  await apiSignin({ page, email: user.email });

  const refused = await trpcPost(page, team.id, 'field.setFieldsForTemplate', {
    templateId,
    fields: [setFieldPayload(recipientId, item.id, FieldType.FREE_SIGNATURE)],
  });
  const body = await refused.text();

  expect(refused.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
  expect(refused.status(), body).toBeLessThan(500);
  expect(await fieldCount(envelopeId), 'nothing was written').toBe(0);

  const control = await trpcPost(page, team.id, 'field.setFieldsForTemplate', {
    templateId,
    fields: [setFieldPayload(recipientId, item.id, FieldType.SIGNATURE)],
  });

  expect(control.ok(), `control: a SIGNATURE field is accepted: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId, FieldType.SIGNATURE)).toBe(1);
});

for (const envelopeType of ['DOCUMENT', 'TEMPLATE'] as const) {
  test(`B3 envelope.field.set on a V2 ${envelopeType} refuses FREE_SIGNATURE and accepts SIGNATURE`, async ({
    page,
    request,
  }) => {
    const { user, team, envelopeId, recipientId } =
      envelopeType === 'DOCUMENT' ? await seedV2Draft(request) : await seedV2Template(request);
    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });
    const fieldOf = (type: FieldType) => ({
      type,
      recipientId,
      envelopeItemId: item.id,
      page: 1,
      positionX: 10,
      positionY: 20,
      width: 15,
      height: 5,
    });

    await apiSignin({ page, email: user.email });

    const refused = await trpcPost(page, team.id, 'envelope.field.set', {
      envelopeId,
      envelopeType,
      fields: [fieldOf(FieldType.FREE_SIGNATURE)],
    });
    const body = await refused.text();

    expect(refused.status(), `should be refused with a 4xx: ${body}`).toBeGreaterThanOrEqual(400);
    expect(refused.status(), body).toBeLessThan(500);
    expect(await fieldCount(envelopeId), 'nothing was written').toBe(0);

    const control = await trpcPost(page, team.id, 'envelope.field.set', {
      envelopeId,
      envelopeType,
      fields: [fieldOf(FieldType.SIGNATURE)],
    });

    expect(control.ok(), `control: a SIGNATURE field is accepted: ${await control.text()}`).toBeTruthy();
    expect(await fieldCount(envelopeId, FieldType.SIGNATURE)).toBe(1);
  });
}
