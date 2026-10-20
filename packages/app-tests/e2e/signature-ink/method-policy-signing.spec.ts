/**
 * Signature-method policy at insertion time (F03).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * sections 3 rule 5 and 4.2) before any fix, without reading the sign routes.
 * Envelopes and templates are seeded through Prisma with the method flags on
 * their documentMeta; the recipient signs unauthenticated with only the token,
 * through the V1 route on a V1 envelope and the V2 route on a V2 envelope
 * ("both routes", spec 4.0), and the direct-link signer through
 * template.createDocumentFromDirectTemplate (DT).
 *
 * The rule: an image is refused unless draw or upload is enabled, text is
 * refused unless typed is enabled, both with 400 INVALID_REQUEST; with all
 * three off in the database every method is allowed (D3).
 *
 * | Criterion | Test                                                                                   |
 * | --------- | -------------------------------------------------------------------------------------- |
 * | C20       | C20 typed only (F03): an inked PNG is refused and a typed name accepted, both routes    |
 * | C21       | C21 draw only, upload only: an inked PNG is accepted and a typed name refused, both routes |
 * | C22       | C22 all three off in the database: image and typed name accepted on both routes and DT (API half; the dialog half is in all-methods-off.spec.ts) |
 * | C23       | C23 DT enforces the template's policy, and a refusal writes no rows and sends no email   |
 *
 * DT runs on V1 and V2 templates. An accepted DT submission must store the
 * Signature row, insert the field and write one DOCUMENT_FIELD_INSERTED row
 * whose data.field.data is the stored value.
 *
 * Today's refusals that exist answer with other codes (V2's typed-disabled
 * refusal is INVALID_BODY, which rule 6 moves to INVALID_REQUEST), so those
 * halves fail on the code with the status already 400.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { keepRecord } from '../fixtures/reject-seal';
import {
  auditValueOf,
  describeReply,
  expect2xx,
  expectCallRefused,
  expectMailCatcher,
  expectSignatureAccepted,
  fieldAuditRowsOf,
  type G4Seeded,
  imageManifest,
  normalisedPngProblems,
  QUIET_MS,
  readInbox,
  seedG4DirectTemplate,
  seedOneSigner,
  signSignature,
  submitDirectTemplate,
  teamRowCounts,
  validInkedDataUrl,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

type Flags = { typedSignatureEnabled: boolean; drawSignatureEnabled: boolean; uploadSignatureEnabled: boolean };

const TYPED_ONLY: Flags = { typedSignatureEnabled: true, drawSignatureEnabled: false, uploadSignatureEnabled: false };
const DRAW_ONLY: Flags = { typedSignatureEnabled: false, drawSignatureEnabled: true, uploadSignatureEnabled: false };
const UPLOAD_ONLY: Flags = { typedSignatureEnabled: false, drawSignatureEnabled: false, uploadSignatureEnabled: true };
const ALL_OFF: Flags = { typedSignatureEnabled: false, drawSignatureEnabled: false, uploadSignatureEnabled: false };

const TYPED_NAME = 'Policy Signer';

const imageDims = () => {
  const entry = imageManifest()['valid-inked'];

  return { width: entry.width, height: entry.height };
};

const label = (version: 1 | 2) => (version === 1 ? 'V1 field.signFieldWithToken' : 'V2 envelope.field.sign');

/** The stored flags are what the test seeded: the premise of every policy case. */
const expectSeededFlags = async (seeded: G4Seeded, flags: Flags) => {
  const meta = await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } });

  expect(
    {
      typedSignatureEnabled: meta.typedSignatureEnabled,
      drawSignatureEnabled: meta.drawSignatureEnabled,
      uploadSignatureEnabled: meta.uploadSignatureEnabled,
    },
    'premise: the envelope stores the policy under test',
  ).toEqual(flags);
};

const seedWithPolicy = async (version: 1 | 2, flags: Flags) => {
  const seeded = await seedOneSigner(version, flags);

  await expectSeededFlags(seeded, flags);

  return seeded;
};

/**
 * The refused kind is refused with the 4.0 bundle, and the same field then
 * takes the allowed kind (the F02 lock-out half of "Refused, field routes").
 */
const expectKindRefusedThenAllowed = async (
  request: APIRequestContext,
  version: 1 | 2,
  flags: Flags,
  refused: 'image' | 'typed',
  what: string,
) => {
  const seeded = await seedWithPolicy(version, flags);
  const signer = seeded.r.s1;
  const field = signer.fields.sig;
  const refusedValue = refused === 'image' ? validInkedDataUrl() : TYPED_NAME;
  const allowedValue = refused === 'image' ? TYPED_NAME : validInkedDataUrl();

  const reply = await expectCallRefused(
    seeded,
    field,
    async () => await signSignature(request, seeded, signer.token, field.id, refusedValue),
    `${what}: the ${refused === 'image' ? 'inked PNG' : 'typed name'}`,
  );

  const after = await signSignature(request, seeded, signer.token, field.id, allowedValue);

  await expectSignatureAccepted(
    after,
    seeded,
    field,
    refused === 'image' ? { typed: TYPED_NAME } : { image: imageDims() },
    `${what}: the same field afterwards takes the allowed kind`,
  );

  return { refusedStatus: reply.status, refusedBody: reply.body.slice(0, 300) };
};

