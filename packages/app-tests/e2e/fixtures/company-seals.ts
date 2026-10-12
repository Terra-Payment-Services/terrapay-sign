/**
 * Fixtures for the company seal specs.
 *
 * Written from the specification before any
 * implementation exists. Everything the specification leaves to the
 * implementer is a named constant in this file, so a mismatch is fixed in one
 * place and nowhere else:
 *
 *   SEAL_PROCEDURES  tRPC procedure paths
 *   SEAL_INPUT       the request body each procedure takes
 *   SEAL_FORM        the multipart part names of companySeal.create
 *   SEAL_UI          labels, button names and test ids of the settings page,
 *                    the editor and the signing page
 *   SEAL_ROUTES      page and endpoint paths
 *   SEAL_ENV         where the mail catcher's web API lives
 *
 * Every verdict comes from an observable: an HTTP answer, a database row,
 * pixels rendered by poppler from the sealed PDF, or text poppler extracts.
 * The seal table is read with raw SQL so these files compile and load before
 * the Prisma model exists.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { formatSecureCookieName } from '@documenso/lib/constants/auth';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedOrganisationMembers } from '@documenso/prisma/seed/organisations';
import { seedUser } from '@documenso/prisma/seed/users';
import { PDF, StandardFonts } from '@libpdf/core';
import {
  type APIRequestContext,
  type APIResponse,
  type Browser,
  test as base,
  expect,
  type Page,
} from '@playwright/test';
import { type DocumentDataType, OrganisationMemberRole } from '@prisma/client';
import sharp from 'sharp';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
export const API_V2 = `${WEBAPP_BASE_URL}/api/v2-beta`;
export const API_V1 = `${WEBAPP_BASE_URL}/api/v1`;

// ---------------------------------------------------------------------------
// Names the specification leaves to the implementer
// ---------------------------------------------------------------------------

/** Spec: "tRPC routes under the organisation router" and `envelope.companySeal.getForField`. */
export const SEAL_PROCEDURES = {
  create: 'organisation.companySeal.create',
  find: 'organisation.companySeal.find',
  findForEnvelope: 'organisation.companySeal.findForEnvelope',
  getForField: 'envelope.companySeal.getForField',
  /** Existing procedures. */
  signField: 'envelope.field.sign',
  complete: 'recipient.completeDocumentWithToken',
  reseal: 'admin.document.reseal',
  removeMember: 'organisation.member.delete',
} as const;

/** The spec names no request shapes; these follow the branding route and the sign-field route. */
export const SEAL_INPUT = {
  find: (organisationId: string) => ({ organisationId }),
  findForEnvelope: (envelopeId: string) => ({ envelopeId }),
  getForField: (token: string, fieldId: number) => ({ token, fieldId }),
} as const;

/** Multipart parts of companySeal.create, as the branding upload names `payload` and `brandingLogo`. */
export const SEAL_FORM = {
  payload: 'payload',
  image: 'image',
} as const;

/** Spec: page `o/<orgUrl>/settings/seals`, "Company seal", "Apply seal", `COMPANY_SEAL`. */
export const SEAL_UI = {
  paletteButton: 'Company seal',
  applyButton: 'Apply seal',
  settingsNameLabel: 'Name',
  settingsLegalEntityLabel: 'Legal entity',
  /** Opens the create form, if the form is behind a button; the form may also be on the page. */
  createButton: 'Create seal',
  settingsSaveButton: 'Save seal',
  /** The processed image shown for confirmation before the seal is saved. */
  previewTestId: 'company-seal-preview',
  /** One row per seal on the settings page. */
  rowTestId: 'company-seal-row',
  /** The Shadcn Select of seals in EditorFieldCompanySealForm. */
  pickerTestId: 'company-seal-select',
  /** The confirmation dialog on the signing page, which holds the seal image. */
  confirmDialogTestId: 'company-seal-confirm',
  /** The existing account-authentication prompt (DocumentSigningAuthDialog) shown to a recipient who is not signed in. */
  signInPromptText: 'Reauthentication is required to sign this field',
  /** The login-required message in the embed, where the server's message is shown. */
  embedLoginMessage: /sign in|log in|login/i,
} as const;

export const SEAL_ROUTES = {
  settingsPage: (orgUrl: string) => `/o/${orgUrl}/settings/seals`,
  brandingLogoOrganisation: (organisationId: string) => `/api/branding/logo/organisation/${organisationId}`,
  brandingLogoTeam: (teamId: number) => `/api/branding/logo/team/${teamId}`,
} as const;

/** The mail catcher's web API. CI sets E2E_INBUCKET_URL, as for the send-path specs; the compose file publishes 9000. */
export const SEAL_ENV = {
  mailApiUrl: process.env.E2E_INBUCKET_URL || 'http://127.0.0.1:9000',
} as const;

