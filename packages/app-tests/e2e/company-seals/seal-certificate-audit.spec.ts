/**
 * Audit trail and certificate for company seals.
 *
 * Written from the specification alone, before any implementation exists.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | the sealed PDF's certificate and audit pages name the seal        | 25       | F12           |
 * | the document's audit log page shows the same entry                | 25       | F12           |
 * | the audit row carries the sealId, names and a hash that matches   | 26       | F12           |
 * |   the stored PNG, and no image                                    |          |               |
 *
 * Expected on main (red run): every test fails creating the first seal.
 *
 * The certificate has two renderers. The default runs in the server process;
 * the other runs when the server is started with
 * NEXT_PRIVATE_USE_PLAYWRIGHT_PDF=true. This file is run once against each,
 * and nothing here depends on which one is active.
 *
 * pdftotext cannot be asked which page holds which section, so the
 * certificate checks read the text after the "Company seals" heading, and
 * the audit checks look for the sentence the spec gives.
 */
import { prisma } from '@documenso/prisma';
import { expect } from '@playwright/test';
import { DateTime } from 'luxon';

import {
  downloadVersion,
  flatPdfText,
  SEAL_FIELD_TYPE,
  setupMemberSeal,
  sha256Hex,
  signAndCompleteAll,
  snapshotOf,
  test,
} from '../fixtures/company-seals';

test.describe.configure({ mode: 'parallel', timeout: 240_000 });

type SealAuditData = {
  fieldId: string;
  field: { type: string; data: { sealId: string; sealName: string; legalEntityName: string; imageSha256: string } };
  fieldSecurity?: { type: string };
};

const sealAuditRow = async (envelopeId: string) => {
  const rows = await prisma.documentAuditLog.findMany({
    where: { envelopeId, type: 'DOCUMENT_FIELD_INSERTED' },
  });

  return rows.find((row) => (row.data as unknown as SealAuditData).field?.type === SEAL_FIELD_TYPE);
};

/** Sends and completes an envelope in an organisation that prints the certificate and the audit log. */
const completeWithCertificateAndAuditLog = async (
  signIn: Parameters<typeof setupMemberSeal>[0],
  request: Parameters<typeof setupMemberSeal>[1],
) => {
  const setup = await setupMemberSeal(signIn, request, {});

  await prisma.organisationGlobalSettings.update({
    where: { id: setup.world.organisation.organisationGlobalSettingsId },
    data: { includeSigningCertificate: true, includeAuditLog: true },
  });

  // The setting is read when the seal job runs, which is after the last signer completes.
  const member = await signIn(setup.world.member.email);

  await signAndCompleteAll(setup.built, { [setup.world.member.email]: member }, request);

  const sealed = await downloadVersion(request, setup.built.apiToken, setup.built.envelopeItemId, 'signed');

  return { ...setup, sealed };
};

test('criterion_25_the_sealed_pdf_certificate_and_audit_pages_name_the_seal_the_recipient_and_the_time', async ({
  signIn,
  request,
}) => {
  const { world, seal, person, built, sealed } = await completeWithCertificateAndAuditLog(signIn, request);
  const text = flatPdfText(sealed);
  const audit = await sealAuditRow(built.envelopeId);

  expect(audit, 'the application was audited').toBeTruthy();

  expect
    .soft(text, 'the audit page: "<name> applied the company seal of <legal entity> (<seal name>)"')
    .toContain(`applied the company seal of ${seal.legalEntityName} (${seal.name})`);

  const heading = text.search(/Company seals/i);

  expect(heading, 'the certificate has a "Company seals" entry').toBeGreaterThanOrEqual(0);

  const certificate = text.slice(heading);
  const applied = DateTime.fromJSDate((audit as { createdAt: Date }).createdAt);

  expect.soft(certificate, 'legal entity').toContain(seal.legalEntityName);
  expect.soft(certificate, 'seal name').toContain(seal.name);
  expect.soft(certificate, 'field ID').toContain(String(person.sealFieldId));
  expect.soft(certificate, 'time applied, date').toContain(applied.toFormat('yyyy-MM-dd'));
  expect.soft(certificate, 'time applied, time').toContain(applied.toFormat('hh:mm:ss'));
  expect.soft(text, "the recipient's email").toContain(world.member.email);
});

test('criterion_25_the_documents_audit_log_page_shows_the_same_entry', async ({ signIn, request }) => {
  const { world, seal, built } = await completeWithCertificateAndAuditLog(signIn, request);
  const owner = await signIn(world.owner.email);

  await owner.page.goto(`/t/${world.team.url}/documents/${built.envelopeId}/logs`);

  await expect(
    owner.page.getByText(`applied the company seal of ${seal.legalEntityName} (${seal.name})`),
    'the audit log page shows the entry',
  ).toBeVisible({ timeout: 30_000 });
});

test('criterion_26_the_audit_row_carries_the_seal_names_and_a_hash_that_matches_the_snapshot_and_no_image', async ({
  signIn,
  request,
}) => {
  const { world, seal, person, built } = await completeWithCertificateAndAuditLog(signIn, request);
  const row = await sealAuditRow(built.envelopeId);

  expect(row, 'the application was audited').toBeTruthy();

  const data = (row as { data: unknown }).data as SealAuditData;

  expect(data.field.data).toEqual({
    sealId: seal.id,
    sealName: seal.name,
    legalEntityName: seal.legalEntityName,
    imageSha256: seal.imageSha256,
  });
  expect(data.fieldSecurity?.type, 'the field was applied under ACCOUNT authentication').toBe('ACCOUNT');

  const signature = await prisma.signature.findFirst({ where: { fieldId: person.sealFieldId as number } });
  const snapshot = snapshotOf(signature);

  expect(snapshot, 'the Signature row holds the snapshot').toBeTruthy();
  expect(data.field.data.imageSha256, 'the hash is the SHA-256 of the PNG in the Signature row').toBe(
    sha256Hex(snapshot as Buffer),
  );

  const serialised = JSON.stringify(row);

  expect(serialised, 'no base64 image in the audit row').not.toContain('data:image');
  expect(serialised).not.toContain((snapshot as Buffer).toString('base64').slice(0, 200));
  expect(serialised.length, 'the row stays small').toBeLessThan(5_000);
  expect(world.organisation.id).toBe(seal.organisationId);
});
