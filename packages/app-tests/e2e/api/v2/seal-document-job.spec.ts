/**
 * The seal job, observed from outside.
 *
 * Written from the issue and the specification in the session scratchpad,
 * `specs/issue-38-seal-e2e.md`, before any of it ran. It replaces a unit test
 * that stubbed the PDF stack and counted calls.
 *
 * Nothing here calls the handler. Envelopes are seeded through the V2 API,
 * recipients sign and reject through their own endpoints, the job runs inside
 * the server as it does in production, and the outcome is read from the
 * database, a local webhook receiver and the sealed PDF read with poppler.
 *
 * | Test                                                           | Criterion |
 * | -------------------------------------------------------------- | --------- |
 * | a rejected envelope seals without printing SIGNATURE            | 1         |
 * | a retried seal job leaves the sealed document unchanged         | 2         |
 * | a retried seal job still tells the team                         | 3         |
 * | an administrator can reseal a finished envelope                 | 4         |
 * | the job refuses an envelope that is not SES                     | 5         |
 * | an envelope seals and notifies the team after its author leaves | 6         |
 *
 * Needs the server to allow 127.0.0.1 as a webhook target
 * (NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS=127.0.0.1), because the receiver is
 * a local HTTP server, and poppler-utils on PATH.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { sign as signJobRequest } from '@documenso/lib/server-only/crypto/sign';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, WebhookTriggerEvents } from '@prisma/client';

import { apiSeedPendingDocument } from '../../fixtures/api-seeds';
import { apiSignin } from '../../fixtures/authentication';
import {
  downloadEnvelopeItem,
  readSignaturesWithPdfsig,
  SIGNATURE_VALID,
  trpcMutation,
} from '../../fixtures/protected-pdfs';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const SEAL_JOB = 'internal.seal-document';

test.describe.configure({ mode: 'parallel' });

// ---------------------------------------------------------------------------
// Webhook receiver
// ---------------------------------------------------------------------------

type Delivery = { event: string; payload: Record<string, unknown> };

/** A local HTTP server standing in for the team's integration endpoint. */
const startReceiver = async () => {
  const deliveries: Delivery[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Delivery;

        deliveries.push({ event: body.event, payload: body.payload });
      } catch {
        // A body that is not JSON is not a delivery the tests look for.
      }

      res.writeHead(200).end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    count: (event: string) => deliveries.filter((delivery) => delivery.event === event).length,
    deliveries,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

type Receiver = Awaited<ReturnType<typeof startReceiver>>;

const registerWebhook = async (receiver: Receiver, userId: number, teamId: number) =>
  await prisma.webhook.create({
    data: {
      webhookUrl: receiver.url,
      eventTriggers: [WebhookTriggerEvents.DOCUMENT_REJECTED, WebhookTriggerEvents.DOCUMENT_COMPLETED],
      secret: 'seal-job-e2e',
      enabled: true,
      userId,
      teamId,
    },
  });

// ---------------------------------------------------------------------------
// Seeding and driving the envelope
// ---------------------------------------------------------------------------

type Context = Awaited<ReturnType<typeof seedUser>>;

/** Field boxes as percentages of the page, chosen to sit on blank paper below the document text. */
const FIELD_A = { positionX: 10, positionY: 68, width: 30, height: 8 };
const FIELD_B = { positionX: 10, positionY: 84, width: 30, height: 8 };

const seedTwoSignerEnvelope = async (
  request: APIRequestContext,
  context: { user: Context['user']; team: Context['team']; token: string },
) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    context,
    title: `Seal job ${stamp}`,
    recipients: [
      { email: `seal-a-${stamp}@test.documenso.com`, name: 'Signer A' },
      { email: `seal-b-${stamp}@test.documenso.com`, name: 'Signer B' },
    ],
    fieldsPerRecipient: [
      [{ type: FieldType.SIGNATURE, page: 1, ...FIELD_A }],
      [{ type: FieldType.SIGNATURE, page: 1, ...FIELD_B }],
    ],
  });

  // The response does not promise the order the recipients were created in.
  const byEmail = (email: string) => {
    const recipient = distributeResult.recipients.find((candidate) => candidate.email === email);

    if (!recipient) {
      throw new Error(`Recipient ${email} missing from the distribute response`);
    }

    return recipient;
  };

  const first = byEmail(`seal-a-${stamp}@test.documenso.com`);
  const second = byEmail(`seal-b-${stamp}@test.documenso.com`);
  const fieldOf = (recipientId: number) => {
    const field = envelope.fields.find((candidate) => candidate.recipientId === recipientId);

    if (!field) {
      throw new Error(`No field for recipient ${recipientId}`);
    }

    return field;
  };

  // Which box belongs to which signer is read back from the envelope, not assumed.
  const boxOf = (recipientId: number) => {
    const field = fieldOf(recipientId);

    return {
      positionX: Number(field.positionX),
      positionY: Number(field.positionY),
      width: Number(field.width),
      height: Number(field.height),
    };
  };

  return {
    envelope,
    token: context.token,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    itemId: envelope.envelopeItems[0].id,
    first,
    second,
    firstFieldId: fieldOf(first.id).id,
    firstBox: boxOf(first.id),
    secondBox: boxOf(second.id),
  };
};