/** Error codes the spec names, each carried as `data.code`. */
export const SEAL_ERRORS = {
  loginRequired: { code: 'COMPANY_SEAL_LOGIN_REQUIRED', status: 401 },
  notAuthorised: { code: 'COMPANY_SEAL_NOT_AUTHORISED', status: 403 },
  recipientNotAuthorised: { code: 'COMPANY_SEAL_RECIPIENT_NOT_AUTHORISED', status: 400 },
} as const;

export const SEAL_FIELD_TYPE = 'COMPANY_SEAL';
export const SEAL_FIELD_META_TYPE = 'company_seal';

// ---------------------------------------------------------------------------
// Test images, all generated here with sharp
// ---------------------------------------------------------------------------

export const BLUE = { r: 0, g: 0, b: 255 } as const;
export const RED = { r: 255, g: 0, b: 0 } as const;

type Rgb = { r: number; g: number; b: number };

/** A solid disc on a transparent square, the spec's test seal. */
export const discPng = async (size = 400, colour: Rgb = BLUE) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="rgb(${colour.r},${colour.g},${colour.b})"/></svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
};

export const discJpeg = async (size = 400) =>
  await sharp(await discPng(size))
    .flatten({ background: '#ffffff' })
    .jpeg()
    .toBuffer();

export const discWebp = async (size = 400) =>
  await sharp(await discPng(size))
    .webp({ lossless: true })
    .toBuffer();

/** A disc on a transparent canvas wide or tall rather than square. */
export const discPngOfSize = async (width: number, height: number, colour: Rgb = BLUE) => {
  const radius = Math.min(width, height) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${radius}" fill="rgb(${colour.r},${colour.g},${colour.b})"/></svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
};

export const svgBytes = () =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><circle cx="200" cy="200" r="200" fill="rgb(0,0,255)"/></svg>',
  );

export const gifBytes = async () =>
  await sharp(await discPng(400))
    .gif()
    .toBuffer();

/** A real, openable PDF renamed to .png. */
export const pdfBytes = async () => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: 'letter' });

  page.drawText('not an image', { x: 50, y: 700, font: StandardFonts.Helvetica, size: 14 });

  return Buffer.from(await pdf.save());
};

/**
 * A PNG stored without compression, so that its file size is near its raw
 * pixel size. Used to reach the 5 MB request limit with an image that
 * re-encodes to something small.
 */
export const uncompressedPng = async (width: number, height: number) =>
  await sharp(await discPngOfSize(width, height))
    .png({ compressionLevel: 0 })
    .toBuffer();

/** An image of random noise: it does not compress, so its re-encoded PNG is large. */
export const noisePng = async (size: number) =>
  await sharp(crypto.randomBytes(size * size * 3), { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();

/** A solid PNG whose pixel count is `width * height`, small as a file and large as a bitmap. */
export const solidPng = async (width: number, height: number) =>
  await sharp({ create: { width, height, channels: 3, background: BLUE } })
    .png()
    .toBuffer();

export const sha256Hex = (bytes: Uint8Array | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// tRPC calls with the status, headers and error code kept
// ---------------------------------------------------------------------------

export type TrpcResult = {
  /** The HTTP status of the answer. */
  status: number;
  /** The status the platform declares for the error (`data.httpStatus`), else the HTTP status. */
  httpStatus: number;
  ok: boolean;
  /** The application error code (`data.code`) of a refusal. */
  code?: string;
  message?: string;
  /** The `result.data.json` of a success. */
  data?: unknown;
  text: string;
  headers: Record<string, string>;
};

export const readTrpc = async (res: APIResponse): Promise<TrpcResult> => {
  const text = await res.text();

  let body:
    | {
        error?: { json?: { message?: string; data?: { code?: string; httpStatus?: number } } };
        result?: { data?: { json?: unknown } };
      }
    | undefined;

  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  const errorJson = body?.error?.json;

  return {
    status: res.status(),
    httpStatus: Number(errorJson?.data?.httpStatus ?? res.status()),
    ok: res.ok(),
    code: errorJson?.data?.code,
    message: errorJson?.message,
    data: body?.result?.data?.json,
    text,
    headers: res.headers(),
  };
};

export const trpcCall = async (
  ctx: APIRequestContext,
  procedure: string,
  input: Record<string, unknown>,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string> } = {},
) => {
  const method = options.method ?? 'POST';

  if (method === 'GET') {
    const query = encodeURIComponent(JSON.stringify({ json: input }));

    return await readTrpc(
      await ctx.get(`${WEBAPP_BASE_URL}/api/trpc/${procedure}?input=${query}`, { headers: options.headers }),
    );
  }

  return await readTrpc(
    await ctx.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
      headers: { 'content-type': 'application/json', ...options.headers },
      data: JSON.stringify({ json: input }),
    }),
  );
};

