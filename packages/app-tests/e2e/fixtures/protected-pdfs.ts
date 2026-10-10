/**
 * Fixtures and independent verifiers for the protected-PDF specs.
 *
 * Every fixture is built at run time from the repository's own unsigned PDF and
 * test signing certificate, so nothing binary is committed and the provenance
 * of each file is visible here.
 *
 * Encryption is done by qpdf, never by @libpdf/core. Sign reads PDFs with
 * libpdf, and a fixture written by the same library that reads it would hide
 * any bug the two share. qpdf writes, libpdf reads, poppler judges.
 *
 * The counterparty signature is applied with libpdf's P12Signer, because it is
 * the only PAdES signer available to the test process. Every signed fixture is
 * checked with poppler `pdfsig` before it is used, so a fixture that does not
 * verify fails its own precondition rather than being blamed on Sign.
 *
 * Verification goes through poppler (`pdfsig`, `pdfinfo`) reading the raw
 * bytes. Sign's own signature checks are deliberately not used as the oracle:
 * the failure this work guards against (F3) is one where they report a
 * signature intact while an independent verifier rejects it.
 *
 * Requires `qpdf` and `poppler-utils` on PATH. In CI the e2e_local job installs
 * both from the Ubuntu archive alongside its other build dependencies.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { P12Signer, PDF, StandardFonts } from '@libpdf/core';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { signSignaturePad } from './signature';

const PDF_FIXTURES = path.join(__dirname, '../../../lib/server-only/pdf/__fixtures__');

const UNSIGNED_PDF = fs.readFileSync(path.join(PDF_FIXTURES, 'unsigned.pdf'));
const SIGNING_CERT_P12 = fs.readFileSync(path.join(PDF_FIXTURES, 'signing-cert.p12'));

const OWNER_PASSWORD = 'owner-secret-24';
export const OPEN_PASSWORD = 'open-secret-24';

export const COUNTERPARTY_FIELD_NAME = 'CounterpartySignature';

export const OWNER_ONLY_ALGORITHMS = ['AES-256', 'AES-128', 'RC4-128'] as const;

export type OwnerOnlyAlgorithm = (typeof OWNER_ONLY_ALGORITHMS)[number];

const QPDF_KEY_ARGS: Record<OwnerOnlyAlgorithm, string[]> = {
  'AES-256': ['256'],
  'AES-128': ['128', '--use-aes=y'],
  'RC4-128': ['128', '--use-aes=n'],
};

/**
 * The restrictions a signing tool typically leaves on a signed PDF: it can be
 * opened and printed by anyone, but not edited, copied, annotated or
 * reassembled without the owner password.
 */
const QPDF_RESTRICTIONS = ['--modify=none', '--extract=n', '--annotate=n', '--assemble=n'];

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-protected-pdfs-'));

let tempCounter = 0;

const writeTemp = (bytes: Uint8Array, name: string) => {
  tempCounter += 1;

  const file = path.join(workDir, `${process.pid}-${tempCounter}-${name}`);

  fs.writeFileSync(file, bytes);

  return file;
};

const requireTool = (tool: string, versionArg: string) => {
  const result = spawnSync(tool, [versionArg], { encoding: 'utf8' });

  if (result.error) {
    throw new Error(
      `${tool} is not on PATH. The protected-PDF specs need qpdf and poppler-utils ` +
        `(apt-get install qpdf poppler-utils; brew install qpdf poppler).`,
    );
  }
};

/**
 * Fail loudly, never skip. A skipped spec in the red run would read as a
 * spec with nothing to say.
 */
export const assertVerifierToolsPresent = () => {
  requireTool('qpdf', '--version');
  requireTool('pdfsig', '-v');
  requireTool('pdfinfo', '-v');
  requireTool('pdftotext', '-v');
};

const qpdfEncrypt = (input: Uint8Array, args: string[], name: string) => {
  const inFile = writeTemp(input, `${name}-in.pdf`);
  const outFile = path.join(workDir, `${process.pid}-${name}-${++tempCounter}-out.pdf`);

  execFileSync('qpdf', [...args, '--', inFile, outFile], { stdio: 'pipe' });

  return fs.readFileSync(outFile);
};

