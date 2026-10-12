/**
 * Fixtures for the unattached DocumentData specs.
 *
 * Everything is observed from outside the code under test: rows are read with
 * Prisma, bytes with `getFileServerSide`, the recipient's PDF from the token
 * route a signer's browser uses, and objects from MinIO with the server's own
 * credentials. Nothing here calls a function under test.
 *
 * "Unattached" is a DocumentData row that no EnvelopeItem names through
 * `documentDataId`. A test owns every row its fresh user or team created, so
 * rows are counted by `userId` or `teamId`; the plain upload route records the
 * user and no team, and a count by team alone would miss those rows.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { type DocumentStatus, EnvelopeType, FieldType } from '@prisma/client';

import { type ApiSeedContext, apiCreateTestContext, apiGetEnvelope } from './api-seeds';
import { apiSignin } from './authentication';
import { readPageTextWithPdftotext, trpcMutation } from './protected-pdfs';
import { buildMarkerPdf, uniqueMarker } from './two-step-upload';

export { buildMarkerPdf, listObjects, readObject, uniqueMarker } from './two-step-upload';

export const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();
export const V1 = `${WEBAPP_URL}/api/v1`;
export const V2 = `${WEBAPP_URL}/api/v2-beta`;

export const UPLOAD_TRANSPORT = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT || 'database';
export const IS_S3 = UPLOAD_TRANSPORT === 's3';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export const uniqueEmail = (label: string) => `${label}-${randomBytes(5).toString('hex')}@test.documenso.com`;

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const jsonBearer = (token: string) => ({ ...bearer(token), 'Content-Type': 'application/json' });

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type Owner = { userId: number; teamId: number };

const ownedBy = ({ userId, teamId }: Owner) => ({ OR: [{ userId }, { teamId }] });

/** Every DocumentData row the owner's user or team created. */
export const rowsOf = async (owner: Owner) => await prisma.documentData.findMany({ where: ownedBy(owner) });

export const rowCount = async (owner: Owner) => await prisma.documentData.count({ where: ownedBy(owner) });

/** Rows of the owner that no envelope item holds. */
export const unattachedRowsOf = async (owner: Owner) =>
  await prisma.documentData.findMany({ where: { ...ownedBy(owner), envelopeItem: null } });

export const unattachedCount = async (owner: Owner) => (await unattachedRowsOf(owner)).length;

export const ownerOf = (ctx: ApiSeedContext): Owner => ({ userId: ctx.user.id, teamId: ctx.team.id });

/** The bytes a row stores in one of its two columns. */
export const bytesOfColumn = async (
  row: { type: 'BYTES_64' | 'BYTES' | 'S3_PATH'; data: string; initialData: string },
  column: 'data' | 'initialData',
) =>
  new Uint8Array(
    await getFileServerSide({ type: row.type, data: row[column] } as Parameters<typeof getFileServerSide>[0]),
  );

/** Characters held by the rows, for the database transport (`length(data) + length("initialData")`). */
export const storedCharacters = async (ids: string[]) => {
  if (ids.length === 0) {
    return 0;
  }

  const [row] = await prisma.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT sum(length(data) + length("initialData")) AS total FROM "DocumentData" WHERE id = ANY(${ids})
  `;

  return Number(row.total ?? 0);
};

export const itemsOfEnvelope = async (envelopeId: string) =>
  await prisma.envelopeItem.findMany({
    where: { envelopeId },
    orderBy: { order: 'asc' },
    include: { documentData: true },
  });

/** Joins every envelope item to its row; returns the items whose row is missing (none, when nothing was deleted wrongly). */
export const itemsWithoutRow = async () =>
  Number(
    (
      await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "EnvelopeItem" ei LEFT JOIN "DocumentData" dd ON dd.id = ei."documentDataId" WHERE dd.id IS NULL
      `
    )[0].n,
  );

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

export const pagesOf = (bytes: Uint8Array) => {
  const text = Buffer.from(bytes).toString('latin1');

  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
};

/** The text on the PDF's pages, as poppler reads it. */
export const textOf = (bytes: Uint8Array) => readPageTextWithPdftotext(bytes);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type TemplateItem = { id: string; documentDataId: string; marker: string; pages: number; bytes: Uint8Array };