type Seeded = Awaited<ReturnType<typeof seedTwoSignerEnvelope>>;

const apiContext = async (name: string): Promise<{ user: Context['user']; team: Context['team']; token: string }> => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: name, expiresIn: null });

  return { user, team, token };
};

const firstSignerSigns = async (request: APIRequestContext, seeded: Seeded) => {
  await trpcMutation(request, 'envelope.field.sign', {
    token: seeded.first.token,
    fieldId: seeded.firstFieldId,
    fieldValue: { type: FieldType.SIGNATURE, value: 'Alice Signer' },
  });

  await trpcMutation(request, 'recipient.completeDocumentWithToken', {
    token: seeded.first.token,
    documentId: seeded.documentId,
  });
};

const secondSignerRejects = async (request: APIRequestContext, seeded: Seeded) => {
  await trpcMutation(request, 'recipient.rejectDocumentWithToken', {
    token: seeded.second.token,
    documentId: seeded.documentId,
    reason: 'Terms are wrong',
  });
};

const waitForStatus = async (envelopeId: string, status: DocumentStatus) => {
  await expect(async () => {
    const current = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

    expect(current.status).toBe(status);
  }).toPass({ timeout: 60_000 });
};

const itemDocumentDataId = async (itemId: string) =>
  (await prisma.envelopeItem.findUniqueOrThrow({ where: { id: itemId } })).documentDataId;

const completionAuditRows = async (envelopeId: string) =>
  await prisma.documentAuditLog.count({ where: { envelopeId, type: 'DOCUMENT_COMPLETED' } });

/** Keep the sealed PDF with the run, so a failure can be looked at rather than guessed at. */
const attachPdf = async (name: string, bytes: Uint8Array) =>
  await test.info().attach(name, { body: Buffer.from(bytes), contentType: 'application/pdf' });

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// Reading the sealed PDF
// ---------------------------------------------------------------------------

