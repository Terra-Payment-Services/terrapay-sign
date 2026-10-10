import { env } from '@documenso/lib/utils/env';
import {
  assertEmbeddedSignaturesIntact,
  EmbeddedSignatureBrokenError,
} from '@documenso/signing/helpers/embedded-signatures';
import { PDF } from '@libpdf/core';
import { DocumentDataType } from '@prisma/client';
import { base64 } from '@scure/base';
import { match } from 'ts-pattern';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { DocumentDataOwner } from '../../server-only/document-data/create-document-data';
import { createDocumentData } from '../../server-only/document-data/create-document-data';
import { normalizePdf } from '../../server-only/pdf/normalize-pdf';
import { uploadS3File } from './server-actions';

type File = {
  name: string;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type PutPdfOptions = {
  /** Who the stored bytes belong to. Every route through here has to say. */
  owner: DocumentDataOwner;
  initialData?: string;
};

/**
 * Uploads a document file to the appropriate storage location and creates
 * a document data record.
 *
 * The file is parsed once; the storage signature check reuses that parse.
 */
export const putPdfFileServerSide = async (file: File, { owner, initialData }: PutPdfOptions) => {
  const arrayBuffer = await file.arrayBuffer();

  const pdf = await PDF.load(new Uint8Array(arrayBuffer)).catch((e) => {
    console.error(`PDF upload parse error: ${e.message}`);

    throw new AppError('INVALID_DOCUMENT_FILE');
  });

  // Owner-protected files open without a password and are accepted, as in
  // `normalizePdf`. Sealing stores through here, so refusing them would leave a
  // signed envelope that can never be sealed.
  if (pdf.isEncrypted && !pdf.isAuthenticated) {
    throw new AppError(AppErrorCode.PASSWORD_PROTECTED_DOCUMENT);
  }

  if (!file.name.endsWith('.pdf')) {
    file.name = `${file.name}.pdf`;
  }

  // The bytes read above are the ones parsed, so they are also the ones checked
  // and stored, rather than whatever a second read of `file` returns.
  const { type, data } = await putFileServerSide(
    { name: file.name, type: file.type, arrayBuffer: async () => Promise.resolve(arrayBuffer) },
    pdf,
  );

  const createdData = await createDocumentData({ type, data, initialData, owner });

  return {
    documentData: createdData,
    filePageCount: pdf.getPageCount(),
  };
};

/**
 * Uploads a pdf file and normalizes it.
 */
export const putNormalizedPdfFileServerSide = async (
  file: File,
  options: { owner: DocumentDataOwner; flattenForm?: boolean },
) => {
  const buffer = Buffer.from(await file.arrayBuffer());

  const normalized = await normalizePdf(buffer, { flattenForm: options.flattenForm });

  const fileName = file.name.endsWith('.pdf') ? file.name : `${file.name}.pdf`;

  const documentData = await putFileServerSide({
    name: fileName,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(normalized),
  });

  return await createDocumentData({
    type: documentData.type,
    data: documentData.data,
    owner: options.owner,
  });
};

/**
 * Uploads a file to the appropriate storage location.
 *
 * Every document reaching storage passes through here, which is why the
 * signature check sits here rather than at each caller. Four separate routes
 * were found reaching storage having rewritten a signed PDF, and each was a
 * step somebody added without knowing this mattered. Guarding the callers
 * means guarding the ones that exist today.
 *
 * @param file the file to store.
 * @param loaded optionally, the file's bytes already parsed and not modified
 *   since, so a caller that has loaded the PDF does not have it parsed again.
 *   `file.arrayBuffer()` must return those same bytes on every call.
 */
export const putFileServerSide = async (file: File, loaded?: PDF) => {
  const NEXT_PUBLIC_UPLOAD_TRANSPORT = env('NEXT_PUBLIC_UPLOAD_TRANSPORT');

  await assertNoSignatureWasBroken(file, loaded);

  return await match(NEXT_PUBLIC_UPLOAD_TRANSPORT)
    .with('s3', async () => putFileInObjectStorage(file))
    .with('azure-blob', async () => putFileInObjectStorage(file))
    .otherwise(async () => putFileInDatabase(file));
};

/**
 * Refuse to store a PDF whose existing signatures no longer cover it.
 *
 * Only PDFs are examined, by their header rather than by their declared type,
 * so a branding logo or anything else passes straight through. A file that
 * does not parse is not this function's problem and is rejected elsewhere.
 * `loaded`, when given, is the file's bytes already parsed and is reused.
 */
const assertNoSignatureWasBroken = async (file: File, loaded?: PDF) => {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    return;
  }

  try {
    await assertEmbeddedSignaturesIntact(bytes, loaded);
  } catch (error) {
    if (!(error instanceof EmbeddedSignatureBrokenError)) {
      throw error;
    }

    // Surfaced as a refusal the caller already knows how to show, rather than
    // as an unhandled error. Refusing is the documented behaviour, so it has
    // to look like a refusal and not like a crash. The detail goes to the log
    // because it names which signature and why, and the operator is the one
    // who can act on that.
    console.error(`Refusing to store a document with a broken signature: ${error.message}`);

    throw new AppError('INVALID_DOCUMENT_FILE', {
      message: 'This document carries a signature that would be invalidated by storing it',
    });
  }
};

const putFileInDatabase = async (file: File) => {
  const contents = await file.arrayBuffer();

  const binaryData = new Uint8Array(contents);

  const asciiData = base64.encode(binaryData);

  return {
    type: DocumentDataType.BYTES_64,
    data: asciiData,
  };
};

const putFileInObjectStorage = async (file: File) => {
  const buffer = await file.arrayBuffer();

  const blob = new Blob([buffer], { type: file.type });

  const newFile = new File([blob], file.name, {
    type: file.type,
  });

  const { key } = await uploadS3File(newFile);

  return {
    type: DocumentDataType.S3_PATH,
    data: key,
  };
};