export type SeededTemplate = {
  ctx: ApiSeedContext;
  owner: Owner;
  envelopeId: string;
  templateId: number;
  recipientId: number;
  items: TemplateItem[];
};

/**
 * A template of `itemCount` marker PDFs, one SIGNATURE field per item, for one
 * signer. Each PDF has its own unique marker and a different page count, so the
 * bytes behind each item can be told apart.
 */
export const seedTemplate = async (
  request: APIRequestContext,
  itemCount: number,
  options: {
    ctx?: ApiSeedContext;
    files?: Buffer[];
    label?: string;
    type?: 'TEMPLATE' | 'DOCUMENT';
    formValues?: Record<string, string | number | boolean>;
  } = {},
): Promise<SeededTemplate> => {
  const ctx = options.ctx ?? (await apiCreateTestContext(options.label ?? 'orphan-template'));
  const markers = Array.from({ length: itemCount }, (_, index) => uniqueMarker(`TPL${index}`));
  const files = options.files ?? markers.map((marker, index) => buildMarkerPdf(marker, index + 1));

  const payload = {
    type: options.type ?? 'TEMPLATE',
    formValues: options.formValues,
    title: `Orphan template ${randomBytes(3).toString('hex')}`,
    recipients: [
      {
        email: uniqueEmail('template-signer'),
        name: 'Template Signer',
        role: 'SIGNER',
        fields: files.map((_, index) => ({
          type: 'SIGNATURE',
          identifier: index,
          page: 1,
          positionX: 10,
          positionY: 60,
          width: 30,
          height: 8,
        })),
      },
    ],
  };

  const formData = new FormData();

  formData.append('payload', JSON.stringify(payload));
  for (const [index, file] of files.entries()) {
    formData.append('files', new File([file], `template-item-${index}.pdf`, { type: 'application/pdf' }));
  }

  const res = await request.post(`${V2}/envelope/create`, { headers: bearer(ctx.token), multipart: formData });

  expect(res.ok(), `envelope/create (template): ${await res.text()}`).toBeTruthy();

  const { id: envelopeId } = (await res.json()) as { id: string };
  const envelope = await apiGetEnvelope(request, ctx.token, envelopeId);
  const stored = await itemsOfEnvelope(envelopeId);

  expect(stored, 'premise: the template holds one item per file').toHaveLength(itemCount);

  const items = await Promise.all(
    stored.map(async (item, index) => ({
      id: item.id,
      documentDataId: item.documentDataId,
      marker: markers[index],
      pages: index + 1,
      bytes: await bytesOfColumn(item.documentData, 'data'),
    })),
  );

  return {
    ctx,
    owner: ownerOf(ctx),
    envelopeId,
    templateId: Number(envelope.secondaryId.replace(/^(template|document)_/, '')),
    recipientId: envelope.recipients[0].id,
    items,
  };
};

/** A DRAFT document of `itemCount` marker PDFs, one signer, one SIGNATURE field per item. The `templateId` is the document id. */
export const seedDraft = async (
  request: APIRequestContext,
  itemCount: number,
  options: {
    ctx?: ApiSeedContext;
    files?: Buffer[];
    label?: string;
    formValues?: Record<string, string | number | boolean>;
  } = {},
) => await seedTemplate(request, itemCount, { ...options, type: 'DOCUMENT' });

// ---------------------------------------------------------------------------
// Using a template, through each caller
// ---------------------------------------------------------------------------

export type UseOptions = {
  email: string;
  formValues?: Record<string, string | number | boolean>;
  customDocumentDataId?: string;
};

/** Documents created for a signer email, newest last. */
export const documentsFor = async (teamId: number, email: string) =>
  await prisma.envelope.findMany({
    where: { teamId, type: EnvelopeType.DOCUMENT, recipients: { some: { email } } },
    orderBy: { createdAt: 'asc' },
    include: { recipients: true, envelopeItems: { orderBy: { order: 'asc' }, include: { documentData: true } } },
  });

export type UseCaller = {
  name: string;
  /** Whether the route can use a template with more than one item. */
  multiItem: boolean;
  use: (request: APIRequestContext, tpl: SeededTemplate, options: UseOptions) => Promise<void>;
};

const expectOk = async (res: Awaited<ReturnType<APIRequestContext['post']>>, what: string) =>
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBeTruthy();