/** Whether a response body carries a given image, as a base64 string or inside a data URL. */
export const bodyCarriesImage = (text: string, png: Uint8Array | Buffer) =>
  text.includes(Buffer.from(png).toString('base64'));

/** Spec: each seal-image answer carries `Cache-Control: private, no-store`. */
export const expectPrivateNoStore = (headers: Record<string, string>, context: string) => {
  const value = (headers['cache-control'] ?? '').toLowerCase();

  expect.soft(value, `${context}: Cache-Control is "${headers['cache-control']}"`).toContain('private');
  expect.soft(value, `${context}: Cache-Control is "${headers['cache-control']}"`).toContain('no-store');
};

// ---------------------------------------------------------------------------
// Seal rows, read with raw SQL
// ---------------------------------------------------------------------------

export type SealRow = {
  id: string;
  organisationId: string;
  name: string;
  legalEntityName: string;
  imageData: string | { type: DocumentDataType; data: string };
  imageSha256: string;
  createdAt: Date;
  createdByUserId: number;
  createdByName: string;
  createdByEmail: string;
  createdFromIp: string | null;
  createdUserAgent: string | null;
};

export const sealRows = async (organisationId: string) =>
  await prisma.$queryRawUnsafe<SealRow[]>(
    'SELECT * FROM "CompanySeal" WHERE "organisationId" = $1 ORDER BY "createdAt", "id"',
    organisationId,
  );

export const sealRowById = async (id: string) => {
  const rows = await prisma.$queryRawUnsafe<SealRow[]>('SELECT * FROM "CompanySeal" WHERE "id" = $1', id);

  return rows[0];
};

export const sealRowCount = async (organisationId: string) => (await sealRows(organisationId)).length;

const parseImageData = (imageData: SealRow['imageData']) =>
  (typeof imageData === 'string' ? JSON.parse(imageData) : imageData) as { type: DocumentDataType; data: string };

/** The stored PNG bytes, read through the same storage reader the application uses. */
export const storedSealImage = async (row: SealRow) =>
  Buffer.from(await getFileServerSide(parseImageData(row.imageData)));

/**
 * Stands in for an operator's change to a seal (criterion 23): the application
 * has no way to make one. Written in whichever shape the column has.
 */
export const overwriteSealImage = async (sealId: string, png: Buffer) => {
  const [column] = await prisma.$queryRawUnsafe<{ data_type: string }[]>(
    `SELECT data_type FROM information_schema.columns WHERE table_name = 'CompanySeal' AND column_name = 'imageData'`,
  );
  const value = JSON.stringify({ type: 'BYTES_64', data: png.toString('base64') });

  await prisma.$executeRawUnsafe(
    `UPDATE "CompanySeal" SET "imageData" = $1${column?.data_type === 'jsonb' || column?.data_type === 'json' ? '::jsonb' : ''} WHERE "id" = $2`,
    value,
    sealId,
  );
};

// ---------------------------------------------------------------------------
// People and sessions
// ---------------------------------------------------------------------------

export type SealWorld = Awaited<ReturnType<typeof seedSealWorld>>;

/** One organisation with every role, and a second organisation with its own manager. */
export const seedSealWorld = async () => {
  const { user: owner, organisation, team } = await seedUser({ isPersonalOrganisation: false });

  const [admin, manager, member, otherMember] = await seedOrganisationMembers({
    organisationId: organisation.id,
    members: [
      { organisationRole: OrganisationMemberRole.ADMIN, name: 'Seal Admin' },
      { organisationRole: OrganisationMemberRole.MANAGER, name: 'Seal Manager' },
      { organisationRole: OrganisationMemberRole.MEMBER, name: 'Seal Member' },
      { organisationRole: OrganisationMemberRole.MEMBER, name: 'Other Member' },
    ],
  });

  const { user: foreignOwner, organisation: foreignOrganisation } = await seedUser({ isPersonalOrganisation: false });

  const [foreignManager] = await seedOrganisationMembers({
    organisationId: foreignOrganisation.id,
    members: [{ organisationRole: OrganisationMemberRole.MANAGER, name: 'Foreign Manager' }],
  });

  const { token: ownerApiToken } = await createApiToken({
    userId: owner.id,
    teamId: team.id,
    tokenName: 'seal-e2e',
    expiresIn: null,
  });

  return {
    owner,
    admin,
    manager,
    member,
    otherMember,
    organisation,
    team,
    ownerApiToken,
    foreignOwner,
    foreignManager,
    foreignOrganisation,
  };
};