const protectOwnerOnly = (input: Uint8Array, algorithm: OwnerOnlyAlgorithm) => {
  const weak = algorithm === 'RC4-128' ? ['--allow-weak-crypto'] : [];

  return qpdfEncrypt(
    input,
    [...weak, '--encrypt', '', OWNER_PASSWORD, ...QPDF_KEY_ARGS[algorithm], ...QPDF_RESTRICTIONS],
    `owner-${algorithm}`,
  );
};

const signAsCounterparty = async (input: Uint8Array, reason = 'Counterparty approval') => {
  const signer = await P12Signer.create(new Uint8Array(SIGNING_CERT_P12), '');
  const doc = await PDF.load(new Uint8Array(input));

  const { bytes } = await doc.sign({
    signer,
    fieldName: COUNTERPARTY_FIELD_NAME,
    reason,
  });

  return Buffer.from(bytes);
};

const memo = <T>(build: () => Promise<T>) => {
  let value: Promise<T> | undefined;

  return async () => {
    value ??= build();

    return await value;
  };
};

const ownerOnlyBuilders = Object.fromEntries(
  OWNER_ONLY_ALGORITHMS.map((algorithm) => [algorithm, memo(async () => protectOwnerOnly(UNSIGNED_PDF, algorithm))]),
) as Record<OwnerOnlyAlgorithm, () => Promise<Buffer>>;

const ownerOnlyThenSignedBuilders = Object.fromEntries(
  OWNER_ONLY_ALGORITHMS.map((algorithm) => [
    algorithm,
    memo(async () => await signAsCounterparty(await ownerOnlyBuilders[algorithm]())),
  ]),
) as Record<OwnerOnlyAlgorithm, () => Promise<Buffer>>;

/** An unsigned PDF that opens without a password but carries owner restrictions. */
export const buildOwnerOnlyPdf = async (algorithm: OwnerOnlyAlgorithm) => await ownerOnlyBuilders[algorithm]();

/**
 * The Acrobat/DocuSign case: an owner-restricted PDF that a counterparty then
 * signed, as an incremental update on top of the protection.
 */
export const buildOwnerOnlyThenSignedPdf = async (algorithm: OwnerOnlyAlgorithm) =>
  await ownerOnlyThenSignedBuilders[algorithm]();

/**
 * A counterparty signature applied to a plain PDF which was then protected.
 * Encrypting rewrites every byte, so this signature cannot verify, whatever
 * Sign does; pdfsig reports a digest mismatch on the fixture itself. Sign
 * must refuse it as arriving with a broken signature (criterion 17).
 */
export const buildSignedThenOwnerOnlyPdf = memo(async () =>
  protectOwnerOnly(await signAsCounterparty(UNSIGNED_PDF), 'AES-256'),
);

/** A counterparty-signed PDF with no encryption at all. */
export const buildSignedPlainPdf = memo(async () => await signAsCounterparty(UNSIGNED_PDF));

/** A PDF that needs a password to open. */
export const buildOpenPasswordPdf = memo(async () =>
  qpdfEncrypt(UNSIGNED_PDF, ['--encrypt', OPEN_PASSWORD, OWNER_PASSWORD, '256'], 'open-password'),
);

/** The repository's ordinary, unsigned, unencrypted PDF. */
export const ordinaryPdf = () => Buffer.from(UNSIGNED_PDF);

/**
 * Fresh, unmemoised copies for specs that look for their own upload in
 * storage afterwards. qpdf draws a new file ID and salt on every run, so each
 * call returns bytes no other test uploads.
 */
export const buildFreshOpenPasswordPdf = async () =>
  qpdfEncrypt(UNSIGNED_PDF, ['--encrypt', OPEN_PASSWORD, OWNER_PASSWORD, '256'], 'fresh-open-password');

export const buildFreshOwnerOnlyPdf = async (algorithm: OwnerOnlyAlgorithm) =>
  protectOwnerOnly(UNSIGNED_PDF, algorithm);

/** The placeholder a sender types for signer 1's signature, per the PDF placeholders guide. */
export const UPLOAD_SIGNATURE_PLACEHOLDER = '{{signature, r1}}';