export const USE_CALLERS: UseCaller[] = [
  {
    name: 'API v1 generate-document',
    multiItem: false,
    use: async (request, tpl, { email, formValues }) => {
      const res = await request.post(`${V1}/templates/${tpl.templateId}/generate-document`, {
        headers: jsonBearer(tpl.ctx.token),
        data: { title: 'From template', recipients: [{ id: tpl.recipientId, email, name: 'Signer' }], formValues },
      });

      await expectOk(res, 'POST /api/v1/templates/:id/generate-document');
    },
  },
  {
    name: 'API v1 create-document',
    multiItem: false,
    use: async (request, tpl, { email, formValues }) => {
      const res = await request.post(`${V1}/templates/${tpl.templateId}/create-document`, {
        headers: jsonBearer(tpl.ctx.token),
        data: { title: 'From template', recipients: [{ email, name: 'Signer' }], formValues },
      });

      await expectOk(res, 'POST /api/v1/templates/:id/create-document');
    },
  },
  {
    name: 'API v2 envelope/use',
    multiItem: true,
    use: async (request, tpl, { email, formValues }) => {
      const formData = new FormData();

      formData.append(
        'payload',
        JSON.stringify({ envelopeId: tpl.envelopeId, recipients: [{ id: tpl.recipientId, email }], formValues }),
      );

      const res = await request.post(`${V2}/envelope/use`, { headers: bearer(tpl.ctx.token), multipart: formData });

      await expectOk(res, 'POST /api/v2-beta/envelope/use');
    },
  },
  {
    name: 'API v2 template/use',
    multiItem: true,
    use: async (request, tpl, { email, formValues, customDocumentDataId }) => {
      const res = await request.post(`${V2}/template/use`, {
        headers: jsonBearer(tpl.ctx.token),
        data: {
          templateId: tpl.templateId,
          recipients: [{ id: tpl.recipientId, email }],
          formValues,
          customDocumentDataId,
        },
      });

      await expectOk(res, 'POST /api/v2-beta/template/use');
    },
  },
];

/**
 * Bulk send of a template through the page's tRPC route, which queues a job the
 * server runs in the background. Resolves when `recipientEmails.length`
 * documents exist for the team.
 */
export const bulkSend = async (page: Page, tpl: SeededTemplate, recipientEmails: string[]) => {
  await apiSignin({ page, email: tpl.ctx.user.email });

  const csv = ['recipient_1_email,recipient_1_name', ...recipientEmails.map((email) => `${email},Bulk Recipient`)].join(
    '\n',
  );

  const res = await page.request.post(`${WEBAPP_URL}/api/trpc/template.uploadBulkSend`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({
      json: { templateId: tpl.templateId, teamId: tpl.ctx.team.id, csv, sendImmediately: false },
    }),
  });

  await expectOk(res, 'template.uploadBulkSend');

  await expect
    .poll(
      async () =>
        await prisma.envelope.count({
          where: {
            teamId: tpl.ctx.team.id,
            type: EnvelopeType.DOCUMENT,
            recipients: { some: { email: { in: recipientEmails } } },
          },
        }),
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(recipientEmails.length);
};

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** POST /api/files/upload-pdf as the signed-in user; returns the DocumentData the route created. */
export const uploadPdf = async (page: Page, file: Buffer, name = 'upload.pdf') => {
  const formData = new FormData();

  formData.append('file', new File([file], name, { type: 'application/pdf' }));

  const res = await page.context().request.post(`${WEBAPP_URL}/api/files/upload-pdf`, { multipart: formData });

  expect(res.status(), `upload-pdf: ${await res.text()}`).toBe(200);

  return (await res.json()) as { id: string; type: string; data: string; initialData: string };
};

// ---------------------------------------------------------------------------
// Sending, signing, sealing
// ---------------------------------------------------------------------------

export const distribute = async (request: APIRequestContext, token: string, envelopeId: string) => {
  const res = await request.post(`${V2}/envelope/distribute`, { headers: jsonBearer(token), data: { envelopeId } });

  await expectOk(res, 'envelope/distribute');

  return (await res.json()) as { recipients: Array<{ id: number; email: string; token: string; signingUrl: string }> };
};

