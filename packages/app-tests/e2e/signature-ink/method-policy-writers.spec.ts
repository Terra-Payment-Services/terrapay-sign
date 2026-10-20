/**
 * Signature-method settings writers refuse a policy with no method enabled.
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * sections 1.4, 4.0 and 4.2) before any fix, without reading the writers.
 * Every writer is driven through the route an API caller or the app uses: API
 * v2 (bearer token) for the envelope, document and template routes, API v1 for
 * its own creates, and session tRPC for team and organisation settings (the
 * session is seeded through Prisma, see fixtures/signature-ink.ts). Templates,
 * envelopes and settings rows are seeded through Prisma.
 *
 * "Refused" is 400 (tRPC and REST v2: data.code INVALID_REQUEST; API v1: its
 * 400 body, a JSON object with a message, and the code recorded) with nothing created and
 * every stored flag unchanged; "accepted" is 2xx with the stored flags equal to
 * the merged input (spec 4.0).
 *
 * | Criterion | Test                                                                                   |
 * | --------- | -------------------------------------------------------------------------------------- |
 * | C25       | C25 <writer>: creating with all three methods off is refused; one method on succeeds (one test per writer) |
 * | C26       | C26 <writer>: an update whose merged result has no method is refused, flags unchanged; a control update succeeds |
 * | C27       | C27 team settings refuse a merged team-over-organisation result with no method      |
 * | C27       | C27 organisation settings keep refusing (regression)                                |
 *
 * Mind the file upload limit (20 a minute): the multipart creates here make
 * eight uploads in the whole file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { keepRecord, type Reply, send } from '../fixtures/reject-seal';
import {
  API_V1,
  API_V2,
  createG4Owner,
  describeReply,
  errorOf,
  type G4Owner,
  type G4Seeded,
  seedG4Envelope,
  seedSessionCookie,
  trpcAsUser,
  uniqueStamp,
  v2Api,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

type Flags = { typedSignatureEnabled: boolean; drawSignatureEnabled: boolean; uploadSignatureEnabled: boolean };

const ALL_OFF: Flags = { typedSignatureEnabled: false, drawSignatureEnabled: false, uploadSignatureEnabled: false };
const TYPED_ONLY: Flags = { typedSignatureEnabled: true, drawSignatureEnabled: false, uploadSignatureEnabled: false };
const ALL_ON: Flags = { typedSignatureEnabled: true, drawSignatureEnabled: true, uploadSignatureEnabled: true };

const UPLOAD_TRANSPORT = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT;

const EXAMPLE_PDF = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const flagsOf = (meta: Flags) => ({
  typedSignatureEnabled: meta.typedSignatureEnabled,
  drawSignatureEnabled: meta.drawSignatureEnabled,
  uploadSignatureEnabled: meta.uploadSignatureEnabled,
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The refusal body: data.code INVALID_REQUEST on tRPC and REST v2 (spec 4.0,
 * section 3 rule 6); on API v1 the API's own 400 body, a JSON object with a message.
 */