/** A placeholder with no recipient, which the guide reserves for API placement after upload. */
export const API_SIGNATURE_PLACEHOLDER = '{{signature}}';

const buildPlaceholderPdf = async (placeholders: string[]) => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: 'letter' });

  page.drawText('Agreement between the counterparty and TerraPay', {
    x: 50,
    y: 720,
    font: StandardFonts.Helvetica,
    size: 14,
  });

  placeholders.forEach((placeholder, index) => {
    page.drawText(placeholder, { x: 50, y: 600 - index * 120, font: StandardFonts.Helvetica, size: 12 });
  });

  return Buffer.from(await pdf.save());
};

/**
 * A PDF carrying placeholder text that a counterparty then signed. With
 * `ownerOnly`, the PDF is owner-restricted before the counterparty signs, as
 * in the Acrobat/DocuSign case.
 */
export const buildCounterpartySignedPlaceholderPdf = async (
  placeholders: string[],
  options: { ownerOnly?: OwnerOnlyAlgorithm } = {},
) => {
  const base = await buildPlaceholderPdf(placeholders);
  const prepared = options.ownerOnly ? protectOwnerOnly(base, options.ownerOnly) : base;

  return await signAsCounterparty(prepared);
};

export const EMPTY_SIGNATURE_FIELD_NAME = 'EmptySignature';

/**
 * A one-page PDF with an AcroForm signature field that nobody has signed: the
 * field has no /V. Written by hand rather than by @libpdf/core, so the field
 * is not shaped by the library Sign reads with, then rewritten by qpdf so the
 * cross-reference table is qpdf's and not this function's.
 *
 * /SigFlags 1 is set: ISO 32000-1 12.7.2 defines bit 1 (SignaturesExist) as
 * "the document contains at least one signature field", which is true here,
 * signed or not. It makes the fixture the harder case for F14.
 */
const handWrittenEmptySignatureFieldPdf = () => {
  const content = 'BT /F1 18 Tf 72 700 Td (Agreement awaiting signature) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /SigFlags 1 >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R /Annots [5 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (${EMPTY_SIGNATURE_FIELD_NAME}) /Rect [72 560 272 620] /F 4 /P 3 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let body = '%PDF-1.7\n';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = body.length;

  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, 'latin1');
};

/** An unsigned PDF whose only form field is an empty signature field. */
export const buildEmptySignatureFieldPdf = memo(async () =>
  qpdfEncrypt(handWrittenEmptySignatureFieldPdf(), [], 'empty-signature-field'),
);

/** The same, linearised (fast web view) by qpdf. */
export const buildLinearisedEmptySignatureFieldPdf = memo(async () =>
  qpdfEncrypt(handWrittenEmptySignatureFieldPdf(), ['--linearize'], 'empty-signature-field-linearised'),
);

/**
 * The criterion 17 refusal code, as Ram's third-review note names it
 * (2026-10-06). Not learnt from the implementation.
 */
export const SIGNATURE_ALREADY_INVALID = 'SIGNATURE_ALREADY_INVALID';

/**
 * A counterparty-signed PDF with no encryption whose signature is already
 * broken: after signing, one byte of the binary comment on the file's second
 * line is changed. The file still parses, but the signed bytes no longer
 * match, so pdfsig reports a digest mismatch on the fixture itself.
 */
export const buildSignedThenTamperedPdf = memo(async () => {
  const signed = Buffer.from(await signAsCounterparty(UNSIGNED_PDF));
  const commentStart = signed.indexOf('\n%', 0, 'latin1') + 2;

  signed[commentStart] = signed[commentStart] === 0x58 ? 0x59 : 0x58;

  return signed;
});

/**
 * The repository's fillable-form test PDF (assets/form-fields-test.pdf, the
 * file the form-flattening spec uses), signed by the counterparty. With
 * `linearised`, qpdf linearises the form before the counterparty signs.
 */
export const FORM_FIELDS_PDF = fs.readFileSync(path.join(__dirname, '../../../../assets/form-fields-test.pdf'));

export const FORM_VALUES = {
  test_text_field: 'Hello World',
  company_name: 'TerraPay',
  accept_terms: true,
  country: 'Germany',
};