const expectKindAccepted = async (
  request: APIRequestContext,
  version: 1 | 2,
  flags: Flags,
  kind: 'image' | 'typed',
  what: string,
) => {
  const seeded = await seedWithPolicy(version, flags);
  const signer = seeded.r.s1;
  const field = signer.fields.sig;
  const reply = await signSignature(
    request,
    seeded,
    signer.token,
    field.id,
    kind === 'image' ? validInkedDataUrl() : TYPED_NAME,
  );

  await expectSignatureAccepted(
    reply,
    seeded,
    field,
    kind === 'image' ? { image: imageDims() } : { typed: TYPED_NAME },
    `${what}: the ${kind === 'image' ? 'inked PNG' : 'typed name'}`,
  );

  return reply.status;
};

/** Runs a case softly so one route's failure does not hide the other's. */
const softly = async (record: Record<string, unknown>, key: string, body: () => Promise<unknown>) => {
  try {
    record[key] = { ok: true, detail: await body() };
  } catch (error) {
    record[key] = { ok: false, detail: String(error).slice(0, 600) };
  }
};

const expectAllCasesPassed = (record: Record<string, unknown>, what: string) => {
  const failed = Object.entries(record)
    .filter(([, value]) => !(value as { ok: boolean }).ok)
    .map(([key, value]) => `${key}: ${(value as { detail: string }).detail}`);

  expect(failed, `${what}: cases that broke the criterion`).toEqual([]);
};

// ---------------------------------------------------------------------------
// C20
// ---------------------------------------------------------------------------

test('C20 typed only (F03): an inked PNG is refused and a typed name accepted, on both routes', async ({ request }) => {
  const record: Record<string, unknown> = {};

  for (const version of [1, 2] as const) {
    await softly(record, `${label(version)} image refused`, async () =>
      expectKindRefusedThenAllowed(request, version, TYPED_ONLY, 'image', `C20 ${label(version)}`),
    );
    await softly(record, `${label(version)} typed accepted`, async () =>
      expectKindAccepted(request, version, TYPED_ONLY, 'typed', `C20 ${label(version)}`),
    );
  }

  await keepRecord('C20.json', record);
  expectAllCasesPassed(record, 'C20');
});

// ---------------------------------------------------------------------------
// C21
// ---------------------------------------------------------------------------

for (const [name, flags] of [
  ['draw only', DRAW_ONLY],
  ['upload only', UPLOAD_ONLY],
] as const) {
  test(`C21 ${name}: an inked PNG is accepted and a typed name refused, on both routes`, async ({ request }) => {
    const record: Record<string, unknown> = {};

    for (const version of [1, 2] as const) {
      await softly(record, `${label(version)} image accepted`, async () =>
        expectKindAccepted(request, version, flags, 'image', `C21 ${name} ${label(version)}`),
      );
      await softly(record, `${label(version)} typed refused`, async () =>
        expectKindRefusedThenAllowed(request, version, flags, 'typed', `C21 ${name} ${label(version)}`),
      );
    }

    await keepRecord(`C21-${name.replace(' ', '-')}.json`, record);
    expectAllCasesPassed(record, `C21 ${name}`);
  });
}

// ---------------------------------------------------------------------------
// DT helpers
// ---------------------------------------------------------------------------

/** The Signature row DT wrote on the document it created. */
const dtStoredSignature = async (envelopeId: string) => {
  const rows = await prisma.signature.findMany({ where: { field: { envelopeId } } });

  expect(rows, `the DT document ${envelopeId} has exactly one Signature row`).toHaveLength(1);

  return rows[0];
};

const createdEnvelopeId = (body: string) => {
  const parsed = JSON.parse(body) as { result?: { data?: { json?: { envelopeId?: string } } } };
  const envelopeId = parsed.result?.data?.json?.envelopeId;

  expect(envelopeId, `the DT reply names the created envelope: ${body.slice(0, 200)}`).toBeTruthy();

  return envelopeId as string;
};

