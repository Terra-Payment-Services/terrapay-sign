import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P12Signer, PDF } from '@libpdf/core';

/**
 * Counterparty-signed PDFs whose CMS needs more ASN.1 nodes than asn1js parses
 * by default, built at run time so no large binary is committed.
 *
 * Each file starts as `unsigned.pdf` signed by @libpdf/core with the committed
 * test certificate, as an adbe.pkcs7.detached signature. The CMS is then
 * enlarged in place, only in parts the signer's signature does not cover, and
 * written back into the same /Contents hole. The /ByteRange and the signed
 * attributes are untouched, so the signature still verifies; the specs check
 * that with poppler `pdfsig` rather than trusting this file.
 *
 * The enlargement is spliced as raw DER rather than re-encoded through pkijs,
 * because Sign reads the CMS with pkijs and asn1js and a fixture written by
 * the reader would hide any bug the two share.
 *
 * Requires `openssl` and, for the specs' independent check, `pdfsig`.
 */

const UNSIGNED_PDF = fs.readFileSync(path.join(__dirname, 'unsigned.pdf'));
const SIGNING_CERT_P12 = fs.readFileSync(path.join(__dirname, 'signing-cert.p12'));

/** Fixed so the signed attributes, and therefore the file, do not depend on the clock. */
const SIGNING_TIME = new Date('2026-10-01T09:00:00Z');

/**
 * Revoked entries in the counterparty CA's CRL for the large fixture. Each
 * entry is SEQUENCE { serial, revocationDate }, three nodes, so 4,500 entries
 * put the CMS at roughly 14,000 nodes and about 95 KB. That sits where the
 * reported signature did (between 10,000 and 20,000 nodes, 91,064 bytes), and
 * far enough above 10,000 that small changes elsewhere cannot carry it under.
 */
export const LARGE_CRL_ENTRIES = 4_500;

/**
 * NULLs in the unsigned attribute of the absurd fixture. A NULL is two bytes
 * and one node, so this is one megabyte of DER and just over 500,000 nodes.
 */
export const ABSURD_NULLS = 500_000;

/** A private-arc OID for the padding attribute: nothing assigns it meaning. */
const PADDING_ATTRIBUTE_OID = Buffer.from('060a2b0601040182ff7f0101', 'hex');

type Tlv = { tag: number; start: number; contentStart: number; end: number };

const readTlv = (der: Buffer, start: number): Tlv => {
  const tag = der[start];
  const first = der[start + 1];

  if (first < 0x80) {
    return { tag, start, contentStart: start + 2, end: start + 2 + first };
  }

  const lengthBytes = first & 0x7f;
  const length = der.subarray(start + 2, start + 2 + lengthBytes).reduce((total, byte) => total * 256 + byte, 0);

  return { tag, start, contentStart: start + 2 + lengthBytes, end: start + 2 + lengthBytes + length };
};

const childrenOf = (der: Buffer, parent: Tlv) => {
  const children: Tlv[] = [];

  for (let offset = parent.contentStart; offset < parent.end; ) {
    const child = readTlv(der, offset);

    children.push(child);
    offset = child.end;
  }

  return children;
};

const encodeLength = (length: number) => {
  if (length < 0x80) {
    return Buffer.from([length]);
  }

  const bytes: number[] = [];

  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);

const bytesOf = (der: Buffer, node: Tlv) => der.subarray(node.start, node.end);

const contentOf = (der: Buffer, node: Tlv) => der.subarray(node.contentStart, node.end);

/**
 * Rebuild ContentInfo { contentType, [0] SignedData } with SignedData's
 * children replaced by what `edit` returns.
 */
const editSignedData = (cms: Buffer, edit: (der: Buffer, children: Tlv[]) => Buffer[]) => {
  const contentInfo = readTlv(cms, 0);
  const [contentType, explicit] = childrenOf(cms, contentInfo);
  const signedData = childrenOf(cms, explicit)[0];
  const rebuilt = tlv(0x30, Buffer.concat(edit(cms, childrenOf(cms, signedData))));

  return tlv(0x30, Buffer.concat([bytesOf(cms, contentType), tlv(0xa0, rebuilt)]));
};