const signedFormBuilders = {
  plain: memo(async () => await signAsCounterparty(FORM_FIELDS_PDF)),
  linearised: memo(
    async () => await signAsCounterparty(qpdfEncrypt(FORM_FIELDS_PDF, ['--linearize'], 'form-linearised')),
  ),
};

export const buildCounterpartySignedFormPdf = async (variant: 'plain' | 'linearised') =>
  await signedFormBuilders[variant]();

/**
 * The signed form with a damaged tail: the form is rewritten by qpdf with
 * classic xref tables, the counterparty signs it, and an extra end-of-file
 * section is then appended whose startxref points past the end of the file. A reader must recover the file by scanning it, while the
 * counterparty signature, whose /ByteRange ends before the appended bytes,
 * still verifies under pdfsig.
 */
export const buildCounterpartySignedFormPdfNeedingRecovery = memo(async () => {
  // Classic xref tables and no object streams, so that a reader scanning the
  // file can find every object and the trailer, as recovery needs.
  const classic = qpdfEncrypt(FORM_FIELDS_PDF, ['--object-streams=disable'], 'form-classic-xref');
  const signed = await signAsCounterparty(classic);

  return Buffer.concat([signed, Buffer.from('\nstartxref\n987654321\n%%EOF\n', 'latin1')]);
});

/** qpdf's --check report and exit status (0 clean, 2 errors, 3 warnings only). */
export const qpdfCheck = (bytes: Uint8Array) => {
  const file = writeTemp(bytes, 'qpdf-check.pdf');
  const result = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });

  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

export const MALFORMED_SIGNATURE_KINDS = [
  'byterange-missing',
  'byterange-wrong-length',
  'byterange-out-of-range',
  'byterange-overlapping',
  'contents-not-cms',
] as const;

export type MalformedSignatureKind = (typeof MALFORMED_SIGNATURE_KINDS)[number];

/**
 * The counterparty-signed plain PDF with its signature made impossible to
 * evaluate (criterion 22). Each edit is made in place and keeps the byte
 * length, so every xref offset stays right and the file still parses:
 *
 * - byterange-missing: the /ByteRange key is renamed, so the field has none;
 * - byterange-wrong-length: the array has three numbers instead of four;
 * - byterange-out-of-range: the second range runs past the end of the file;
 * - byterange-overlapping: the first range runs into the second;
 * - contents-not-cms: the signature's /Contents hex, the gap the /ByteRange
 *   leaves, is replaced by hex of the same length that is not DER, so every
 *   signed byte is unchanged.
 */
export const buildMalformedSignaturePdf = async (kind: MalformedSignatureKind) => {
  const bytes = Buffer.from(await buildSignedPlainPdf());
  const text = bytes.toString('latin1');
  const match = /\/ByteRange\s*\[([^\]]*)\]/.exec(text);

  if (!match) {
    throw new Error('fixture: no /ByteRange in the signed PDF');
  }

  const [a, b, c, d] = match[1].trim().split(/\s+/).map(Number);
  const arrayStart = match.index + match[0].indexOf('[');
  const arrayLength = match[0].length - match[0].indexOf('[');

  const writeArray = (numbers: number[]) => {
    const array = `[${numbers.join(' ')}]`;

    if (array.length > arrayLength) {
      throw new Error(`fixture: ${array} does not fit in ${arrayLength} bytes`);
    }

    bytes.write(array.padEnd(arrayLength, ' '), arrayStart, 'latin1');
  };

  switch (kind) {
    case 'byterange-missing':
      bytes.write('/NoByteRng', match.index, 'latin1');
      break;
    case 'byterange-wrong-length':
      writeArray([a, b, c]);
      break;
    case 'byterange-out-of-range':
      writeArray([a, b, c, d + 100_000]);
      break;
    case 'byterange-overlapping':
      writeArray([a, c + 10, c, d]);
      break;
    case 'contents-not-cms': {
      // The signature's /Contents hex string is exactly the gap the
      // /ByteRange leaves: bytes [a + b, c), from '<' to '>'.
      const gapStart = a + b;
      const gapEnd = c;

      if (bytes[gapStart] !== 0x3c || bytes[gapEnd - 1] !== 0x3e) {
        throw new Error('fixture: the /ByteRange gap is not the /Contents hex string');
      }

      const hexLength = gapEnd - gapStart - 2;

      bytes.write('DEADBEEF'.repeat(Math.ceil(hexLength / 8)).slice(0, hexLength), gapStart + 1, 'latin1');
      break;
    }
  }

  return bytes;
};