const expectRefusalBody = (reply: Reply, writerName: string, what: string) => {
  if (writerName.startsWith('API v1')) {
    let body: unknown = null;

    try {
      body = JSON.parse(reply.body);
    } catch {
      body = null;
    }

    expect
      .soft(typeof (body as { message?: unknown } | null)?.message, `${what}: API v1 400 body carries a message`)
      .toBe('string');

    return;
  }

  expect
    .soft(errorOf(reply).code, `${what}: data.code INVALID_REQUEST (${describeReply(reply)})`)
    .toBe('INVALID_REQUEST');
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const v2Multipart = async (
  request: APIRequestContext,
  token: string,
  apiPath: string,
  payload: Record<string, unknown>,
  fileField: 'file' | 'files' | null,
) =>
  await send(
    async () => {
      const form = new FormData();

      form.append('payload', JSON.stringify(payload));

      if (fileField) {
        form.append(fileField, new File([EXAMPLE_PDF], 'example.pdf', { type: 'application/pdf' }));
      }

      return await request.post(`${API_V2}${apiPath}`, { headers: bearer(token), multipart: form });
    },
    `API v2 ${apiPath}`,
    true,
  );

const v1Post = async (request: APIRequestContext, token: string, apiPath: string, data: Record<string, unknown>) =>
  await send(
    async () =>
      await request.post(`${API_V1}${apiPath}`, {
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        data,
      }),
    `API v1 ${apiPath}`,
    true,
  );

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

const teamEnvelopes = async (teamId: number) =>
  await prisma.envelope.findMany({
    where: { teamId },
    include: { documentMeta: true },
    orderBy: { createdAt: 'asc' },
  });

/** A template with one SIGNER, all three methods on, for the use-template writers. */
const seedTemplate = async (owner: G4Owner, internalVersion: 1 | 2) => {
  const template = await seedG4Envelope({
    internalVersion,
    owner,
    type: EnvelopeType.TEMPLATE,
    status: DocumentStatus.DRAFT,
    ...ALL_ON,
    recipients: [{ key: 't', signingOrder: 1, fields: [] }],
  });

  return template;
};

const recipientsFor = (template: G4Seeded) => [
  { id: template.r.t.id, email: `g4-use-${uniqueStamp()}@test.documenso.com`, name: 'Use Signer' },
];

// ---------------------------------------------------------------------------
// C25: create writers
// ---------------------------------------------------------------------------

type CreateWriter = {
  name: string;
  /** Answers only under the S3 upload transport (a presigned upload URL); CI runs the database transport. */
  s3Only?: true;
  /** Sends the create with `flags` (and a unique title) and returns the reply. */
  create: (request: APIRequestContext, owner: G4Owner, flags: Flags, title: string) => Promise<Reply>;
};

const CREATE_WRITERS: CreateWriter[] = [
  {
    name: 'envelope.create (API v2 /envelope/create)',
    create: async (request, owner, flags, title) =>
      await v2Multipart(request, owner.apiToken, '/envelope/create', { title, type: 'DOCUMENT', meta: flags }, 'files'),
  },
  {
    name: 'document.create (API v2 /document/create)',
    create: async (request, owner, flags, title) =>
      await v2Multipart(request, owner.apiToken, '/document/create', { title, meta: flags }, 'file'),
  },
  {
    name: 'document.createTemporary (API v2 /document/create/beta)',
    s3Only: true,
    create: async (request, owner, flags, title) =>
      await v2Api(request, owner.apiToken, '/document/create/beta', { title, meta: flags }),
  },
  {
    name: 'template.createTemplate (API v2 /template/create)',
    create: async (request, owner, flags, title) =>
      await v2Multipart(request, owner.apiToken, '/template/create', { title, meta: flags }, 'file'),
  },
  {
    name: 'template.createTemplateTemporary (API v2 /template/create/beta)',
    s3Only: true,
    create: async (request, owner, flags, title) =>
      await v2Api(request, owner.apiToken, '/template/create/beta', { title, meta: flags }),
  },
  {
    name: 'API v1 POST /api/v1/documents',
    s3Only: true,
    create: async (request, owner, flags, title) =>
      await v1Post(request, owner.apiToken, '/documents', { title, recipients: [], meta: flags }),
  },
  {
    name: 'API v1 POST /api/v1/templates',
    s3Only: true,
    create: async (request, owner, flags, title) =>
      await v1Post(request, owner.apiToken, '/templates', { title, meta: flags }),
  },
  {
    name: 'envelope.use with an override (API v2 /envelope/use)',
    create: async (request, owner, flags, title) => {
      const template = await seedTemplate(owner, 2);

      return await v2Multipart(
        request,
        owner.apiToken,
        '/envelope/use',
        { envelopeId: template.envelopeId, recipients: recipientsFor(template), override: { title, ...flags } },
        null,
      );
    },
  },
  {
    name: 'template.createDocumentFromTemplate with an override (API v2 /template/use)',
    create: async (request, owner, flags, title) => {
      const template = await seedTemplate(owner, 1);

      return await v2Api(request, owner.apiToken, '/template/use', {
        templateId: template.documentId,
        recipients: recipientsFor(template),
        override: { title, ...flags },
      });
    },
  },
  {
    name: 'API v1 generate-document from a template with an override',
    create: async (request, owner, flags, title) => {
      const template = await seedTemplate(owner, 1);

      return await v1Post(request, owner.apiToken, `/templates/${template.documentId}/generate-document`, {
        title,
        recipients: recipientsFor(template),
        meta: flags,
      });
    },
  },
];

for (const writer of CREATE_WRITERS) {
  test(`C25 ${writer.name}: creating with all three methods off is refused; one method on succeeds`, async ({
    request,
  }) => {
    // As protected-pdf-two-step.spec.ts: these writers refuse every create without S3, whatever the flags.
    test.skip(
      writer.s3Only === true && UPLOAD_TRANSPORT !== 's3',
      `${writer.name} exists only under the S3 upload transport; NEXT_PUBLIC_UPLOAD_TRANSPORT is ${JSON.stringify(UPLOAD_TRANSPORT ?? null)}.`,
    );

    const owner = await createG4Owner();

    // Refused: 400, and no envelope with this title (or any new non-template envelope) is written.
    const refusedTitle = `G4 C25 off ${uniqueStamp()}`;
    const before = await teamEnvelopes(owner.team.id);
    const refused = await writer.create(request, owner, ALL_OFF, refusedTitle);
    const afterRefusal = await teamEnvelopes(owner.team.id);
    const createdByRefused = afterRefusal.filter((row) => !before.some((old) => old.id === row.id));
    const seededTemplates = createdByRefused.filter(
      (row) => row.type === EnvelopeType.TEMPLATE && row.title !== refusedTitle,
    );
    const written = createdByRefused.filter((row) => !seededTemplates.includes(row));

    // Accepted control: one method on, same writer, same payload otherwise.
    const acceptedTitle = `G4 C25 typed ${uniqueStamp()}`;
    const accepted = await writer.create(request, owner, TYPED_ONLY, acceptedTitle);
    const afterAccepted = await teamEnvelopes(owner.team.id);
    const createdByAccepted = afterAccepted.filter(
      (row) => !afterRefusal.some((old) => old.id === row.id) && row.title === acceptedTitle,
    );

    await keepRecord('C25.json', {
      writer: writer.name,
      refused: { status: refused.status, body: refused.body.slice(0, 400), written: written.map((row) => row.id) },
      accepted: {
        status: accepted.status,
        body: accepted.body.slice(0, 400),
        created: createdByAccepted.map((row) => ({ id: row.id, flags: row.documentMeta && flagsOf(row.documentMeta) })),
      },
    });

    // Premise: the writer works with a valid policy, so a refusal is about the flags.
    expect(accepted.status, `control, one method on: ${describeReply(accepted)}`).toBeGreaterThanOrEqual(200);
    expect(accepted.status, `control, one method on: ${describeReply(accepted)}`).toBeLessThan(300);
    expect(createdByAccepted, 'control: exactly one envelope created with the title').toHaveLength(1);
    expect(flagsOf(createdByAccepted[0].documentMeta), 'control: stored flags equal the input').toEqual(TYPED_ONLY);

    expect.soft(refused.status, `all three off is refused with 400: ${describeReply(refused)}`).toBe(400);
    expectRefusalBody(refused, writer.name, 'all three off');
    expect
      .soft(
        written.map((row) => ({ title: row.title, flags: flagsOf(row.documentMeta) })),
        'all three off: nothing created',
      )
      .toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// C26: update writers
// ---------------------------------------------------------------------------

type UpdateWriter = {
  name: string;
  seed: (owner: G4Owner, flags: Flags) => Promise<G4Seeded>;
  update: (request: APIRequestContext, owner: G4Owner, seeded: G4Seeded, meta: Partial<Flags>) => Promise<Reply>;
};

const seedForUpdate = async (
  owner: G4Owner,
  flags: Flags,
  options: { internalVersion: 1 | 2; type: EnvelopeType; status?: DocumentStatus },
) =>
  await seedG4Envelope({
    internalVersion: options.internalVersion,
    owner,
    type: options.type,
    status: options.status ?? DocumentStatus.DRAFT,
    ...flags,
    recipients: [{ key: 's1', signingOrder: 1, fields: [] }],
  });

const UPDATE_WRITERS: UpdateWriter[] = [
  {
    name: 'envelope.update (API v2 /envelope/update), DRAFT',
    seed: async (owner, flags) =>
      await seedForUpdate(owner, flags, { internalVersion: 2, type: EnvelopeType.DOCUMENT }),
    update: async (request, owner, seeded, meta) =>
      await v2Api(request, owner.apiToken, '/envelope/update', { envelopeId: seeded.envelopeId, meta }),
  },
  {
    name: 'envelope.update (API v2 /envelope/update), PENDING SES',
    seed: async (owner, flags) =>
      await seedForUpdate(owner, flags, {
        internalVersion: 2,
        type: EnvelopeType.DOCUMENT,
        status: DocumentStatus.PENDING,
      }),
    update: async (request, owner, seeded, meta) =>
      await v2Api(request, owner.apiToken, '/envelope/update', { envelopeId: seeded.envelopeId, meta }),
  },
  {
    name: 'document.update (API v2 /document/update)',
    seed: async (owner, flags) =>
      await seedForUpdate(owner, flags, { internalVersion: 1, type: EnvelopeType.DOCUMENT }),
    update: async (request, owner, seeded, meta) =>
      await v2Api(request, owner.apiToken, '/document/update', { documentId: seeded.documentId, meta }),
  },
  {
    name: 'template.updateTemplate (API v2 /template/update)',
    seed: async (owner, flags) =>
      await seedForUpdate(owner, flags, { internalVersion: 1, type: EnvelopeType.TEMPLATE }),
    update: async (request, owner, seeded, meta) =>
      await v2Api(request, owner.apiToken, '/template/update', { templateId: seeded.documentId, meta }),
  },
];

const storedFlags = async (seeded: G4Seeded) =>
  flagsOf(await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } }));

for (const writer of UPDATE_WRITERS) {
  test(`C26 ${writer.name}: an update whose merged result has no method is refused, flags unchanged`, async ({
    request,
  }) => {
    const owner = await createG4Owner();
    const record: Record<string, unknown> = { writer: writer.name };

    // Control: a change that leaves a method on succeeds and is stored.
    const control = await writer.seed(owner, ALL_ON);
    const controlReply = await writer.update(request, owner, control, { drawSignatureEnabled: false });

    record.control = { status: controlReply.status, body: controlReply.body.slice(0, 300) };
    expect(controlReply.status, `control update: ${describeReply(controlReply)}`).toBeGreaterThanOrEqual(200);
    expect(controlReply.status, `control update: ${describeReply(controlReply)}`).toBeLessThan(300);
    expect(await storedFlags(control), 'control: the stored flags are the merged input').toEqual({
      ...ALL_ON,
      drawSignatureEnabled: false,
    });

    const cases: Array<{ label: string; seeded: Flags; meta: Partial<Flags> }> = [
      { label: 'all three sent false', seeded: ALL_ON, meta: ALL_OFF },
      {
        label: 'draw sent false on an envelope whose typed and upload are already false',
        seeded: { typedSignatureEnabled: false, drawSignatureEnabled: true, uploadSignatureEnabled: false },
        meta: { drawSignatureEnabled: false },
      },
    ];

    for (const testCase of cases) {
      const seeded = await writer.seed(owner, testCase.seeded);

      expect(await storedFlags(seeded), `${testCase.label}: premise, the seeded flags`).toEqual(testCase.seeded);

      const reply = await writer.update(request, owner, seeded, testCase.meta);
      const after = await storedFlags(seeded);

      record[testCase.label] = { status: reply.status, body: reply.body.slice(0, 300), after };

      expect.soft(reply.status, `${testCase.label}: refused with 400: ${describeReply(reply)}`).toBe(400);
      expectRefusalBody(reply, writer.name, testCase.label);
      expect.soft(after, `${testCase.label}: every stored flag unchanged`).toEqual(testCase.seeded);
    }

    await keepRecord('C26.json', record);
  });
}

// ---------------------------------------------------------------------------
// C27: team and organisation settings
// ---------------------------------------------------------------------------

type NullableFlags = {
  typedSignatureEnabled: boolean | null;
  drawSignatureEnabled: boolean | null;
  uploadSignatureEnabled: boolean | null;
};

const settingsIds = async (owner: G4Owner) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: owner.team.id } });
  const organisation = await prisma.organisation.findUniqueOrThrow({ where: { id: owner.organisation.id } });

  return { teamSettingsId: team.teamGlobalSettingsId, orgSettingsId: organisation.organisationGlobalSettingsId };
};