/**
 * Add revocation data to SignedData.crls ([1] RevocationInfoChoices), and
 * certificates to SignedData.certificates. Neither is covered by the
 * signature, and both are where a signing service puts the material a
 * long-term-validation signature carries.
 */
const addRevocationData = (cms: Buffer, certificates: Buffer[], crls: Buffer[]) =>
  editSignedData(cms, (der, children) => {
    const signerInfos = children[children.length - 1];
    const head = children.slice(0, -1);
    const existingCrls = head.find((child) => child.tag === 0xa1);

    if (existingCrls) {
      throw new Error('the signer already wrote a crls field; the splice assumes it did not');
    }

    const out = head.map((child) =>
      child.tag === 0xa0 ? tlv(0xa0, Buffer.concat([contentOf(der, child), ...certificates])) : bytesOf(der, child),
    );

    return [...out, tlv(0xa1, Buffer.concat(crls)), bytesOf(der, signerInfos)];
  });

/** Append an attribute to the first SignerInfo's unsignedAttrs ([1] IMPLICIT SET OF Attribute). */
const addUnsignedAttribute = (cms: Buffer, attribute: Buffer) =>
  editSignedData(cms, (der, children) => {
    const signerInfosNode = children[children.length - 1];
    const [first, ...others] = childrenOf(der, signerInfosNode);
    const fields = childrenOf(der, first);
    const last = fields[fields.length - 1];
    const signerInfo =
      last.tag === 0xa1
        ? tlv(
            0x30,
            Buffer.concat([
              ...fields.slice(0, -1).map((field) => bytesOf(der, field)),
              tlv(0xa1, Buffer.concat([contentOf(der, last), attribute])),
            ]),
          )
        : tlv(0x30, Buffer.concat([...fields.map((field) => bytesOf(der, field)), tlv(0xa1, attribute)]));

    return [
      ...children.slice(0, -1).map((child) => bytesOf(der, child)),
      tlv(0x31, Buffer.concat([signerInfo, ...others.map((other) => bytesOf(der, other))])),
    ];
  });

/** The /Contents hole the first /ByteRange leaves, as offsets of the hex digits between `<` and `>`. */
const contentsHole = (pdf: Buffer) => {
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.toString('latin1'));

  if (!match) {
    throw new Error('no /ByteRange');
  }

  const [a, b, c] = match.slice(1).map(Number);

  return { start: a + b + 1, end: c - 1 };
};

/** The CMS in the first signature's /Contents, cut at the length its DER header gives. */
export const signatureCms = (pdf: Buffer) => {
  const hole = contentsHole(pdf);
  const raw = Buffer.from(pdf.subarray(hole.start, hole.end).toString('latin1'), 'hex');

  return Buffer.from(raw.subarray(0, readTlv(raw, 0).end));
};

const replaceSignatureCms = (pdf: Buffer, cms: Buffer) => {
  const hole = contentsHole(pdf);
  const hex = cms.toString('hex').toUpperCase();
  const room = hole.end - hole.start;

  if (hex.length > room) {
    throw new Error(`the enlarged CMS needs ${hex.length} hex digits and the hole holds ${room}`);
  }

  const out = Buffer.from(pdf);

  out.write(hex.padEnd(room, '0'), hole.start, 'latin1');

  return out;
};

const signUnsigned = async (estimatedSize: number) => {
  const signer = await P12Signer.create(new Uint8Array(SIGNING_CERT_P12), '', { buildChain: false });
  const doc = await PDF.load(new Uint8Array(UNSIGNED_PDF));
  const { bytes } = await doc.sign({
    signer,
    fieldName: 'CounterpartySignature',
    reason: 'Counterparty approval',
    subFilter: 'adbe.pkcs7.detached',
    signingTime: SIGNING_TIME,
    estimatedSize,
  });

  return Buffer.from(bytes);
};

/**
 * A CA certificate and a CRL from it revoking `entries` serials, made by the
 * openssl CLI. The dates are fixed; only the generated CA key varies between
 * runs, which changes byte values but not the shape or the node count.
 */