/** The text poppler's pdftotext extracts from every page, for checking flattened form values. */
export const readPageTextWithPdftotext = (bytes: Uint8Array) => {
  const file = writeTemp(bytes, 'pdftotext.pdf');
  const result = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`pdftotext failed: ${result.stderr}`);
  }

  return result.stdout;
};

/** The signature's /ByteRange and the two signed byte ranges it names. */
export const readByteRange = (bytes: Uint8Array) => {
  const text = Buffer.from(bytes).toString('latin1');
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);

  if (!match) {
    throw new Error('no four-number /ByteRange in the PDF');
  }

  const [a, b, c, d] = match.slice(1).map(Number);
  const signed = Buffer.concat([Buffer.from(bytes.subarray(a, a + b)), Buffer.from(bytes.subarray(c, c + d))]);

  return { a, b, c, d, signed, contentsHex: text.slice(a + b + 1, c - 1) };
};

/**
 * The length of the DER encoding at the start of a /Contents hex string,
 * from its outer SEQUENCE header, so the zero padding after it is not read
 * as part of the signature.
 */
export const derLengthOfContents = (contentsHex: string) => {
  const der = Buffer.from(contentsHex, 'hex');

  if (der[0] !== 0x30) {
    throw new Error('the /Contents does not start with a DER SEQUENCE');
  }

  if (der[1] < 0x80) {
    return 2 + der[1];
  }

  const lengthBytes = der[1] & 0x7f;

  return 2 + lengthBytes + der.subarray(2, 2 + lengthBytes).reduce((total, byte) => total * 256 + byte, 0);
};

/** The last byte of the counterparty signature's DER, ignoring the /Contents padding. */
export const lastDerByteOfSignature = (bytes: Uint8Array) => {
  const { contentsHex } = readByteRange(bytes);
  const length = derLengthOfContents(contentsHex);

  return Buffer.from(contentsHex, 'hex')[length - 1];
};

/**
 * A counterparty-signed plain PDF whose CMS signature's DER ends in 0x00, the
 * case about one signature in 256 hits. The reason string is varied until the
 * signature's last byte is 0x00, so the fixture is the same kind of file every
 * run, whatever the random outcome of any single signing.
 */
export const buildSignedPlainPdfWithDerEndingInZero = memo(async () => {
  for (let attempt = 0; attempt < 4096; attempt++) {
    const signed = await signAsCounterparty(UNSIGNED_PDF, `Counterparty approval ${attempt}`);

    if (lastDerByteOfSignature(signed) === 0x00) {
      return signed;
    }
  }

  throw new Error('fixture: no signature with a DER ending in 0x00 in 4096 attempts');
});

/**
 * A counterparty-signed PDF whose CMS SignerInfo signature value is corrupted
 * (criterion 26, F23). The signature is libpdf's: its DER ends with the
 * signer's 256-byte RSA signature as an OCTET STRING (04 82 01 00). One nibble
 * in the middle of that value is flipped inside /Contents, which lies outside
 * the /ByteRange, so the CMS keeps its length and structure, the message
 * digest still matches the signed bytes, and only the signature over the
 * signed attributes is wrong. With `ownerOnly`, the file is owner-restricted
 * before the counterparty signs.
 */
export const buildCorruptedSignatureValuePdf = async (options: { ownerOnly?: OwnerOnlyAlgorithm } = {}) => {
  const signed = Buffer.from(
    options.ownerOnly ? await buildOwnerOnlyThenSignedPdf(options.ownerOnly) : await buildSignedPlainPdf(),
  );
  const { a, b, contentsHex } = readByteRange(signed);
  const derLength = derLengthOfContents(contentsHex);
  const der = Buffer.from(contentsHex, 'hex');

  if (der.subarray(derLength - 260, derLength - 256).toString('hex') !== '04820100') {
    throw new Error('fixture: the CMS does not end with a 256-byte signature value');
  }

  // Hex offset of a byte in the middle of the signature value, inside /Contents.
  const nibbleOffset = a + b + 1 + (derLength - 128) * 2;
  const nibble = String.fromCharCode(signed[nibbleOffset]);

  signed.write(nibble === 'A' ? 'B' : 'A', nibbleOffset, 'latin1');

  return signed;
};