const addSessionCookie = async (context: Awaited<ReturnType<Browser['newContext']>>, email: string) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = crypto.randomBytes(20).toString('hex');
  const id = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date();

  await prisma.session.create({
    data: {
      id,
      sessionToken: id,
      userId: user.id,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    },
  });

  const secret = process.env.NEXTAUTH_SECRET;

  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set; the signed session cookie cannot be made');
  }

  const signature = crypto.createHmac('sha256', secret).update(token).digest('base64');
  const url = new URL(WEBAPP_BASE_URL);

  await context.addCookies([
    {
      name: formatSecureCookieName('sessionId'),
      value: encodeURIComponent(`${token}.${signature}`),
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
};

export type SealSession = { page: Page; request: APIRequestContext };

/** A signed-in browser context, closed when the test ends. */
export const test = base.extend<{ signIn: (email: string) => Promise<SealSession> }>({
  signIn: async ({ browser }: { browser: Browser }, use) => {
    const contexts: Array<{ close: () => Promise<void> }> = [];

    await use(async (email: string) => {
      const context = await browser.newContext();
      contexts.push(context);

      const page = await context.newPage();

      // A real session row and signed cookie, made without the login endpoint: auth.login allows 50 per 15 minutes
      // and the suite signs in far more often than that.
      await addSessionCookie(context, email);

      return { page, request: context.request };
    });

    for (const context of contexts) {
      await context.close();
    }
  },
});

export { expect };

// ---------------------------------------------------------------------------
// Creating seals
// ---------------------------------------------------------------------------

export type SealImage = { buffer: Buffer; mimeType?: string; name?: string };

export const createSeal = async (
  ctx: APIRequestContext,
  input: { organisationId: string; name: string; legalEntityName: string; image: SealImage },
  headers?: Record<string, string>,
) => {
  const { image, ...payload } = input;

  return await readTrpc(
    await ctx.post(`${WEBAPP_BASE_URL}/api/trpc/${SEAL_PROCEDURES.create}`, {
      headers,
      multipart: {
        [SEAL_FORM.payload]: JSON.stringify(payload),
        [SEAL_FORM.image]: {
          name: image.name ?? 'seal.png',
          mimeType: image.mimeType ?? 'image/png',
          buffer: image.buffer,
        },
      },
    }),
  );
};

let sealCounter = 0;

export const uniqueSealNames = () => {
  sealCounter += 1;

  const stamp = `${Date.now().toString(36)}${sealCounter}${Math.random().toString(36).slice(2, 5)}`;

  return { name: `Seal ${stamp}`, legalEntityName: `Entity ${stamp} Ltd` };
};

/** Creates a blue-disc seal as the given session and returns its row. Fails the test if creation is refused. */
export const createBlueSeal = async (
  session: SealSession,
  organisationId: string,
  overrides: { name?: string; legalEntityName?: string; image?: SealImage } = {},
) => {
  const names = uniqueSealNames();
  const name = overrides.name ?? names.name;
  const legalEntityName = overrides.legalEntityName ?? names.legalEntityName;

  const result = await createSeal(session.request, {
    organisationId,
    name,
    legalEntityName,
    image: overrides.image ?? { buffer: await discPng(400) },
  });

  expect(result.ok, `companySeal.create failed: ${result.status} ${result.text}`).toBe(true);

  const row = (await sealRows(organisationId)).find((r) => r.name === name);

  expect(row, `no CompanySeal row named ${name} after create`).toBeTruthy();

  return row as SealRow;
};

// ---------------------------------------------------------------------------
// Envelopes with seal fields, built through API v2
// ---------------------------------------------------------------------------

export type SealRecipientInput = {
  email: string;
  name?: string;
  role?: 'SIGNER' | 'APPROVER' | 'VIEWER' | 'CC' | 'ASSISTANT';
  signingOrder?: number;
  /** A seal field for this recipient. */
  sealId?: string;
  /** Where the seal field goes, as percentages of the page. Default: a square at 40/40. */
  sealBox?: { positionX: number; positionY: number; width: number; height: number };
  /** Whether to add a SIGNATURE field (the default for SIGNER and APPROVER). */
  signature?: boolean;
  /** A client-supplied sealLabel, to prove the server replaces it. */
  sealLabel?: string;
  /** Further fields for this recipient, such as a TEXT field an assistant may prefill. */
  extraFields?: Array<{ type: string; fieldMeta: Record<string, unknown> }>;
};

export const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A square on a US Letter page: `width` per cent of the width, and the height that makes it square. */
export const letterSquare = (positionX: number, positionY: number, width: number) => ({
  positionX,
  positionY,
  width,
  height: Number(((width * 612) / 792).toFixed(4)),
});

export const DEFAULT_SEAL_BOX = letterSquare(40, 40, 20);

let blankPdfCache: Buffer | undefined;

/** A US Letter page with one line of text near the top, so the area where seals go is white. */
export const blankLetterPdf = async () => {
  if (!blankPdfCache) {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: 'letter' });

    page.drawText('Agreement between the parties', { x: 50, y: 740, font: StandardFonts.Helvetica, size: 14 });

    blankPdfCache = Buffer.from(await pdf.save());
  }

  return blankPdfCache;
};