const setSettings = async (owner: G4Owner, team: NullableFlags, organisation: Flags) => {
  const ids = await settingsIds(owner);

  await prisma.teamGlobalSettings.update({ where: { id: ids.teamSettingsId }, data: team });
  await prisma.organisationGlobalSettings.update({ where: { id: ids.orgSettingsId }, data: organisation });
};

const readSettings = async (owner: G4Owner) => {
  const ids = await settingsIds(owner);
  const team = await prisma.teamGlobalSettings.findUniqueOrThrow({ where: { id: ids.teamSettingsId } });
  const organisation = await prisma.organisationGlobalSettings.findUniqueOrThrow({ where: { id: ids.orgSettingsId } });

  return {
    team: {
      typedSignatureEnabled: team.typedSignatureEnabled,
      drawSignatureEnabled: team.drawSignatureEnabled,
      uploadSignatureEnabled: team.uploadSignatureEnabled,
    },
    organisation: flagsOf(organisation),
  };
};

const INHERIT: NullableFlags = {
  typedSignatureEnabled: null,
  drawSignatureEnabled: null,
  uploadSignatureEnabled: null,
};

test('C27 team settings refuse an update whose merged team-over-organisation result has no method', async ({
  request,
}) => {
  const owner = await createG4Owner();
  const cookie = await seedSessionCookie(owner.user.id);
  const auth = { cookie, teamId: owner.team.id };
  const record: Record<string, unknown> = {};

  const updateTeam = async (data: Partial<NullableFlags>) =>
    await trpcAsUser(request, 'team.settings.update', { teamId: owner.team.id, data }, auth);

  // Control: the merged result keeps draw on through the organisation, so the update lands.
  await setSettings(
    owner,
    { typedSignatureEnabled: false, drawSignatureEnabled: null, uploadSignatureEnabled: null },
    ALL_ON,
  );

  const control = await updateTeam({ uploadSignatureEnabled: false });

  record.control = { status: control.status, body: control.body.slice(0, 300), after: await readSettings(owner) };
  expect(control.status, `control team update: ${describeReply(control)}`).toBe(200);
  expect((await readSettings(owner)).team, 'control: stored team flags are the input').toEqual({
    typedSignatureEnabled: false,
    drawSignatureEnabled: null,
    uploadSignatureEnabled: false,
  });

  const cases: Array<{ label: string; team: NullableFlags; organisation: Flags; data: Partial<NullableFlags> }> = [
    {
      label: 'all three sent false on a team inheriting all three',
      team: INHERIT,
      organisation: ALL_ON,
      data: { typedSignatureEnabled: false, drawSignatureEnabled: false, uploadSignatureEnabled: false },
    },
    {
      label: '{draw:false} on a team already typed=false, upload=false under an organisation with draw=false',
      team: { typedSignatureEnabled: false, drawSignatureEnabled: null, uploadSignatureEnabled: false },
      organisation: { typedSignatureEnabled: true, drawSignatureEnabled: false, uploadSignatureEnabled: true },
      data: { drawSignatureEnabled: false },
    },
    {
      label: '{draw:false} on a team inheriting from an organisation with typed and upload off',
      team: INHERIT,
      organisation: { typedSignatureEnabled: false, drawSignatureEnabled: true, uploadSignatureEnabled: false },
      data: { drawSignatureEnabled: false },
    },
    {
      label:
        '{draw:null} (inherit) on a team typed=false, draw=true, upload=false under an organisation with draw=false',
      team: { typedSignatureEnabled: false, drawSignatureEnabled: true, uploadSignatureEnabled: false },
      organisation: { typedSignatureEnabled: true, drawSignatureEnabled: false, uploadSignatureEnabled: true },
      data: { drawSignatureEnabled: null },
    },
  ];

  for (const testCase of cases) {
    await setSettings(owner, testCase.team, testCase.organisation);

    const before = await readSettings(owner);

    expect(before.team, `${testCase.label}: premise, the seeded team flags`).toEqual(testCase.team);

    const reply = await updateTeam(testCase.data);
    const after = await readSettings(owner);

    record[testCase.label] = { status: reply.status, code: errorOf(reply).code, after };

    expect.soft(reply.status, `${testCase.label}: refused with 400: ${describeReply(reply)}`).toBe(400);
    expect.soft(errorOf(reply).code, `${testCase.label}: data.code`).toBe('INVALID_REQUEST');
    expect.soft(after, `${testCase.label}: every stored flag unchanged`).toEqual(before);
  }

  await keepRecord('C27-team.json', record);
});