const withTempPdf = <T>(bytes: Uint8Array, use: (file: string) => T): T => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-job-'));
  const file = path.join(dir, 'sealed.pdf');

  fs.writeFileSync(file, bytes);

  try {
    return use(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const firstPageText = (bytes: Uint8Array) =>
  withTempPdf(bytes, (file) => {
    const result = spawnSync('pdftotext', ['-f', '1', '-l', '1', '-layout', file, '-'], { encoding: 'utf8' });

    if (result.status !== 0) {
      throw new Error(`pdftotext failed: ${result.stderr}`);
    }

    return result.stdout;
  });

const PAGE_DPI = 72;

/**
 * Count the dark pixels in a box on page 1, given as percentages of the page.
 * pdftoppm renders to grey, and the PGM it writes is parsed here.
 */
const inkInBox = (bytes: Uint8Array, box: { positionX: number; positionY: number; width: number; height: number }) =>
  withTempPdf(bytes, (file) => {
    const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout;
    const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);

    if (!size) {
      throw new Error(`pdfinfo gave no page size: ${info}`);
    }

    const pageWidth = Math.round(Number(size[1]));
    const pageHeight = Math.round(Number(size[2]));
    const x = Math.round((box.positionX / 100) * pageWidth);
    const y = Math.round((box.positionY / 100) * pageHeight);
    const width = Math.round((box.width / 100) * pageWidth);
    const height = Math.round((box.height / 100) * pageHeight);

    const result = spawnSync(
      'pdftoppm',
      [
        '-f',
        '1',
        '-l',
        '1',
        '-r',
        String(PAGE_DPI),
        '-gray',
        '-x',
        String(x),
        '-y',
        String(y),
        '-W',
        String(width),
        '-H',
        String(height),
        file,
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );

    if (result.status !== 0) {
      throw new Error(`pdftoppm failed: ${result.stderr.toString()}`);
    }

    // P5 <width> <height> <maxval>\n then one byte per pixel.
    const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(result.stdout.subarray(0, 32).toString('latin1'));

    if (!header) {
      throw new Error('pdftoppm did not write a binary PGM');
    }

    const pixels = result.stdout.subarray(header[0].length);

    return pixels.filter((value) => value < 128).length;
  });

// ---------------------------------------------------------------------------
// Running the job through the server's own endpoint
// ---------------------------------------------------------------------------

/**
 * Deliver the seal job to the server as its queue does on a retry: a pending
 * background job row, then a signed POST to the job endpoint.
 */
const runSealJobAgain = async (documentId: number) => {
  const payload = { documentId };
  const options = { name: SEAL_JOB, payload };

  const job = await prisma.backgroundJob.create({
    data: { jobId: SEAL_JOB, name: 'Seal Document', version: '1.0.0', payload },
  });

  const res = await fetch(`${WEBAPP_BASE_URL}/api/jobs/${SEAL_JOB}/${job.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-job-id': job.id,
      'x-job-signature': signJobRequest(options),
      'x-job-retry': '1',
    },
    body: JSON.stringify(options),
  });

  return { job, status: res.status };
};

const sealJobsFor = async (documentId: number) =>
  await prisma.backgroundJob.findMany({
    where: { jobId: SEAL_JOB, payload: { path: ['documentId'], equals: documentId } },
    orderBy: { submittedAt: 'asc' },
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.beforeAll(() => {
  for (const tool of ['pdftotext', 'pdftoppm', 'pdfinfo']) {
    const found = spawnSync(tool, ['-v'], { encoding: 'utf8' });

    expect(found.error, `${tool} (poppler-utils) must be on PATH`).toBeUndefined();
  }
});

test('criterion_1_a_rejected_envelope_seals_without_printing_SIGNATURE_for_unfilled_fields', async ({ request }) => {
  test.setTimeout(120_000);

  const context = await apiContext('seal-job-1');
  const seeded = await seedTwoSignerEnvelope(request, context);

  await firstSignerSigns(request, seeded);
  await secondSignerRejects(request, seeded);
  await waitForStatus(seeded.envelope.id, DocumentStatus.REJECTED);

  const sealed = await downloadEnvelopeItem(request, seeded.token, seeded.itemId, 'signed');
  await attachPdf('sealed.pdf', sealed);

  const text = firstPageText(sealed);

  expect(text, `first page of the sealed PDF:\n${text}`).not.toContain('SIGNATURE');

  // The box under the signer who refused is blank paper. The box under the
  // signer who signed carries ink, so the check is not blank for every field.
  expect(inkInBox(sealed, seeded.secondBox), 'ink under the unfilled field').toBe(0);
  expect(inkInBox(sealed, seeded.firstBox), 'ink under the filled field').toBeGreaterThan(20);
});

test('criterion_2_a_retried_seal_job_leaves_the_sealed_document_unchanged', async ({ request }) => {
  test.setTimeout(120_000);

  const context = await apiContext('seal-job-2');
  const seeded = await seedTwoSignerEnvelope(request, context);

  await firstSignerSigns(request, seeded);
  await secondSignerRejects(request, seeded);
  await waitForStatus(seeded.envelope.id, DocumentStatus.REJECTED);

  const dataBefore = await itemDocumentDataId(seeded.itemId);
  const bytesBefore = await downloadEnvelopeItem(request, seeded.token, seeded.itemId, 'signed');
  const completedBefore = (await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelope.id } })).completedAt;

  expect(await completionAuditRows(seeded.envelope.id), 'one completion row after the first seal').toBe(1);

  const retry = await runSealJobAgain(seeded.documentId);

  expect(retry.status, 'the retried job answers OK').toBe(200);

  const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: retry.job.id } });

  expect(job.status).toBe('COMPLETED');

  expect(await itemDocumentDataId(seeded.itemId), 'same document data').toBe(dataBefore);
  expect(await completionAuditRows(seeded.envelope.id), 'still one completion row').toBe(1);
  expect(
    (await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelope.id } })).completedAt,
    'completedAt did not move',
  ).toEqual(completedBefore);

  const bytesAfter = await downloadEnvelopeItem(request, seeded.token, seeded.itemId, 'signed');

  expect(sha256(bytesAfter), 'byte-identical sealed PDF').toBe(sha256(bytesBefore));
});

test('criterion_3_a_retried_seal_job_still_tells_the_team', async ({ request }) => {
  test.setTimeout(120_000);

  const receiver = await startReceiver();

  try {
    const context = await apiContext('seal-job-3');

    await registerWebhook(receiver, context.user.id, context.team.id);

    const seeded = await seedTwoSignerEnvelope(request, context);

    await firstSignerSigns(request, seeded);
    await secondSignerRejects(request, seeded);
    await waitForStatus(seeded.envelope.id, DocumentStatus.REJECTED);

    await expect.poll(() => receiver.count('DOCUMENT_REJECTED'), { timeout: 30_000 }).toBe(1);

    const retry = await runSealJobAgain(seeded.documentId);

    expect(retry.status).toBe(200);

    // The envelope was already sealed, and the team is told anyway: the first
    // run may have died before the fan-out.
    await expect.poll(() => receiver.count('DOCUMENT_REJECTED'), { timeout: 30_000 }).toBe(2);
  } finally {
    await receiver.close();
  }
});

test('criterion_4_an_administrator_can_reseal_a_finished_envelope', async ({ page, request }) => {
  test.setTimeout(120_000);

  const context = await apiContext('seal-job-4');
  const { user: admin } = await seedUser({ isAdmin: true });
  const seeded = await seedTwoSignerEnvelope(request, context);

  await firstSignerSigns(request, seeded);
  await secondSignerRejects(request, seeded);
  await waitForStatus(seeded.envelope.id, DocumentStatus.REJECTED);

  const dataBefore = await itemDocumentDataId(seeded.itemId);
  const textBefore = firstPageText(await downloadEnvelopeItem(request, seeded.token, seeded.itemId, 'signed'));

  await apiSignin({ page, email: admin.email });

  const res = await page.request.post(`${WEBAPP_BASE_URL}/api/trpc/admin.document.reseal`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: { id: seeded.envelope.id } }),
  });

  expect(res.ok(), `admin.document.reseal failed: ${await res.text()}`).toBeTruthy();

  await expect.poll(async () => await itemDocumentDataId(seeded.itemId), { timeout: 60_000 }).not.toBe(dataBefore);
  await expect.poll(async () => await completionAuditRows(seeded.envelope.id), { timeout: 60_000 }).toBe(2);

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelope.id } })).status).toBe(
    DocumentStatus.REJECTED,
  );

  const resealed = await downloadEnvelopeItem(request, seeded.token, seeded.itemId, 'signed');

  await attachPdf('resealed.pdf', resealed);
  const signatures = readSignaturesWithPdfsig(resealed).filter((signature) => signature.validation !== '');

  expect(signatures.length, 'the resealed PDF carries a signature').toBeGreaterThanOrEqual(1);

  for (const signature of signatures) {
    expect(signature.validation, `pdfsig on signature #${signature.index}`).toBe(SIGNATURE_VALID);
  }

  // Resealing starts from the initial PDF, so nothing is stamped over itself.
  expect(firstPageText(resealed)).toBe(textBefore);
  expect(inkInBox(resealed, seeded.secondBox), 'ink under the unfilled field').toBe(0);
});

test('criterion_5_the_job_refuses_an_envelope_that_is_not_ses', async ({ request }) => {
  test.setTimeout(180_000);

  const receiver = await startReceiver();

  try {
    const context = await apiContext('seal-job-5');

    await registerWebhook(receiver, context.user.id, context.team.id);

    const seeded = await seedTwoSignerEnvelope(request, context);

    // Sending refuses anything but SES, so a pending QES envelope is one that
    // was sent before that rule.
    await prisma.envelope.update({ where: { id: seeded.envelope.id }, data: { signatureLevel: 'QES' } });

    const dataBefore = await itemDocumentDataId(seeded.itemId);

    await secondSignerRejects(request, seeded);

    await expect
      .poll(async () => (await sealJobsFor(seeded.documentId)).map((job) => job.status), { timeout: 120_000 })
      .toContain('FAILED');

    const jobs = await sealJobsFor(seeded.documentId);

    expect(
      jobs.every((job) => job.status !== 'COMPLETED'),
      `no seal job completed: ${JSON.stringify(jobs.map((job) => job.status))}`,
    ).toBe(true);

    const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelope.id } });

    expect(envelope.status, 'the envelope is not sealed').toBe(DocumentStatus.PENDING);
    expect(envelope.completedAt).toBeNull();
    expect(await itemDocumentDataId(seeded.itemId), 'the PDF is untouched').toBe(dataBefore);
    expect(await completionAuditRows(seeded.envelope.id), 'no completion row').toBe(0);
    expect(receiver.deliveries, 'nobody was told').toEqual([]);
  } finally {
    await receiver.close();
  }
});