export type BuiltSealEnvelope = Awaited<ReturnType<typeof buildSealEnvelope>>;

export const buildSealEnvelope = async (
  request: APIRequestContext,
  world: Pick<SealWorld, 'ownerApiToken'>,
  options: {
    recipients: SealRecipientInput[];
    pdf?: { name: string; data: Buffer };
    meta?: Record<string, unknown>;
    type?: 'DOCUMENT' | 'TEMPLATE';
    /** `true` sends and asserts success; `false` leaves the draft for the caller to send. */
    send?: boolean;
  },
) => {
  const token = world.ownerApiToken;
  const pdf = options.pdf ?? { name: 'seal-test.pdf', data: await blankLetterPdf() };

  const payload: Record<string, unknown> = {
    title: `[SEAL] ${Date.now()}`,
    type: options.type ?? 'DOCUMENT',
    ...(options.meta ? { meta: options.meta } : {}),
  };

  const form = new FormData();

  form.append('payload', JSON.stringify(payload));
  form.append('files', new File([pdf.data], pdf.name, { type: 'application/pdf' }));

  const created = await request.post(`${API_V2}/envelope/create`, { headers: authHeader(token), multipart: form });

  expect(created.ok(), `envelope/create failed: ${await created.text()}`).toBe(true);

  const { id: envelopeId } = (await created.json()) as { id: string };

  const recipientsRes = await request.post(`${API_V2}/envelope/recipient/create-many`, {
    headers: authHeader(token),
    data: {
      envelopeId,
      data: options.recipients.map((r) => ({
        email: r.email,
        name: r.name ?? r.email,
        role: r.role ?? 'SIGNER',
        ...(r.signingOrder !== undefined ? { signingOrder: r.signingOrder } : {}),
      })),
    },
  });

  expect(recipientsRes.ok(), `recipient/create-many failed: ${await recipientsRes.text()}`).toBe(true);

  const createdRecipients = ((await recipientsRes.json()) as { data: Array<{ id: number; email: string }> }).data;

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { envelopeItems: true },
  });

  const envelopeItemId = envelope.envelopeItems[0].id;

  const fields: Array<Record<string, unknown>> = [];

  options.recipients.forEach((r, index) => {
    const recipientId = createdRecipients.find((c) => c.email.toLowerCase() === r.email.toLowerCase())?.id;
    const role = r.role ?? 'SIGNER';

    if (recipientId === undefined) {
      throw new Error(`recipient ${r.email} was not created`);
    }

    if (r.signature ?? (role === 'SIGNER' || role === 'APPROVER')) {
      fields.push({
        recipientId,
        envelopeItemId,
        type: 'SIGNATURE',
        page: 1,
        positionX: 10,
        positionY: 10 + index * 8,
        width: 20,
        height: 5,
      });
    }

    for (const extra of r.extraFields ?? []) {
      fields.push({
        recipientId,
        envelopeItemId,
        type: extra.type,
        page: 1,
        positionX: 10,
        positionY: 80,
        width: 20,
        height: 5,
        fieldMeta: extra.fieldMeta,
      });
    }

    if (r.sealId) {
      fields.push({
        recipientId,
        envelopeItemId,
        type: SEAL_FIELD_TYPE,
        page: 1,
        ...(r.sealBox ?? DEFAULT_SEAL_BOX),
        fieldMeta: {
          type: SEAL_FIELD_META_TYPE,
          sealId: r.sealId,
          ...(r.sealLabel ? { sealLabel: r.sealLabel } : {}),
        },
      });
    }
  });

  const fieldsRes = await request.post(`${API_V2}/envelope/field/create-many`, {
    headers: authHeader(token),
    data: { envelopeId, data: fields },
  });

  expect(fieldsRes.ok(), `field/create-many failed: ${await fieldsRes.text()}`).toBe(true);

  const send = async () =>
    await request.post(`${API_V2}/envelope/distribute`, { headers: authHeader(token), data: { envelopeId } });

  let distribute: { recipients: Array<{ id: number; token: string; email: string }> } | undefined;

  if (options.send ?? true) {
    const res = await send();

    expect(res.ok(), `envelope/distribute failed: ${await res.text()}`).toBe(true);

    distribute = await res.json();
  }

  const stored = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { recipients: { include: { fields: true } }, envelopeItems: true },
  });

  const people = stored.recipients.map((recipient) => {
    const sealField = recipient.fields.find((f) => String(f.type) === SEAL_FIELD_TYPE);
    const signatureField = recipient.fields.find((f) => f.type === 'SIGNATURE');

    return {
      id: recipient.id,
      email: recipient.email,
      token: recipient.token,
      sealFieldId: sealField?.id,
      signatureFieldId: signatureField?.id,
      fields: recipient.fields,
    };
  });

  return {
    envelopeId,
    envelopeItemId,
    /** Read on use: a template's secondary ID is not a document ID, and mapping it throws. */
    get documentId() {
      return mapSecondaryIdToDocumentId(stored.secondaryId);
    },
    secondaryId: stored.secondaryId,
    apiToken: token,
    people,
    distribute,
    send,
    personByEmail: (email: string) => {
      const person = people.find((p) => p.email.toLowerCase() === email.toLowerCase());

      if (!person) {
        throw new Error(`no recipient ${email}`);
      }

      return person;
    },
  };
};