/** Signs every SIGNATURE field of a recipient and completes the document, as the recipient's own endpoints do. */
export const signAndComplete = async (
  request: APIRequestContext,
  recipientToken: string,
  fieldIds: number[],
  documentId: number,
) => {
  for (const fieldId of fieldIds) {
    await trpcMutation(request, 'envelope.field.sign', {
      token: recipientToken,
      fieldId,
      fieldValue: { type: FieldType.SIGNATURE, value: 'Signer' },
    });
  }

  await trpcMutation(request, 'recipient.completeDocumentWithToken', { token: recipientToken, documentId });
};

export const waitForStatus = async (envelopeId: string, status: DocumentStatus) =>
  await expect(async () => {
    expect((await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status).toBe(status);
  }).toPass({ timeout: 90_000 });

/** An administrator asks for a reseal; resolves when the item names a different row. */
export const resealAsAdmin = async (page: Page, adminEmail: string, envelopeId: string, itemId: string) => {
  const before = (await prisma.envelopeItem.findUniqueOrThrow({ where: { id: itemId } })).documentDataId;

  await apiSignin({ page, email: adminEmail });

  const res = await page.request.post(`${WEBAPP_URL}/api/trpc/admin.document.reseal`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: { id: envelopeId } }),
  });

  await expectOk(res, 'admin.document.reseal');

  await expect
    .poll(async () => (await prisma.envelopeItem.findUniqueOrThrow({ where: { id: itemId } })).documentDataId, {
      timeout: 90_000,
      intervals: [1_000],
    })
    .not.toBe(before);
};

// ---------------------------------------------------------------------------
// The cleanup script (issue 41, criterion 10)
// ---------------------------------------------------------------------------

/**
 * The interface the implementer follows, stated here and at the top of the
 * cleanup spec. See cleanup-script.spec.ts.
 */
export const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../prisma/scripts/cleanup-unattached-document-data.ts');

const PRISMA_DIR = path.resolve(__dirname, '../../../prisma');

export type CleanupSummary = {
  mode: 'report' | 'commit';
  host: string;
  olderThanDays: number;
  unattached: number;
  deletable: number;
  tooYoung: number;
  nullCreatedAt: number;
  byType: Record<string, { deletable: number; tooYoung: number; nullCreatedAt: number }>;
  deleted: number;
};

export type CleanupRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The parsed `SUMMARY {json}` line, or null when the script printed none. */
  summary: CleanupSummary | null;
};

const execFileAsync = promisify(execFile);

/** Runs the script as a child process against the test database, the way an operator would. */
export const runCleanup = async (args: string[], env: Record<string, string | undefined> = {}): Promise<CleanupRun> => {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLEANUP_SCRIPT, ...args], {
      cwd: PRISMA_DIR,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });

    return { code: 0, stdout, stderr, summary: parseSummary(stdout) };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };

    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      summary: parseSummary(failure.stdout ?? ''),
    };
  }
};

const parseSummary = (stdout: string): CleanupSummary | null => {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('SUMMARY '));

  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line.slice('SUMMARY '.length)) as CleanupSummary;
  } catch {
    return null;
  }
};

/** The host the test database is on, as the script must print it. */
export const databaseHost = () => {
  const url = new URL(process.env.NEXT_PRIVATE_DATABASE_URL ?? process.env.NEXT_PRIVATE_DIRECT_DATABASE_URL ?? '');

  return url.host;
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An unattached row of the owner, created `ageMs` ago (or with a null `createdAt`).
 * A BYTES_64 row holds a marker PDF; an S3_PATH row holds a key that names no object.
 */
export const seedUnattachedRow = async (
  owner: Owner,
  ageMs: number | null,
  options: { type?: 'BYTES_64' | 'S3_PATH'; marker?: string } = {},
) => {
  const type = options.type ?? 'BYTES_64';
  const data =
    type === 'S3_PATH'
      ? `orphan-test/${uniqueMarker('KEY')}.pdf`
      : buildMarkerPdf(options.marker ?? uniqueMarker('ROW'), 1).toString('base64');

  return await prisma.documentData.create({
    data: {
      type,
      data,
      initialData: data,
      userId: owner.userId,
      teamId: owner.teamId,
      createdAt: ageMs === null ? null : new Date(Date.now() - ageMs),
    },
  });
};

export const pdfTextHas = (bytes: Uint8Array, marker: string) => textOf(bytes).includes(marker);