/**
 * An owner-restricted PDF signed by the counterparty after protection (the
 * Acrobat case), with one signed byte then changed: the binary comment on the
 * file's second line, which encryption leaves in clear. pdfsig reports a
 * digest mismatch, so Sign must refuse it as broken on arrival rather than
 * skip the check because the file is encrypted.
 */
export const buildOwnerOnlyThenSignedThenTamperedPdf = async (algorithm: OwnerOnlyAlgorithm) => {
  const signed = Buffer.from(await buildOwnerOnlyThenSignedPdf(algorithm));
  const commentStart = signed.indexOf('\n%', 0, 'latin1') + 2;

  signed[commentStart] = signed[commentStart] === 0x58 ? 0x59 : 0x58;

  return signed;
};

/** pdfinfo's own report of the document, as key/value pairs (Form, Optimized, Pages, ...). */
export const readInfoWithPdfinfo = (bytes: Uint8Array) => {
  const file = writeTemp(bytes, 'pdfinfo-info.pdf');
  const { stdout } = spawnSync('pdfinfo', [file], { encoding: 'utf8' });

  return Object.fromEntries(
    stdout
      .split('\n')
      .map((line) => /^([^:]+):\s*(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => [match[1].trim(), match[2].trim()]),
  );
};

/** pdfsig's raw stdout, for failure messages and fixture preconditions. */
export const pdfsigReport = (bytes: Uint8Array) => {
  const file = writeTemp(bytes, 'pdfsig-report.pdf');

  return spawnSync('pdfsig', [file], { encoding: 'utf8' }).stdout;
};

// ---------------------------------------------------------------------------
// Independent verifiers
// ---------------------------------------------------------------------------

export type PdfSignature = {
  index: number;
  fieldName: string;
  signingTime: string;
  validation: string;
};

/**
 * Every signature poppler finds in the file, in the order it lists them, with
 * its own verdict. Only stdout is parsed: pdfsig writes NSS warnings to stderr
 * and its exit code is not a verdict.
 */
export const readSignaturesWithPdfsig = (bytes: Uint8Array): PdfSignature[] => {
  const file = writeTemp(bytes, 'pdfsig.pdf');
  const { stdout } = spawnSync('pdfsig', [file], { encoding: 'utf8' });

  const blocks = stdout.split(/^Signature #/m).slice(1);

  return blocks.map((block) => {
    const field = (label: string) => new RegExp(`- ${label}: (.*)$`, 'm').exec(block)?.[1]?.trim() ?? '';

    return {
      index: Number(block.split(':')[0]),
      fieldName: field('Signature Field Name'),
      signingTime: field('Signing Time'),
      validation: field('Signature Validation'),
    };
  });
};

export const SIGNATURE_VALID = 'Signature is Valid.';

export type PdfEncryption = {
  encrypted: boolean;
  /** Permission flags as poppler reports them, e.g. `change:no`, without the algorithm. */
  permissions: string[];
  /** Raw `Encrypted:` line, for failure messages. */
  raw: string;
};

/**
 * Whether poppler sees the file as encrypted, and with which permissions. A
 * file needing an open password makes pdfinfo fail, which is reported as
 * `openFails` rather than thrown, because one spec expects it.
 */
export const readEncryptionWithPdfinfo = (bytes: Uint8Array): PdfEncryption & { openFails: boolean } => {
  const file = writeTemp(bytes, 'pdfinfo.pdf');
  const result = spawnSync('pdfinfo', [file], { encoding: 'utf8' });

  const raw = /^Encrypted:\s*(.*)$/m.exec(result.stdout)?.[1]?.trim() ?? '';
  const flags = /\(([^)]*)\)/.exec(raw)?.[1] ?? '';

  return {
    openFails: result.status !== 0,
    encrypted: raw.startsWith('yes'),
    permissions: flags
      .split(/\s+/)
      .filter((flag) => flag && !flag.startsWith('algorithm:'))
      .sort(),
    raw,
  };
};

/**
 * Asserts a fixture's counterparty signature verifies before it reaches Sign,
 * and returns poppler's view of it for comparison afterwards.
 */
export const expectFixtureCounterpartySignatureValid = (bytes: Uint8Array) => {
  const signatures = readSignaturesWithPdfsig(bytes);

  expect(signatures, 'fixture precondition: exactly one counterparty signature').toHaveLength(1);
  expect(signatures[0].fieldName).toBe(COUNTERPARTY_FIELD_NAME);
  expect(signatures[0].validation, 'fixture precondition: pdfsig verifies the counterparty signature').toBe(
    SIGNATURE_VALID,
  );

  return signatures[0];
};

/**
 * Asserts the counterparty signature is still present in `bytes`, still the
 * same signature (field name and signing time), and that poppler verifies it.
 */
export const expectCounterpartySignatureStillValid = (bytes: Uint8Array, original: PdfSignature, context: string) => {
  const signatures = readSignaturesWithPdfsig(bytes);
  const counterparty = signatures.find((signature) => signature.fieldName === COUNTERPARTY_FIELD_NAME);

  expect(counterparty, `${context}: counterparty signature is present (pdfsig saw ${signatures.length})`).toBeTruthy();
  expect(counterparty?.signingTime, `${context}: it is the same signature`).toBe(original.signingTime);
  expect(counterparty?.validation, `${context}: pdfsig verifies the counterparty signature`).toBe(SIGNATURE_VALID);

  return signatures;
};

// ---------------------------------------------------------------------------
// Signing a pending envelope through the recipient's own endpoints
// ---------------------------------------------------------------------------

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
export const API_BASE_URL = `${WEBAPP_BASE_URL}/api/v2-beta`;

export const trpcMutation = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });

  expect(res.ok(), `${procedure} failed: ${await res.text()}`).toBeTruthy();
};