/** Creates seal fields through the API without asserting, for the refusal tests. */
export const postFieldsRaw = async (
  request: APIRequestContext,
  apiToken: string,
  envelopeId: string,
  envelopeItemId: string,
  fields: Array<{ recipientId: number; fieldMeta: Record<string, unknown>; box?: typeof DEFAULT_SEAL_BOX }>,
) =>
  await request.post(`${API_V2}/envelope/field/create-many`, {
    headers: authHeader(apiToken),
    data: {
      envelopeId,
      data: fields.map((f) => ({
        recipientId: f.recipientId,
        envelopeItemId,
        type: SEAL_FIELD_TYPE,
        page: 1,
        ...(f.box ?? DEFAULT_SEAL_BOX),
        fieldMeta: f.fieldMeta,
      })),
    },
  });

/** A V2 draft with one SIGNER recipient and no fields, for field-creation tests. */
export const buildDraftWithRecipients = async (
  request: APIRequestContext,
  world: Pick<SealWorld, 'ownerApiToken'>,
  recipients: Array<{
    email: string;
    role?: 'SIGNER' | 'APPROVER' | 'VIEWER' | 'CC' | 'ASSISTANT';
    signingOrder?: number;
  }>,
  type: 'DOCUMENT' | 'TEMPLATE' = 'DOCUMENT',
) => {
  const token = world.ownerApiToken;
  const form = new FormData();

  form.append('payload', JSON.stringify({ title: `[SEAL DRAFT] ${Date.now()}`, type }));
  form.append('files', new File([await blankLetterPdf()], 'seal-test.pdf', { type: 'application/pdf' }));

  const created = await request.post(`${API_V2}/envelope/create`, { headers: authHeader(token), multipart: form });

  expect(created.ok(), `envelope/create failed: ${await created.text()}`).toBe(true);

  const { id: envelopeId } = (await created.json()) as { id: string };

  const recipientsRes = await request.post(`${API_V2}/envelope/recipient/create-many`, {
    headers: authHeader(token),
    data: {
      envelopeId,
      data: recipients.map((r) => ({
        email: r.email,
        name: r.email,
        role: r.role ?? 'SIGNER',
        ...(r.signingOrder !== undefined ? { signingOrder: r.signingOrder } : {}),
      })),
    },
  });

  expect(recipientsRes.ok(), `recipient/create-many failed: ${await recipientsRes.text()}`).toBe(true);

  const created2 = ((await recipientsRes.json()) as { data: Array<{ id: number; email: string }> }).data;
  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { envelopeItems: true },
  });

  return {
    envelopeId,
    envelopeItemId: envelope.envelopeItems[0].id,
    secondaryId: envelope.secondaryId,
    recipientIdFor: (email: string) => {
      const found = created2.find((c) => c.email.toLowerCase() === email.toLowerCase());

      if (!found) {
        throw new Error(`no recipient ${email}`);
      }

      return found.id;
    },
  };
};

// ---------------------------------------------------------------------------
// Recipient actions
// ---------------------------------------------------------------------------

export const signSignatureField = async (ctx: APIRequestContext, token: string, fieldId: number) =>
  await trpcCall(ctx, SEAL_PROCEDURES.signField, {
    token,
    fieldId,
    fieldValue: { type: 'SIGNATURE', value: 'Signature' },
  });

export const applySeal = async (ctx: APIRequestContext, token: string, fieldId: number, value = true) =>
  await trpcCall(ctx, SEAL_PROCEDURES.signField, {
    token,
    fieldId,
    fieldValue: { type: SEAL_FIELD_TYPE, value },
  });

export const getSealForField = async (ctx: APIRequestContext, token: string, fieldId: number) =>
  await trpcCall(ctx, SEAL_PROCEDURES.getForField, SEAL_INPUT.getForField(token, fieldId), { method: 'GET' });