const generateCaAndCrl = (entries: number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-signature-60-'));
  const file = (name: string) => path.join(dir, name);
  const index = Array.from({ length: entries }, (_, i) => {
    const serial = (0x100000 + i).toString(16).toUpperCase();

    return `R\t301231235959Z\t260101000000Z\t${serial}\tunknown\t/CN=Revoked ${i}`;
  });

  fs.writeFileSync(file('index.txt'), `${index.join('\n')}\n`);
  fs.writeFileSync(file('index.txt.attr'), 'unique_subject = no\n');
  fs.writeFileSync(file('crlnumber'), '1000\n');
  fs.writeFileSync(
    file('ca.cnf'),
    [
      '[ca]',
      'default_ca = counterparty',
      '[counterparty]',
      `database = ${file('index.txt')}`,
      `crlnumber = ${file('crlnumber')}`,
      `certificate = ${file('ca.pem')}`,
      `private_key = ${file('ca.key')}`,
      'default_md = sha256',
      'default_crl_days = 30',
      '',
    ].join('\n'),
  );

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file('ca.key'),
      '-out',
      file('ca.pem'),
      '-days',
      '3650',
      '-subj',
      '/O=Counterparty Trust Services/CN=Counterparty Issuing CA',
    ],
    { stdio: 'pipe' },
  );
  execFileSync(
    'openssl',
    [
      'ca',
      '-config',
      file('ca.cnf'),
      '-gencrl',
      '-crl_lastupdate',
      '20261001000000Z',
      '-crl_nextupdate',
      '20261101000000Z',
      '-out',
      file('ca.crl'),
    ],
    { stdio: 'pipe' },
  );
  execFileSync('openssl', ['x509', '-in', file('ca.pem'), '-outform', 'DER', '-out', file('ca.der')], {
    stdio: 'pipe',
  });
  execFileSync('openssl', ['crl', '-in', file('ca.crl'), '-outform', 'DER', '-out', file('crl.der')], {
    stdio: 'pipe',
  });

  const result = { certificate: fs.readFileSync(file('ca.der')), crl: fs.readFileSync(file('crl.der')) };

  fs.rmSync(dir, { recursive: true, force: true });

  return result;
};

/** Signed the same way with nothing added: a CMS of a few dozen nodes. */
export const buildSmallSignedPdf = async () => await signUnsigned(16_384);

/**
 * One intact signature whose CMS carries an extra CA certificate and a CRL
 * with LARGE_CRL_ENTRIES revoked serials, the shape of a PandaDoc, DocuSign or
 * Adobe LTV signature.
 */
export const buildLargeSignedPdf = async () => {
  const signed = await signUnsigned(160_000);
  const { certificate, crl } = generateCaAndCrl(LARGE_CRL_ENTRIES);

  return replaceSignatureCms(signed, addRevocationData(signatureCms(signed), [certificate], [crl]));
};

/**
 * One byte changed under the signature of a large-signature file: the first
 * byte of the binary comment on the second line, which every reader skips, so
 * the file still parses and only the digest disagrees.
 */
export const tamperCoveredByte = (pdf: Buffer) => {
  const out = Buffer.from(pdf);
  const commentStart = out.indexOf('\n%', 0, 'latin1') + 2;

  out[commentStart] = out[commentStart] === 0x58 ? 0x59 : 0x58;

  return out;
};

/**
 * One intact signature whose CMS needs over half a million nodes: ABSURD_NULLS
 * NULLs in an unsigned attribute, where timestamp tokens normally sit.
 */
export const buildAbsurdSignedPdf = async () => {
  const signed = await signUnsigned(1_100_000);
  const nulls = Buffer.alloc(ABSURD_NULLS * 2);

  for (let i = 0; i < ABSURD_NULLS; i++) {
    nulls[i * 2] = 0x05;
  }

  const attribute = tlv(0x30, Buffer.concat([PADDING_ATTRIBUTE_OID, tlv(0x31, tlv(0x30, nulls))]));

  return replaceSignatureCms(signed, addUnsignedAttribute(signatureCms(signed), attribute));
};
