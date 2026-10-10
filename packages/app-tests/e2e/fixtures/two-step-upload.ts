/**
 * Fixtures for the two-step upload specs: create a document through
 * a route that returns a presigned PUT URL, upload to it, and then look at what
 * the send did to the stored object, the DocumentData row and the bytes a
 * recipient is served.
 *
 * Everything is observed from outside the code under test. Objects are read
 * and listed in MinIO with the same credentials the server uses, rows are read
 * with Prisma, and the recipient PDF is fetched from the token route a signer's
 * browser uses.
 *
 * Marker PDFs carry a unique run-time string on every page, so a test can tell
 * its own bytes from any other test's in a shared bucket, and can tell the
 * original upload from a replacement by what pdftotext reads off the page.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { addressFor, jsonHeaders, uniqueLocalPart, V1_URL } from './send-path';

const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();

export type TwoStep = {
  documentId: number;
  recipientId: number;
  fieldId: number;
  uploadUrl: string;
  localPart: string;
};

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export const uniqueMarker = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

/**
 * A small, valid, unencrypted PDF whose every page shows `marker` and the page
 * number. Built here so a test can have as many distinct files as it needs.
 */
export const buildMarkerPdf = (marker: string, pages = 1) => {
  const objects: string[] = [];
  const pageObjectIds = Array.from({ length: pages }, (_, index) => 4 + index * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pageObjectIds.forEach((id, index) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${marker} page ${index + 1}) Tj ET`;

    objects[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefAt = body.length;

  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;

  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }

  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(body, 'latin1');
};

/** The marker PDF with owner restrictions (opens without a password, forbids edits), as a signing tool leaves it. */
export const buildOwnerRestrictedMarkerPdf = (marker: string, pages = 1) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-two-step-'));
  const input = path.join(dir, 'in.pdf');
  const output = path.join(dir, 'out.pdf');

  fs.writeFileSync(input, buildMarkerPdf(marker, pages));
  execFileSync(
    'qpdf',
    [
      '--encrypt',
      '',
      'owner-secret-37',
      '256',
      '--modify=none',
      '--extract=n',
      '--annotate=n',
      '--assemble=n',
      '--',
      input,
      output,
    ],
    { stdio: 'pipe' },
  );

  return fs.readFileSync(output);
};

// ---------------------------------------------------------------------------
// Two-step creation through API v1
// ---------------------------------------------------------------------------

export const putPdf = async (request: APIRequestContext, uploadUrl: string, file: Buffer) => {
  const res = await request.put(uploadUrl, { headers: { 'Content-Type': 'application/pdf' }, data: file });

  expect(res.ok(), `PUT to the upload URL: ${res.status()} ${await res.text()}`).toBe(true);
};

export const addSignatureField = async (
  request: APIRequestContext,
  token: string,
  documentId: number,
  recipientId: number,
) => {
  const field = await request.post(`${V1_URL}/documents/${documentId}/fields`, {
    headers: jsonHeaders(token),
    data: {
      recipientId,
      type: FieldType.SIGNATURE,
      pageNumber: 1,
      pageX: 10,
      pageY: 10,
      pageWidth: 20,
      pageHeight: 5,
      fieldMeta: { type: 'signature' },
    },
  });
  const text = await field.text();

  expect(field.status(), `adding the signature field: ${text}`).toBe(200);

  const fields = (JSON.parse(text) as { fields: { id: number } | Array<{ id: number }> }).fields;

  return Array.isArray(fields) ? fields[0].id : fields.id;
};

/** Create with no file, upload to the returned URL, give the signer a signature field. */
export const createTwoStep = async (
  request: APIRequestContext,
  token: string,
  label: string,
  file: Buffer,
  options: { formValues?: Record<string, string | boolean | number> } = {},
): Promise<TwoStep> => {
  const localPart = uniqueLocalPart(label);
  const res = await request.post(`${V1_URL}/documents`, {
    headers: jsonHeaders(token),
    data: {
      title: label,
      recipients: [{ name: 'Send Path Signer', email: addressFor(localPart), role: 'SIGNER' }],
      ...(options.formValues ? { formValues: options.formValues } : {}),
    },
  });
  const text = await res.text();

  expect(res.status(), `POST /api/v1/documents: ${text}`).toBe(200);

  const body = JSON.parse(text) as {
    uploadUrl: string;
    documentId: number;
    recipients: Array<{ recipientId: number }>;
  };

  await putPdf(request, body.uploadUrl, file);

  const recipientId = body.recipients[0].recipientId;
  const fieldId = await addSignatureField(request, token, body.documentId, recipientId);

  return { documentId: body.documentId, recipientId, fieldId, uploadUrl: body.uploadUrl, localPart };
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export const envelopeOf = async (documentId: number) =>
  await prisma.envelope.findFirstOrThrow({
    where: { secondaryId: `document_${documentId}` },
    include: { envelopeItems: { include: { documentData: true } }, recipients: true },
  });

export const documentDataOf = async (documentId: number) =>
  (await envelopeOf(documentId)).envelopeItems[0].documentData;

/** DocumentData rows minted for the team that no envelope item points at. */
export const countUnattachedRows = async (teamId: number) =>
  await prisma.documentData.count({ where: { teamId, envelopeItem: null } });

export const rowsNamingKey = async (key: string) =>
  await prisma.documentData.findMany({ where: { OR: [{ data: key }, { initialData: key }] } });

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

const BUCKET = process.env.NEXT_PRIVATE_UPLOAD_BUCKET ?? 'documenso';

const s3 = new S3Client({
  endpoint: process.env.NEXT_PRIVATE_UPLOAD_ENDPOINT,
  region: process.env.NEXT_PRIVATE_UPLOAD_REGION || 'us-east-1',
  forcePathStyle: process.env.NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY ?? '',
  },
});

/** The object key a path-style presigned URL writes: its path, minus the leading bucket segment. */
export const keyOfUploadUrl = (uploadUrl: string) => {
  const segments = decodeURIComponent(new URL(uploadUrl).pathname).split('/').filter(Boolean);

  expect(segments[0], 'the upload URL is path-style, with the bucket first').toBe(BUCKET);

  return segments.slice(1).join('/');
};

/** The object's bytes, or the HTTP status MinIO answered with when it cannot be read. */
export const readObject = async (key: string): Promise<{ status: 200; bytes: Buffer } | { status: number }> => {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

    const body = res.Body;

    if (!body) {
      throw new Error(`object ${key} has no body`);
    }

    return { status: 200, bytes: Buffer.from(await body.transformToByteArray()) };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

    if (!status) {
      throw error;
    }

    return { status };
  }
};

export const listObjects = async () => {
  const objects: Array<{ key: string; size: number }> = [];
  let token: string | undefined;

  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));

    for (const object of page.Contents ?? []) {
      objects.push({ key: object.Key ?? '', size: object.Size ?? 0 });
    }

    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return objects;
};

/** Every key in the bucket whose bytes are exactly `bytes`. Only same-sized objects are fetched. */
export const keysHoldingBytes = async (bytes: Uint8Array) => {
  const digest = sha256(bytes);
  const keys: string[] = [];

  for (const object of await listObjects()) {
    if (object.size !== bytes.length) {
      continue;
    }

    const read = await readObject(object.key);

    if (read.status === 200 && sha256((read as { bytes: Buffer }).bytes) === digest) {
      keys.push(object.key);
    }
  }

  return keys;
};

/** The bytes the stored document currently has (`data`) or had on arrival (`initialData`). */
export const storedBytes = async (documentId: number, column: 'data' | 'initialData') => {
  const row = await documentDataOf(documentId);

  return new Uint8Array(await getFileServerSide({ type: row.type, data: row[column] }));
};

// ---------------------------------------------------------------------------
// The recipient's PDF
// ---------------------------------------------------------------------------

/** What the signing page's PDF viewer is served for the document, `current` or `initial`. */
export const fetchRecipientPdf = async (
  request: APIRequestContext,
  documentId: number,
  recipientId: number,
  version: 'current' | 'initial',
) => {
  const envelope = await envelopeOf(documentId);
  const recipient = envelope.recipients.find((r) => r.id === recipientId);

  if (!recipient) {
    throw new Error(`recipient ${recipientId} is not on document ${documentId}`);
  }

  const item = envelope.envelopeItems[0];
  const url = `${WEBAPP_URL}/api/files/token/${recipient.token}/envelope/${envelope.id}/envelopeItem/${item.id}/dataId/${item.documentDataId}/${version}/item.pdf`;
  const res = await request.get(url);

  expect(res.status(), `recipient PDF route (${version}): ${res.status()} ${url}`).toBe(200);

  return new Uint8Array(await res.body());
};