export const completeWithToken = async (ctx: APIRequestContext, token: string, documentId: number) =>
  await trpcCall(ctx, SEAL_PROCEDURES.complete, { token, documentId });

export const expectRefusal = (result: TrpcResult, expected: { code: string; status: number }, context: string) => {
  expect.soft(result.ok, `${context}: refused (${result.status} ${result.text.slice(0, 300)})`).toBe(false);
  expect.soft(result.code, `${context}: error code`).toBe(expected.code);
  expect.soft(result.httpStatus, `${context}: declared status`).toBe(expected.status);
};

export const waitForEnvelopeStatus = async (envelopeId: string, status: string, timeout = 60_000) => {
  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status, { timeout })
    .toBe(status);
};

/** The signature and seal fields of a recipient as stored, with the Signature row for the seal. */
export const readSealField = async (fieldId: number) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });
  const signature = await prisma.signature.findFirst({ where: { fieldId } });

  return { field, signature };
};

/** Every recipient signs and, through a session where they have a seal, completes. Returns when the envelope is COMPLETED. */
export const signAndCompleteAll = async (
  built: BuiltSealEnvelope,
  sessions: Record<string, SealSession>,
  anonymous: APIRequestContext,
) => {
  for (const person of built.people) {
    const ctx = sessions[person.email]?.request ?? anonymous;

    if (person.signatureFieldId !== undefined) {
      const signed = await signSignatureField(ctx, person.token, person.signatureFieldId);

      expect(signed.ok, `signature failed: ${signed.text}`).toBe(true);
    }

    if (person.sealFieldId !== undefined) {
      const applied = await applySeal(ctx, person.token, person.sealFieldId);

      expect(applied.ok, `seal application failed: ${applied.status} ${applied.text}`).toBe(true);
    }

    const completed = await completeWithToken(ctx, person.token, built.documentId);

    expect(completed.ok, `completion failed: ${completed.status} ${completed.text}`).toBe(true);
  }

  await waitForEnvelopeStatus(built.envelopeId, 'COMPLETED');
};

export const downloadVersion = async (
  request: APIRequestContext,
  apiToken: string,
  envelopeItemId: string,
  version: 'original' | 'signed' | 'pending',
) => {
  const res = await request.get(`${API_V2}/envelope/item/${envelopeItemId}/download?version=${version}`, {
    headers: authHeader(apiToken),
  });

  expect(res.status(), `download ?version=${version}: ${res.status()}`).toBe(200);

  return new Uint8Array(await res.body());
};

// ---------------------------------------------------------------------------
// Poppler
// ---------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-company-seals-'));

let tempCounter = 0;

const writeTemp = (bytes: Uint8Array, name: string) => {
  tempCounter += 1;

  const file = path.join(workDir, `${process.pid}-${tempCounter}-${name}`);

  fs.writeFileSync(file, bytes);

  return file;
};

export const pdfText = (bytes: Uint8Array) => {
  const file = writeTemp(bytes, 'text.pdf');
  const result = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`pdftotext failed: ${result.stderr}`);
  }

  return result.stdout;
};

/**
 * Page text in reading order, with runs of whitespace collapsed, for matching
 * phrases that wrap. Without -layout, so a wrapped table cell reads as one run.
 */
export const flatPdfText = (bytes: Uint8Array) => {
  const file = writeTemp(bytes, 'flat.pdf');
  const result = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`pdftotext failed: ${result.stderr}`);
  }

  return result.stdout.replace(/\s+/g, ' ');
};

export type FieldBox = { positionX: number; positionY: number; width: number; height: number };

export type AreaStats = {
  /** Share of the field's pixels that are the test disc's blue. */
  blueRatio: number;
  /** Share that are the red disc. */
  redRatio: number;
  /** Blue pixels in a 6 px ring just outside the field. */
  blueOutside: number;
  /** The bounding box of blue pixels inside the field, in pixels, and the field's own size. */
  blueBox: { width: number; height: number } | undefined;
  fieldPixels: { width: number; height: number };
};

const isBlue = (r: number, g: number, b: number) => b > 180 && r < 90 && g < 90;
const isRed = (r: number, g: number, b: number) => r > 180 && g < 90 && b < 90;