test('C27 organisation settings keep refusing a merged result with no method (regression)', async ({ request }) => {
  const owner = await createG4Owner();
  const cookie = await seedSessionCookie(owner.user.id);
  const auth = { cookie, teamId: owner.team.id };
  const record: Record<string, unknown> = {};

  const updateOrganisation = async (data: Partial<Flags>) =>
    await trpcAsUser(request, 'organisation.settings.update', { organisationId: owner.organisation.id, data }, auth);

  await setSettings(owner, INHERIT, ALL_ON);

  const control = await updateOrganisation({ drawSignatureEnabled: false });

  record.control = { status: control.status, body: control.body.slice(0, 300) };
  expect(control.status, `control organisation update: ${describeReply(control)}`).toBe(200);
  expect((await readSettings(owner)).organisation, 'control: stored organisation flags').toEqual({
    ...ALL_ON,
    drawSignatureEnabled: false,
  });

  const cases: Array<{ label: string; organisation: Flags; data: Partial<Flags> }> = [
    { label: 'all three sent false', organisation: ALL_ON, data: ALL_OFF },
    {
      label: '{draw:false} on an organisation with typed and upload off',
      organisation: { typedSignatureEnabled: false, drawSignatureEnabled: true, uploadSignatureEnabled: false },
      data: { drawSignatureEnabled: false },
    },
  ];

  for (const testCase of cases) {
    await setSettings(owner, INHERIT, testCase.organisation);

    const before = await readSettings(owner);
    const reply = await updateOrganisation(testCase.data);
    const after = await readSettings(owner);

    record[testCase.label] = { status: reply.status, code: errorOf(reply).code, after };

    expect.soft(reply.status, `${testCase.label}: refused with 400: ${describeReply(reply)}`).toBe(400);
    // The code is recorded, not asserted: the organisation refusal answers INVALID_BODY today and C27 asks it
    // to keep refusing "as now"; 4.0's INVALID_REQUEST for this writer is a question for the coordinator.
    expect.soft(after, `${testCase.label}: every stored flag unchanged`).toEqual(before);
  }

  await keepRecord('C27-organisation.json', record);
});