const expectDtAccepted = async (request: APIRequestContext, version: 1 | 2, flags: Flags, kind: 'image' | 'typed') => {
  const template = await seedG4DirectTemplate(version, flags);
  const value = kind === 'image' ? validInkedDataUrl() : TYPED_NAME;
  const reply = await submitDirectTemplate(request, template, { value, isBase64: kind === 'image' });

  expect2xx(reply, `DT V${version} ${kind}`);

  const row = await dtStoredSignature(createdEnvelopeId(reply.body));

  if (kind === 'image') {
    expect(row.typedSignature, `DT V${version}: no typed signature stored`).toBeNull();
    expect(normalisedPngProblems(row.signatureImageAsBase64, imageDims()), `DT V${version}: stored image`).toEqual([]);
  } else {
    expect(row.signatureImageAsBase64, `DT V${version}: no image stored`).toBeNull();
    expect(row.typedSignature, `DT V${version}: the typed name`).toBe(TYPED_NAME);
  }

  const envelopeId = createdEnvelopeId(reply.body);
  const field = await prisma.field.findUniqueOrThrow({ where: { id: row.fieldId } });

  expect(field.type, `DT V${version}: the Signature row belongs to the SIGNATURE field`).toBe(FieldType.SIGNATURE);
  expect(field.inserted, `DT V${version}: the SIGNATURE field is inserted`).toBe(true);

  const inserts = await fieldAuditRowsOf(envelopeId, field.secondaryId, ['DOCUMENT_FIELD_INSERTED']);

  expect(inserts.length, `DT V${version}: exactly one DOCUMENT_FIELD_INSERTED row for the field`).toBe(1);
  expect(auditValueOf(inserts[0]), `DT V${version}: the audit row records the stored value`).toBe(
    row.signatureImageAsBase64 ?? row.typedSignature,
  );

  return reply.status;
};

/**
 * C16's no-rows assertion: 400 INVALID_REQUEST, no Envelope, Recipient, Field
 * or Signature row for the team, and no email to the direct signer or the owner.
 */
const expectDtRefused = async (request: APIRequestContext, version: 1 | 2, flags: Flags, kind: 'image' | 'typed') => {
  const template = await seedG4DirectTemplate(version, flags);
  const before = await teamRowCounts(template.owner.team.id);
  const signerMailbox = `g4-dt-refused-${template.directToken}`.toLowerCase();
  const ownerMailbox = template.owner.user.email.split('@')[0];
  const mailBefore = {
    signer: (await readInbox(request, signerMailbox)).length,
    owner: (await readInbox(request, ownerMailbox)).length,
  };

  expect(before.envelopes, 'premise: the fresh team owns no documents yet').toBe(0);

  const value = kind === 'image' ? validInkedDataUrl() : TYPED_NAME;
  const reply = await submitDirectTemplate(
    request,
    template,
    { value, isBase64: kind === 'image' },
    { email: `${signerMailbox}@test.documenso.com` },
  );

  expect(reply.status, `DT V${version} ${kind} is refused with 400: ${describeReply(reply)}`).toBe(400);
  expect(JSON.parse(reply.body)?.error?.json?.data?.code, `DT V${version} ${kind}: data.code`).toBe('INVALID_REQUEST');
  expect(await teamRowCounts(template.owner.team.id), `DT V${version} ${kind}: no rows written`).toEqual(before);

  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

  expect(
    {
      signer: (await readInbox(request, signerMailbox)).length,
      owner: (await readInbox(request, ownerMailbox)).length,
    },
    `DT V${version} ${kind}: no email sent`,
  ).toEqual(mailBefore);

  return reply.status;
};

// ---------------------------------------------------------------------------
// C22 (API half)
// ---------------------------------------------------------------------------

test('C22 all three methods off in the database: an inked image and a typed name are each accepted on both routes and DT', async ({
  request,
}) => {
  const record: Record<string, unknown> = {};

  for (const version of [1, 2] as const) {
    for (const kind of ['image', 'typed'] as const) {
      await softly(record, `${label(version)} ${kind}`, async () =>
        expectKindAccepted(request, version, ALL_OFF, kind, `C22 ${label(version)}`),
      );
    }
  }

  for (const version of [1, 2] as const) {
    for (const kind of ['image', 'typed'] as const) {
      await softly(record, `DT V${version} ${kind}`, async () => expectDtAccepted(request, version, ALL_OFF, kind));
    }
  }

  await keepRecord('C22.json', record);
  expectAllCasesPassed(record, 'C22');
});

// ---------------------------------------------------------------------------
// C23
// ---------------------------------------------------------------------------

test("C23 DT enforces the template's policy: typed-only refuses an image, image-only refuses text, and no rows are written", async ({
  request,
}) => {
  test.setTimeout(120_000);
  await expectMailCatcher(request);

  const record: Record<string, unknown> = {};

  for (const version of [1, 2] as const) {
    await softly(record, `V${version} typed-only refuses an image`, async () =>
      expectDtRefused(request, version, TYPED_ONLY, 'image'),
    );
    await softly(record, `V${version} image-only refuses text`, async () =>
      expectDtRefused(request, version, DRAW_ONLY, 'typed'),
    );
    // Controls: the allowed kind still creates the document on the same policies.
    await softly(record, `V${version} typed-only accepts text`, async () =>
      expectDtAccepted(request, version, TYPED_ONLY, 'typed'),
    );
    await softly(record, `V${version} image-only accepts an image`, async () =>
      expectDtAccepted(request, version, DRAW_ONLY, 'image'),
    );
  }

  await keepRecord('C23.json', record);
  expectAllCasesPassed(record, 'C23');
});