/** Renders page 1 with pdftoppm and counts the test disc's pixels inside and around a field. */
export const analyseFieldArea = async (pdf: Uint8Array, box: FieldBox, dpi = 100): Promise<AreaStats> => {
  const file = writeTemp(pdf, 'render.pdf');
  const prefix = path.join(workDir, `${process.pid}-render-${++tempCounter}`);

  execFileSync('pdftoppm', ['-r', String(dpi), '-f', '1', '-l', '1', '-png', '-singlefile', file, prefix], {
    stdio: 'pipe',
  });

  const { data, info } = await sharp(`${prefix}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const x0 = Math.round((box.positionX / 100) * info.width);
  const y0 = Math.round((box.positionY / 100) * info.height);
  const w = Math.round((box.width / 100) * info.width);
  const h = Math.round((box.height / 100) * info.height);
  const margin = 6;

  let blue = 0;
  let red = 0;
  let blueOutside = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;

  for (let y = Math.max(0, y0 - margin); y < Math.min(info.height, y0 + h + margin); y += 1) {
    for (let x = Math.max(0, x0 - margin); x < Math.min(info.width, x0 + w + margin); x += 1) {
      const i = (y * info.width + x) * info.channels;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      const inside = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;

      if (inside) {
        if (isBlue(r, g, b)) {
          blue += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        } else if (isRed(r, g, b)) {
          red += 1;
        }
      } else if (isBlue(r, g, b)) {
        blueOutside += 1;
      }
    }
  }

  return {
    blueRatio: blue / (w * h),
    redRatio: red / (w * h),
    blueOutside,
    blueBox: maxX >= 0 ? { width: maxX - minX + 1, height: maxY - minY + 1 } : undefined,
    fieldPixels: { width: w, height: h },
  };
};

// ---------------------------------------------------------------------------
// Mail catcher
// ---------------------------------------------------------------------------

/** Messages in an inbucket mailbox; the mailbox name is the address's local part. */
export const mailboxMessages = async (address: string) => {
  const name = address.split('@')[0].toLowerCase();
  const res = await fetch(`${SEAL_ENV.mailApiUrl}/api/v1/mailbox/${encodeURIComponent(name)}`);

  if (res.status === 404) {
    return [];
  }

  expect(res.ok, `the mail catcher at ${SEAL_ENV.mailApiUrl} did not answer: ${res.status}`).toBe(true);

  return (await res.json()) as Array<{ subject: string }>;
};

/** Fails if the mail catcher is not the one the server sends to, so "no mail" cannot pass vacuously. */
export const expectMailCatcherReachable = async () => {
  const res = await fetch(`${SEAL_ENV.mailApiUrl}/api/v1/mailbox/probe-${Date.now()}`);

  expect(res.status === 200 || res.status === 404, `mail catcher at ${SEAL_ENV.mailApiUrl}: ${res.status}`).toBe(true);
};

// ---------------------------------------------------------------------------
// The common starting point: an organisation, a seal and a sent envelope
// ---------------------------------------------------------------------------

/**
 * A manager creates a blue-disc seal and the owner sends an envelope whose
 * only recipient is the organisation's MEMBER, with a SIGNATURE field and a
 * seal field.
 */
export const setupMemberSeal = async (
  signIn: (email: string) => Promise<SealSession>,
  request: APIRequestContext,
  options: {
    pdf?: { name: string; data: Buffer };
    sealBox?: SealRecipientInput['sealBox'];
    meta?: Record<string, unknown>;
    sealImage?: SealImage;
  } = {},
) => {
  const world = await seedSealWorld();
  const manager = await signIn(world.manager.email);
  const seal = await createBlueSeal(manager, world.organisation.id, { image: options.sealImage });

  const built = await buildSealEnvelope(request, world, {
    pdf: options.pdf,
    meta: options.meta,
    recipients: [{ email: world.member.email, sealId: seal.id, sealBox: options.sealBox }],
  });

  return { world, manager, seal, built, person: built.personByEmail(world.member.email) };
};

/** Removes a member from the organisation as an owner would, through the application's own route. */
export const removeFromOrganisation = async (world: SealWorld, ownerSession: SealSession, userId: number) => {
  const membership = await prisma.organisationMember.findFirstOrThrow({
    where: { userId, organisationId: world.organisation.id },
  });

  const result = await trpcCall(ownerSession.request, SEAL_PROCEDURES.removeMember, {
    organisationId: world.organisation.id,
    organisationMemberId: membership.id,
  });

  expect(result.ok, `removing the member failed: ${result.status} ${result.text}`).toBe(true);
};

/** The PNG a recipient's seal Signature row holds, decoded, or undefined if there is none. */
export const snapshotOf = (signature: { signatureImageAsBase64: string | null } | null) => {
  const prefix = 'data:image/png;base64,';

  if (!signature?.signatureImageAsBase64?.startsWith(prefix)) {
    return undefined;
  }

  return Buffer.from((signature.signatureImageAsBase64 as string).slice(prefix.length), 'base64');
};

export const errorCodeOf = (body: unknown) => {
  const parsed = body as { code?: string; data?: { code?: string } };

  // API v2 REST errors put the tRPC code at the top level and the app's code in data.code.
  return parsed?.data?.code ?? parsed?.code;
};