export const signAndCompleteAsRecipient = async ({
  request,
  recipientToken,
  documentId,
  fieldId,
}: {
  request: APIRequestContext;
  recipientToken: string;
  documentId: number;
  fieldId: number;
}) => {
  await trpcMutation(request, 'envelope.field.sign', {
    token: recipientToken,
    fieldId,
    fieldValue: { type: FieldType.SIGNATURE, value: 'Signature' },
  });

  await trpcMutation(request, 'recipient.completeDocumentWithToken', {
    token: recipientToken,
    documentId,
  });
};

/**
 * Signs a legacy V1 document as its recipient through the recipient signing
 * page, the route a real signer uses. `envelope.field.sign` accepts only V2
 * envelopes, and no V1 field-signing route appears in the public contracts or
 * the existing e2e specs, so this follows the page flow those specs use
 * (stepper-component.spec.ts): signature pad, field, Complete, Sign.
 */
export const signV1AsRecipientInBrowser = async ({
  page,
  recipientToken,
  fieldId,
}: {
  page: Page;
  recipientToken: string;
  fieldId: number;
}) => {
  await page.setViewportSize({ width: 1920, height: 1200 });

  const signUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipientToken}`;

  await page.goto(signUrl);
  await expect(page.getByRole('heading', { name: 'Sign Document' })).toBeVisible();

  await signSignaturePad(page);

  await page.locator(`#field-${fieldId}`).getByRole('button').click();
  await expect(page.locator(`#field-${fieldId}`)).toHaveAttribute('data-inserted', 'true');

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();
  await page.waitForURL(`${signUrl}/complete`);
  await expect(page.getByText('Document Signed')).toBeVisible();
};

export const downloadEnvelopeItem = async (
  request: APIRequestContext,
  apiToken: string,
  envelopeItemId: string,
  version: 'original' | 'signed' | 'pending',
) => {
  const res = await request.get(`${API_BASE_URL}/envelope/item/${envelopeItemId}/download?version=${version}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  expect(res.status(), `download ?version=${version} failed: ${res.status()}`).toBe(200);

  const body = await res.body();

  expect(body.subarray(0, 5).toString()).toBe('%PDF-');

  return new Uint8Array(body);
};