test('criterion_6_an_envelope_seals_and_notifies_the_team_after_its_author_leaves', async ({ request }) => {
  test.setTimeout(120_000);

  const receiver = await startReceiver();

  try {
    const { owner, team } = await seedTeam();
    const author = await seedTeamMember({ teamId: team.id });
    const { token } = await createApiToken({
      userId: author.id,
      teamId: team.id,
      tokenName: 'seal-job-6',
      expiresIn: null,
    });

    await registerWebhook(receiver, owner.id, team.id);

    const seeded = await seedTwoSignerEnvelope(request, { user: author, team, token });

    expect(seeded.envelope.userId, 'the leaver is the author').toBe(author.id);

    await firstSignerSigns(request, seeded);

    // The author's access came through a group, and the group no longer has them.
    await prisma.organisationGroupMember.deleteMany({ where: { organisationMember: { userId: author.id } } });

    await secondSignerRejects(request, seeded);
    await waitForStatus(seeded.envelope.id, DocumentStatus.REJECTED);

    // The author's own token no longer reaches the team, so the owner reads it.
    const { token: ownerToken } = await createApiToken({
      userId: owner.id,
      teamId: team.id,
      tokenName: 'seal-job-6-owner',
      expiresIn: null,
    });
    const sealed = await downloadEnvelopeItem(request, ownerToken, seeded.itemId, 'signed');

    expect(firstPageText(sealed)).not.toContain('SIGNATURE');

    await expect.poll(() => receiver.count('DOCUMENT_REJECTED'), { timeout: 30_000 }).toBe(1);
  } finally {
    await receiver.close();
  }
});
